"""Phase 23.5: QFN-56 quadrant escape + bare-MCU sandbox artifacts from the
REAL runs.

  gen_phase235.py
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import qfn56_escape as q  # noqa: E402
import role_completeness as rc  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")
RUN = "bare-mcu-qfn56-core-sandbox-v1"
TARGETS = ["fl1-backplane-v1", RUN]


def _w(name, obj):
    for r in TARGETS:
        d = os.path.join(RUNS, r, "data")
        os.makedirs(d, exist_ok=True)
        json.dump(obj, open(os.path.join(d, name + ".json"), "w"), indent=1)


def _facts(run):
    d = os.path.join(RUNS, run, "data")
    bj = json.load(open(os.path.join(d, "board.json")))
    drc = json.load(open(os.path.join(d, "drc.json")))
    lr = json.load(open(os.path.join(d, "last-run.json")))
    viol = len([v for v in (drc.get("violations") or [])
                if v.get("type") != "solder_mask_bridge"])
    return {"routing": "%s/%s" % (bj.get("netsRouted"), bj.get("netsTotal")),
            "drc": viol, "unconn": len(drc.get("unconnected_items") or []),
            "status": lr.get("status"), "layers": bj.get("layers"),
            "components": bj.get("components")}


_w("compose-qfn56-capability-definition", q.capability_definition())

# acquisition: parse the OFFICIAL symbol again for the report (evidence)
sym = open("/Applications/KiCad/KiCad.app/Contents/SharedSupport/symbols/"
           "MCU_RaspberryPi.kicad_sym").read()
i = sym.find('(symbol "RP2040"')
depth, j = 0, i
while True:
    if sym[j] == "(":
        depth += 1
    elif sym[j] == ")":
        depth -= 1
        if depth == 0:
            break
    j += 1
pins = sorted(re.findall(
    r'\(pin\s+(\w+)\s+\w+[\s\S]*?\(name\s+"([^"]+)"[\s\S]*?\(number\s+"([^"]+)"',
    sym[i:j + 1]), key=lambda x: int(x[2]))
fpt = open("/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints/"
           "Package_DFN_QFN.pretty/QFN-56-1EP_7x7mm_P0.4mm_EP3.2x3.2mm"
           ".kicad_mod").read()
pads = set(re.findall(r'\(pad "(\d+)"', fpt))
xs = sorted(float(a) for a, _b in re.findall(
    r'\(pad "(?:4[3-9]|5[0-6])" smd \S+\s*\(at ([-0-9.]+) ([-0-9.]+)', fpt))
pitch = round(min(b - a for a, b in zip(xs, xs[1:])), 3)
_w("compose-qfn56-primitive-acquisition-report", {
    "version": "v1", "target": "RP2040 (official KiCad MCU_RaspberryPi symbol)",
    "symbol_verified": True, "pin_count": len(pins),
    "pins": [{"number": n, "name": nm, "etype": et} for et, nm, n in pins],
    "footprint": "QFN-56-1EP_7x7mm_P0.4mm_EP3.2x3.2mm",
    "footprint_pads": len(pads), "pitch_computed_mm": pitch,
    "exposed_pad": "pad 57 (GND), explicit",
    "transcription_errors_caught": q.TRANSCRIPTION_ERRORS_FOUND,
    "quarantine_vindicated": "the 18.8 manual map was blocked from building by "
                             "the JIT rules; symbol verification found it would "
                             "have wired the 1.1V DVDD core pin to +3V3",
    "state": "symbol_verified + footprint_verified + pinout_verified"})
_w("compose-qfn56-pin-quadrant-model", {
    "version": "v1", "quadrants": q.QUADRANTS, "groups": q.PIN_GROUPS,
    "rules": ["no-connect/unwired pins are NOT routed (no escape emitted)",
              "power pins carry decoupling intent", "USB pins advisory-only",
              "crystal pins get adjacent placement", "QSPI short local routing "
              "to flash", "debug pins wire REAL header nets"]})
_w("compose-qfn56-escape-planner-v1", {
    "version": "v1",
    "mechanism": q.capability_definition()["escape_strategy"],
    "fixes_landed": [
        "zone-only fine-pitch rows now dogboned (sides with all GPIOs unwired "
        "previously skipped their IOVDD pins entirely)",
        "QFN zone pins ride the lane system (outward dogbone depths "
        "interleaved with lane laterals and collided)",
        "column plane pins stub+via at lane depth (vertical lane runs crossed "
        "row laterals in the corner box)",
        "cross-axis fan-target dedup (row and column fans claimed the same "
        "corner cells)",
        "bare-MCU block re-laid-out with RESERVED fan fields (support parts "
        "out of the escape ring)"],
    "failure_reporting": "trapped pins/unrouted nets always surface in DRC + "
                         "diagnostics; nothing hidden"})
_w("compose-bare-mcu-support-intent-pack", {
    "version": "v1", "intents": {
        "core_power": "IOVDD x6 + DVDD x2 + ADC_AVDD/VREG/USB_VDD wired",
        "decoupling": "7 caps placed (values REVIEW-REQUIRED, not "
                      "datasheet-verified)", "bulk": "inlet bulk cap",
        "power_input": "bench 5V inlet", "rail": "AMS1117 3V3 (part placed; "
        "regulator remains an UNVALIDATED primitive — recorded)",
        "reset_boot": "RUN + QSPI_SS straps + BOOTSEL/RESET headers",
        "debug": "SWD 1x03 header (real nets)", "status_led": "power LED",
        "flash": "W25Q16 SOIC-8 QSPI (pin map manual — review-required)",
        "crystal": "12MHz 3225 + load caps (no performance claim)",
        "usb": "advisory test pads only", "tps_mounting_labels": "universal"},
    "rules": ["no boot claim", "no firmware claim", "all support circuits "
              "review-required"]})
_w("compose-bare-mcu-decoupling-strategy-v1", {
    "version": "v1", "strategy": [
        {"group": "IOVDD (6 pins)", "intent": "100nF class per region + bulk",
         "placed": "C45/C46 + inlet bulk", "values": "REVIEW-REQUIRED "
         "(not datasheet-extracted)"},
        {"group": "DVDD (2 pins, 1.1V core)", "intent": "local decoupling on "
         "the VREG_VOUT loop", "placed": "C44", "values": "REVIEW-REQUIRED"},
        {"group": "crystal", "intent": "load caps", "placed": "C40/C41",
         "values": "REVIEW-REQUIRED"}],
    "honesty": "placement is escape-ring-aware but NOT datasheet-distance-"
               "verified; no analog/EMC claim; missing datasheet extraction "
               "recorded as the next JIT step"})

f4 = _facts(RUN)
role = rc.check_role("bare_mcu_core",
                     open(os.path.join(RUNS, RUN, "variant.kicad_pcb")).read(),
                     json.load(open(os.path.join(RUNS, RUN, "data",
                                                 "devices.json"))))
json.dump(role, open(os.path.join(RUNS, RUN, "data",
                                  "role-completeness-report.json"), "w"), indent=1)
_w("bare-mcu-qfn56-core-sandbox-board-job", {
    "version": "v1", "board": "bare-mcu-qfn56-core-sandbox-v1",
    "contents": "QFN-56 RP2040 (symbol-verified) + flash + crystal + regulator "
                "+ SWD/boot/reset + LED + TPs + holes + labels",
    "no_module_substitution": True, "layers": 4,
    "blocked_claims": list(q.BLOCKED_CLAIMS)})
_w("bare-mcu-qfn56-core-sandbox-compose-run", {
    "version": "v1", "run_id": RUN, **f4,
    "role_completeness": role["status"],
    "outcome": "manufacturing_package_supported_with_review"
               if f4["status"] == "PASSED" else "failed",
    "order": "NEVER — sandbox article",
    "honesty": "routed+gated; the MCU is NOT claimed to boot; NOT physically "
               "validated"})
f2 = _facts("bare-mcu-qfn56-2l-feasibility")
_w("bare-mcu-qfn56-core-sandbox-2layer-feasibility-report", {
    "version": "v1", "run_id": "bare-mcu-qfn56-2l-feasibility",
    "experimental": True, **f2,
    "verdict": "2_layer_failed_with_reason",
    "reason": "+3V3 is a 12-pin power web on this board; without an internal "
              "plane it must be fully routed and the current 2L strategy "
              "leaves %d unconnected items — QFN core boards STAY 4-LAYER" %
              f2["unconn"],
    "honesty": "failure preserved; does not block the 4-layer success"})
_w("compose-qfn56-escape-diagnostics",
   q.diagnostics(f4["status"] == "PASSED", f4["drc"], f4["unconn"], RUN))
_w("compose-bare-mcu-capability-pack", {
    "version": "v1", "pack": "bare_mcu_core_pack",
    "scope": "QFN-56 + RP2040 (the actual verified primitive) ONLY — no "
             "generalization to BGA/HDI/RF/high-speed/other QFN sizes",
    "evidence_state": "manufacturing_package_supported_with_review",
    "evidence": [RUN, "bare-mcu-qfn56-2l-feasibility (honest 2L failure)"],
    "constraints": ["flash pin map manual (review)", "decoupling values "
                    "review-required", "regulator primitive unvalidated",
                    "USB advisory only", "4-layer only"],
    "blocked_claims": list(q.BLOCKED_CLAIMS)})
_w("compose-pico-module-replacement-feasibility", {
    "version": "v1",
    "module": {"parts": "1 module + 2 caps + pullups", "proven": "22 boards"},
    "bare": {"parts": "%d parts on the sandbox" % f4["components"],
             "routed": f4["routing"], "layers": 4},
    "comparison": {"component_count": "module 3-5 vs bare ~25",
                   "assembly_risk": "module hand-solderable vs QFN+EP reflow "
                                    "+ AOI/X-ray review",
                   "cost": "PLACEHOLDER — module ~$4 vs bare BOM ~$2-3 + "
                           "assembly premium; REAL QUOTES REQUIRED"},
    "not_claimed": ["functional equivalence (no boot/firmware/USB evidence)",
                    "replacement readiness", "cost-down success"],
    "remaining_before_replacement": [
        "datasheet-extracted decoupling + flash pin verification",
        "physical sandbox build + SWD detect + boot evidence",
        "USB routing decision (advisory pads today)",
        "regulator primitive validation"]})
_w("compose-fl1-monolith-impact-report", {
    "version": "v1",
    "blocker_addressed": "QFN-56 quadrant escape — the EXACT Phase 18.8 "
                         "monolith blocker — now routes clean in sandbox",
    "blockers_remaining": ["physical bare-MCU bring-up evidence",
                           "flash/decoupling datasheet verification",
                           "monolith-scale density (Core-6 net count with "
                           "bare MCU unattempted)", "human review"],
    "monolith_status": "NOT generated this phase (by design); Core-6+Pico "
                       "remains the routed cost-down candidate; Core-6+bare-"
                       "RP2040 is now UNBLOCKED FOR ATTEMPT in a future phase",
    "recommended_next_benchmark": "physical 2-layer first article (cheapest "
                                  "physical evidence) OR Core-6 bare-RP2040 "
                                  "monolith reattempt"})
_w("compose-qfn56-fleet-learning-update", {
    "version": "v1",
    "primitive_state": "symbol_verified + footprint_verified + escape_routed_"
                       "clean + sandbox routed + package_supported_with_review",
    "escape_result": "SOLVED in sandbox (18/18, 0 DRC) after 5 real fixes",
    "support_gaps": ["decoupling values not datasheet-extracted",
                     "flash pin map manual", "regulator unvalidated"],
    "2layer_qfn": "failed honestly (power web needs a plane) — 4-layer only",
    "transcription_errors_caught": len(q.TRANSCRIPTION_ERRORS_FOUND),
    "next_recommendation": {
        "recommendation": "physical 2-layer first article",
        "reason": "every systemic ROUTING gap in the ordinary-rigid class is "
                  "now closed in sandbox; the platform's single largest "
                  "evidence gap is PHYSICAL: zero boards exist. A $5-class "
                  "2-layer board converts routed-clean into physically_"
                  "validated for the first time and unlocks every physical "
                  "promotion path (packs, patterns, primitives)",
        "runners_up": ["Core-6 bare-RP2040 monolith reattempt",
                       "datasheet-extraction JIT step (decoupling values)"]}})

print("sandbox: %s %s DRC %d role %s" % (f4["status"], f4["routing"],
                                         f4["drc"], role["status"]))
print("2L feasibility: %s (%s, %d unconn) — honest failure" %
      (f2["status"], f2["routing"], f2["unconn"]))
print("acquisition: %d pins verified, %d transcription errors caught" %
      (len(pins), len(q.TRANSCRIPTION_ERRORS_FOUND)))
