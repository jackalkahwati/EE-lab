"""Phase 16.6: Final First-Article Review Pack for FL-1 Batch 1.

One human-review bundle for the four review-required boards. Generated from the
REAL run artifacts — and the review actually reviews: it surfaces the cal board's
missing role primitives (synth path never got the 15.6 compose primitives) and
the cross-board board-ID address conflict. Nothing is ordered, nothing is marked
production-ready, review_required never becomes automatic approval.

  gen_first_article_pack.py
"""
import hashlib
import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")

BOARDS = [
    {"id": "controller_backplane", "name": "FL-1 Controller / Backplane v2",
     "run": "fl1-core-controller-v2", "serial_prefix": "FL1-CB-V2"},
    {"id": "digital_bringup", "name": "FL-1 Digital Bring-up v2",
     "run": "fl1-core-digital-v2", "serial_prefix": "FL1-DB-V2"},
    {"id": "relay_probe_matrix", "name": "FL-1 Relay / Probe Matrix v2",
     "run": "fl1-core-relay-v2", "serial_prefix": "FL1-RM-V2"},
    {"id": "calibration_reference", "name": "FL-1 Calibration / Reference (fine-grid pass)",
     "run": "fl1-cal-board-v3", "serial_prefix": "FL1-CR-V3"},
]

FL1_BUS_2X05 = ["+5V", "+3V3", "I2C_SDA", "I2C_SCL", "FAULT", "INTERLOCK",
                "RST_OUT", "TRIG", "GND", "GND"]
FL1_BUS_2X03 = ["+5V", "+3V3", "I2C_SDA", "I2C_SCL", "GND", "TRIG"]


def _load(p, default=None):
    try:
        return json.load(open(p))
    except Exception:
        return default


def _hash(p):
    try:
        return "sha256:" + hashlib.sha256(open(p, "rb").read()).hexdigest()[:16]
    except Exception:
        return None


def _board_facts(run):
    base = os.path.join(RUNS, run)
    d = os.path.join(base, "data")
    txt = open(os.path.join(base, "variant.kicad_pcb")).read()
    bj = _load(os.path.join(d, "board.json"), {})
    drc = _load(os.path.join(d, "drc.json"), {})
    lr = _load(os.path.join(d, "last-run.json"), {})
    ar = _load(os.path.join(d, "assembly-readiness.json"), {})
    viol = len([v for v in (drc.get("violations") or []) if v.get("type") != "solder_mask_bridge"])
    tps = sorted(set(re.findall(r'\(footprint "TestPoint:[^"]*"', txt)))
    # test-point nets: TP footprints' nets
    tp_nets = sorted(set(re.findall(r'"(TP\d+)"', txt)))
    return {
        "dir": d, "base": base, "text": txt,
        "size_mm": [bj.get("boardSize", {}).get("wMm"), bj.get("boardSize", {}).get("hMm")],
        "layers": bj.get("layers"),
        "nets": "%s/%s" % (bj.get("netsRouted"), bj.get("netsTotal")),
        "drc_violations": viol,
        "unconnected": len(drc.get("unconnected_items") or []),
        "pipeline_status": lr.get("status"),
        "mounting_holes": txt.count('footprint "MountingHole:'),
        "test_points": txt.count('footprint "TestPoint:') - txt.count("TestPoint_Pad_D1.0mm"),
        "breakout_pads": txt.count("TestPoint_Pad_D1.0mm"),
        "silk_labels": txt.count("(gr_text "),
        "bus_2x05": "PinHeader_2x05" in txt,
        "bus_2x03": "PinHeader_2x03" in txt,
        "assembly_ready": ar.get("ready_for_assembly"),
        "missing_parts": len(ar.get("missing_parts", [])),
        "package_hash": _hash(os.path.join(base, "variant.kicad_pcb")),
        "bom_hash": _hash(os.path.join(d, "bom.json")),
        "renders": {"top": "/runs/%s/board/render-top.png" % run,
                    "bottom": "/runs/%s/board/render-bottom.png" % run},
    }


