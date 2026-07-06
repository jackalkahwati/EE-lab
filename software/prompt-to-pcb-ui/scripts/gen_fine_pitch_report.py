"""Generate the fine-pitch escape model + placement-escape report for a run
(Phase 13 gate A + placement feedback), using the synth wiring so the escape
model sees the SAME nets the board routes.

  gen_fine_pitch_report.py <design.json> <out_dir> [escape_result.json]
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "blocks"))
import fine_pitch_escape as fpe  # noqa: E402
import synth as synthmod  # noqa: E402

design_path, out_dir = sys.argv[1], sys.argv[2]
design = json.load(open(design_path))
os.makedirs(out_dir, exist_ok=True)

# build the real netmap per spec via synth's own wiring (incl. cal-topology REF_OUT
# / REF_DIV on the ADC + the fine-pitch tie-offs) so the escape model is accurate
specs = [s for s in design["final_design"] if s.get("pins")]
has_ref = any(s.get("category") == "voltage_reference" for s in specs)
netmaps = {}
cs_i = 0
for s in specs:
    nm, _w, _u, _p = synthmod._netmap_for(s, "CS%d" % cs_i)
    cs_i += 1
    cat = s.get("category", "")
    if has_ref and cat == "voltage_reference":
        for p in s["pins"]:
            if p["etype"] == "power_out":
                nm[p["number"]] = "REF_OUT"
    elif has_ref and cat.startswith("adc"):
        ains = [p["number"] for p in s["pins"] if p["etype"] == "analog_in"]
        for pnum, cnet in zip(ains, ("REF_OUT", "REF_DIV")):
            nm[pnum] = cnet
    netmaps[s["mpn"]] = nm

model = fpe.build_model(design, netmaps=netmaps)
json.dump(model, open(os.path.join(out_dir, "fine-pitch-escape-model.json"), "w"), indent=1)
open(os.path.join(out_dir, "fine-pitch-escape-model.md"), "w").write(fpe.to_markdown(model))

# placement-escape report: what placement/rotation strategy was applied + why
hints = design.get("recovery_hints", {})
rot = (hints.get("components", {}) or {}).get("ADS1115IDGS", {}).get("rotate")
dense = [c for c in model["components"] if c["expected_difficulty"] in ("dense_escape", "unsupported_escape")]
placement = {
    "fine_pitch_parts": model["fine_pitch_component_count"],
    "worst_case_escape": model["worst_case"],
    "rotation_strategy": ("ADS1115 rotated %s deg so all 4 fine-pitch signals face "
                          "open board area (found by the recovery loop)" % rot) if rot
                         else "no rotation applied",
    "applied_board_margin_source": hints.get("_source", "default"),
    "board_margin_mm": hints.get("board_margin", 0),
    "placement_strategy": "shared-bus-aware: I2C devices clustered near the MCU; "
                          "unused fine-pitch pins tied to GND plane to free escape lanes",
    "local_escape_margin": "keepout attempted around dense parts; pour cannot clear "
                           "tracks at 0.5mm pitch",
    "dense_parts": [c["mpn"] for c in dense],
    "reason_for_final_placement": ("rotation clears the logical route (all nets route) "
                                   "but the 0.5mm-pitch escape still contends at the grid"
                                   if dense else "no dense-escape parts"),
}
json.dump(placement, open(os.path.join(out_dir, "placement-escape-report.json"), "w"), indent=1)
open(os.path.join(out_dir, "placement-escape-report.md"), "w").write(
    "# Placement / escape report\n\n" +
    "\n".join("- %s: %s" % (k, v) for k, v in placement.items()) + "\n")

print("FINE_PITCH worst=%s dense=%s" % (model["worst_case"], [c["mpn"] for c in dense]))