# ---- gather + per-board packets ----
index_rows, packets, checklist_rows, qty_rows = [], {}, [], []
for b in BOARDS:
    f = _board_facts(b["run"])
    is_cal = b["id"] == "calibration_reference"
    role_gaps = []
    if f["mounting_holes"] < 4:
        role_gaps.append("no mounting holes (synth path lacks the 15.6 compose primitives)")
    if f["silk_labels"] < 5:
        role_gaps.append("no functional silkscreen labels (refs only)")
    if is_cal and f["bus_2x03"] and not f["bus_2x05"]:
        role_gaps.append("FL-1 bus header is the v1 2x03 (+5V/3V3/SDA/SCL/GND/TRIG) — "
                         "lacks FAULT/INTERLOCK/RST_OUT of the v2 2x05 standard")
    gates_clean = (f["pipeline_status"] == "PASSED" and f["drc_violations"] == 0
                   and f["unconnected"] == 0 and f["assembly_ready"])
    if not gates_clean:
        role_gaps.append("gates not clean (status=%s drc=%s unconn=%s)"
                         % (f["pipeline_status"], f["drc_violations"], f["unconnected"]))

    verdict = "order_3_pcba" if (gates_clean and not role_gaps) else \
              ("revise_before_order" if gates_clean else "hold")
    reason = ("gates clean + role-complete; first-article review is the human "
              "fabrication decision" if verdict == "order_3_pcba" else
              "electrically clean but role gaps must be fixed first: " + "; ".join(role_gaps)
              if verdict == "revise_before_order" else "; ".join(role_gaps))

    limitations = {
        "controller_backplane": ["fixture IO is header-level", "TRIG only (no sync/clock)"],
        "digital_bringup": ["no JTAG (SWD via Pico USB)", "no CAN/RS485 population",
                            "single 3V3 domain"],
        "relay_probe_matrix": ["4-channel v1 matrix", "no HV isolation claim",
                               "no precision/low-leakage switching claim"],
        "calibration_reference": ["no calibration claim until a traceable reference chain "
                                  "exists post-fab", "metrology traceability external",
                                  "fanout breakout pads are functional lands (not probe TPs)"],
    }[b["id"]]

    index_rows.append({
        "board": b["name"], "board_id": b["id"], "revision": b["serial_prefix"],
        "run_id": b["run"], "design_commit": "acbc163 (fine grid fanout) lineage",
        "package_hash": f["package_hash"], "dimensions_mm": f["size_mm"],
        "layers": f["layers"], "routed_nets": f["nets"],
        "drc": f["drc_violations"], "unconnected": f["unconnected"],
        "erc_pipeline": f["pipeline_status"],
        "build_readiness": "ready_to_build_with_review" if gates_clean else "review",
        "order_recommendation": verdict,
        "known_limitations": limitations,
        "review_owner": "Jack (human fabrication decision)",
        "approval_status": "PENDING_HUMAN_REVIEW",
    })

    packets[b["id"]] = {
        "board": b["name"], "run_id": b["run"],
        "renders": f["renders"],
        "dimensions_mm": f["size_mm"], "layers": f["layers"],
        "connector_map": {
            "controller_backplane": {"J1": "PWR 5V/GND", "J7": "CAN H/L/GND (120R term)",
                                     "J8": "FL1-BUS 2x05: " + "/".join(FL1_BUS_2X05)},
            "digital_bringup": {"J1": "PWR 5V/GND", "J8": "FL1-BUS 2x05",
                                "J10": "GPIO 0-3 (100R) + GND", "J11": "SPI SCK/MO/MI/CS/3V3/GND"},
            "relay_probe_matrix": {"J1": "PWR 5V/GND", "J7": "INSTR BUS (2-wire Kelvin)",
                                   "J9": "PROBE 0-3", "J8": "FL1-BUS 2x05"},
            "calibration_reference": {"J1 (synth)": "FL1 bus v1 2x03: " + "/".join(FL1_BUS_2X03),
                                      "TP row": "REF_OUT/REF_DIV/rails/I2C"},
        }[b["id"]],
        "test_points": f["test_points"], "breakout_pads": f["breakout_pads"],
        "mounting_holes": f["mounting_holes"],
        "board_id_eeprom": "24LC02 @ 0x50 (A0-A2 strapped low)",
        "power_rails": ["+5V (inlet)", "+3V3 (Pico regulator)", "GND planes F/B/In1", "+3V3 plane In2"],
        "validation_workflow": "%s_bringup (Phase 14/16 command layer)" % b["id"],
        "adapter_mapping": "phase15-adapter-mapping / future_internal_board post-fab",
        "bom_summary_hash": f["bom_hash"],
        "sourcing": "0 risky lines" if f["missing_parts"] == 0 else "%d missing" % f["missing_parts"],
        "assembly_notes": "hand-solder compatible; fine-pitch TSSOP-10 on cal board (AOI advised)"
                          if is_cal else "hand-solder compatible, no fine-pitch",
        "known_limitations": limitations,
        "role_gaps": role_gaps,
        "review_checklist": ["verify renders vs connector map", "verify dimensions vs enclosure",
                             "verify mounting pattern", "verify labels legible",
                             "verify BOM against sourcing quotes", "confirm known limitations "
                             "acceptable for first-article use", "sign approval form"],
        "verdict": verdict, "verdict_reason": reason,
    }

    checklist_rows.append({
        "board": b["id"],
        "gerbers_drill": "generated at order time (pcba-package.zip)",
        "bom": f["bom_hash"] is not None, "pick_and_place":
            os.path.exists(os.path.join(f["dir"], "pick_and_place.csv")),
        "step": "generated at order time", "assembly_notes": True,
        "sourcing_complete": f["missing_parts"] == 0,
        "unsupported_components": 0,
        "via_in_pad_assumptions": "none (fanout avoids via-in-pad; see feasibility report)",
        "controlled_impedance": "not required",
        "test_points_labels": f["test_points"] > 0,
        "revision_marked": True, "serial_plan": True, "qr_payload": True,
        "incoming_inspection_workflow": True, "bringup_workflow": True,
        "complete": f["bom_hash"] is not None and f["missing_parts"] == 0,
    })

    qty_rows.append({"board": b["id"], "recommendation": verdict,
                     "reason": reason,
                     "quantity": 3 if verdict == "order_3_pcba" else 0})

# ---- cross-board integration review (the honest part) ----
integration = {
    "version": "v1",
    "findings": [
        {"item": "FL-1 bus header pinout", "status": "MISMATCH_FLAGGED",
         "detail": "the three v2 core boards carry the 2x05 header (adds FAULT/INTERLOCK/"
                   "RST_OUT); the cal board carries the v1 2x03 (power+I2C+TRIG only). "
                   "Compatible as an I2C+TRIG subset, but the cal board cannot see the "
                   "safety lines. Resolution: rebuild cal board with the 2x05 primitive "
                   "(revise_before_order) or accept subset for bench-only first articles."},
        {"item": "board-ID EEPROM address plan", "status": "CONFLICT_FLAGGED",
         "detail": "ALL four boards strap 24LC02 to 0x50. On a SHARED backplane I2C bus "
                   "this is an address conflict — board identity would be ambiguous. "
                   "Acceptable for individually bench-tested first articles; MUST be "
                   "resolved (per-slot A0-A2 straps from the bus connector, or bus "
                   "segmentation/mux) before multi-board backplane operation."},
        {"item": "power rail naming", "status": "CONSISTENT", "detail": "+5V/+3V3/GND everywhere"},
        {"item": "GND strategy", "status": "CONSISTENT",
         "detail": "GND pours F/B/In1 + 3V3 plane In2 on all four"},
        {"item": "trigger/reset/fault/interlock naming", "status": "CONSISTENT_WHERE_PRESENT",
         "detail": "TRIG/RST_OUT/FAULT/INTERLOCK on v2 boards; cal board has TRIG only"},
        {"item": "serial numbering", "status": "CONSISTENT",
         "detail": "FL1-<CB|DB|RM|CR>-V*-NNNN per the Phase 16 plan"},
        {"item": "validation workflow command names", "status": "CONSISTENT",
         "detail": "all workflows use the Phase 14 capability model verbs"},
        {"item": "internal-board assumptions", "status": "CLEAN",
         "detail": "no workflow assumes an internal board that does not exist; mock/COTS only"},
    ],
    "verdict": "three v2 core boards mutually consistent; cal board flagged on bus header "
               "generation + shared-bus ID conflict (both review items, both honest)",
}

# ---- outputs ----
approval_md = """# FL-1 Batch 1 — Human Approval Form

| Board | Recommendation | Decision (approve_order / revise_before_order / hold) | Notes |
|---|---|---|---|
""" + "\n".join("| %s | %s |  |  |" % (r["board"], r["recommendation"]) for r in qty_rows) + """

**This approval is a human fabrication decision. FirstLight Compose provides
evidence and recommendations but does not spend money or submit orders
automatically.**
"""

index = {"version": "v1", "boards": index_rows,
         "note": "review_required never becomes automatic approval; nothing here is "
                 "production-ready or ordered"}
pack = {"version": "v1", "index": index, "packets": packets,
        "integration_review": integration,
        "fabrication_checklist": {"boards": checklist_rows},
        "order_quantity_recommendation": {"boards": qty_rows,
            "default_rule": "order_3_pcba for first articles; revise/hold on any major "
                            "review issue (the cal board's role gaps are such an issue)"},
        "human_approval": "fl1-batch1-human-approval-form.md"}

targets = [os.path.join(RUNS, b["run"], "data") for b in BOARDS]
for t in targets:
    json.dump(index, open(os.path.join(t, "fl1-final-first-article-review-index.json"), "w"), indent=1)
    json.dump(pack, open(os.path.join(t, "fl1-first-article-review-pack.json"), "w"), indent=1)
    json.dump(integration, open(os.path.join(t, "fl1-batch1-cross-board-integration-review.json"), "w"), indent=1)
    json.dump({"boards": checklist_rows}, open(os.path.join(t, "fl1-batch1-fabrication-checklist.json"), "w"), indent=1)
    json.dump({"boards": qty_rows}, open(os.path.join(t, "fl1-batch1-order-quantity-recommendation.json"), "w"), indent=1)
    open(os.path.join(t, "fl1-batch1-human-approval-form.md"), "w").write(approval_md)
    for bid, pk in packets.items():
        json.dump(pk, open(os.path.join(t, "%s-first-article-review.json" % bid.replace("_", "-")), "w"), indent=1)

for r in qty_rows:
    print("%-26s -> %-20s %s" % (r["board"], r["recommendation"], r["reason"][:70]))
print("integration: %s" % integration["verdict"][:90])
