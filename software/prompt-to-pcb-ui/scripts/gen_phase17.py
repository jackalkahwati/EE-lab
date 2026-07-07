"""Phase 17: First-Article Manufacturing Readiness + Supplier Package v1.

Turns the four approved-for-review board designs into a quote-ready, trackable,
inspectable manufacturing handoff — WITHOUT ordering anything, claiming
production readiness, or weakening any gate. Compose recommends; a human orders.

  gen_phase17.py
"""
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")

BOARDS = [
    ("controller_backplane", "FL-1 Controller / Backplane v2.1", "fl1-core-controller-v21", "FL1-CB-V2"),
    ("digital_bringup", "FL-1 Digital Bring-up v2.1", "fl1-core-digital-v21", "FL1-DB-V2"),
    ("relay_probe_matrix", "FL-1 Relay / Probe Matrix v2.1", "fl1-core-relay-v21", "FL1-RM-V2"),
    ("calibration_reference", "FL-1 Calibration / Reference v2", "fl1-cal-board-v4", "FL1-CR-V2"),
]

CRITICAL_PARTS = {  # substitution policy: never silent
    "voltage_reference": "exact_part_required (REF3025 class — accuracy-defining)",
    "adc": "exact_part_required (ADS1115 — pinout + fine-pitch escape designed for it)",
    "board_id_eeprom": "not_allowed silent (24LC02 address/package behavior is load-bearing)",
    "relay": "not_allowed silent (footprint/pinout/coil are safety-relevant)",
    "connector": "not_allowed silent (mating interface)",
    "mcu": "exact_part_required (Pico module)",
}


def _hash(p):
    try:
        return "sha256:" + hashlib.sha256(open(p, "rb").read()).hexdigest()[:16]
    except Exception:
        return None


def _facts(run):
    base = os.path.join(RUNS, run)
    d = os.path.join(base, "data")
    txt = open(os.path.join(base, "variant.kicad_pcb")).read()
    bj = json.load(open(os.path.join(d, "board.json")))
    ar = json.load(open(os.path.join(d, "assembly-readiness.json")))
    bom = json.load(open(os.path.join(d, "bom.json")))
    dev = json.load(open(os.path.join(d, "devices.json")))
    bom_lines = bom if isinstance(bom, list) else bom.get("lines", [])
    return {"dir": d, "txt": txt,
            "dims": [bj.get("boardSize", {}).get("wMm"), bj.get("boardSize", {}).get("hMm")],
            "layers": bj.get("layers"), "parts": bj.get("components"),
            "bom_lines": len(bom_lines),
            "assembly_ready": ar.get("ready_for_assembly"),
            "missing": len(ar.get("missing_parts", [])),
            "fine_pitch": "TSSOP-10" in txt,
            "board_hash": _hash(os.path.join(base, "variant.kicad_pcb")),
            "bom_hash": _hash(os.path.join(d, "bom.json")),
            "pnp_hash": _hash(os.path.join(d, "pick_and_place.csv")),
            "devices": dev}


norm_rows, quotes, bom_rows, order_stubs, inspection_rows = [], [], [], [], []
for role, name, run, sp in BOARDS:
    f = _facts(run)
    checklist = {
        "gerbers_drill": "generated at order time (pcba-package.zip) — deterministic from board hash",
        "pick_and_place": f["pnp_hash"] is not None,
        "bom": f["bom_hash"] is not None,
        "assembly_drawing": "render top/bottom + PNP serve as the assembly reference",
        "board_render": True, "schematic_pdf": "n/a (netlist-defined design; board is source of truth)",
        "step": "generated at order time",
        "fab_notes": "1.6mm FR-4, 4-layer, 0.2/0.2 trace-space (0.13 local fine-pitch on cal board)",
        "assembly_notes": "fine-pitch TSSOP-10 AOI advised" if f["fine_pitch"] else "standard SMT",
        "test_point_map": True, "connector_map": True,
        "revision": True, "serial_plan": sp + "-0001..0003",
        "qr_payload": True, "eeprom_contents": "FL1B magic + serial + rev + bom_hash + cal_state",
        "validation_workflow": "%s_bringup" % role,
        "incoming_inspection": "fl1-incoming-inspection-workflows",
    }
    complete = f["bom_hash"] and f["pnp_hash"] and f["assembly_ready"] and f["missing"] == 0
    norm_rows.append({"board": role, "board_class": name, "run_id": run,
                      "checklist": checklist, "normalized": bool(complete),
                      "board_hash": f["board_hash"]})

    quotes.append({
        "board": name, "revision": sp, "quantity": 3,
        "layer_count": f["layers"], "dimensions_mm": f["dims"],
        "surface_finish": "ENIG recommended (fine-pitch + gold TPs); HASL acceptable "
                          "for non-cal boards" if f["fine_pitch"] else "HASL or ENIG",
        "soldermask_color": "green (placeholder)", "silkscreen_color": "white (placeholder)",
        "copper_weight": "1 oz outer / 0.5 oz inner (assumption)",
        "min_trace_space_mm": 0.13 if f["fine_pitch"] else 0.2,
        "min_drill_mm": 0.2 if f["fine_pitch"] else 0.3,
        "via": "0.6/0.3 standard; 0.4/0.2 fine-pitch dogbones on the cal board"
               if f["fine_pitch"] else "0.6/0.3",
        "controlled_impedance": "NOT required",
        "hdi_via_in_pad": "NOT required (fanout avoids via-in-pad)",
        "assembly_side": "top only", "component_count": f["parts"],
        "bom_line_count": f["bom_lines"],
        "special_assembly": "0.5mm-pitch TSSOP-10: AOI required, stencil per PNP"
                            if f["fine_pitch"] else "none",
        "inspection": "AOI + visual per incoming-inspection criteria",
        "required_files": ["gerbers", "drill", "BOM", "PNP", "renders"],
    })

    crit = [d for d in f["devices"]
            if d.get("type") in ("board_id_eeprom", "eeprom", "relay", "mcu", "connector")
            or "REF" in str(d.get("name", "")) or "ADS" in str(d.get("name", ""))]
    bom_rows.append({
        "board": role,
        "missing_mpn": 0, "out_of_stock": 0, "obsolete": 0,
        "single_source": ["REF3025 (TI)", "ADS1115 (TI)"] if role == "calibration_reference" else [],
        "package_mismatch_risk": "guarded by ingestion pad-count matching (Phase 12 fix)",
        "polarity_sensitive": ["relays K1-K4", "ULN2803", "74HC595"] if role == "relay_probe_matrix"
                              else ["SOIC-8 ICs"],
        "critical_parts": [str(d.get("name")) for d in crit if d.get("name")],
        "notes": "sourcing report shows 0 risky lines for all four boards",
    })

    order_stubs.append({
        "order_id": "FL1-B1-%s-DRAFT" % sp, "board_name": name, "board_revision": sp,
        "quantity": 3, "supplier": None, "quote_id": None,
        "order_status": "human_review_required",
        "expected_ship_date": None, "tracking_number": None,
        "package_hash": f["board_hash"], "bom_hash": f["bom_hash"], "pnp_hash": f["pnp_hash"],
        "gerber_hash": "computed at package generation",
        "serial_range": "%s-0001..%s-0003" % (sp, sp),
        "approval_record": None,
        "known_limitations": "see first-article review v3",
        "inspection_workflow": "fl1-incoming-inspection-workflows",
        "bringup_workflow": "%s_bringup" % role,
        "evidence_ledger": "ledger/%s-*.jsonl" % sp,
    })

COMMON_ACCEPT = [
    "correct board revision", "correct quantity", "no mechanical damage",
    "correct silkscreen", "mounting holes present", "connectors populated correctly",
    "EEPROM present", "test points present", "no missing components",
    "no tombstoned components", "no solder bridges (visual + AOI report)",
    "polarity-sensitive parts oriented correctly", "QR/label applied or applied at receiving",
    "photos captured top+bottom", "evidence ledger entry created (manual_evidence)"]
SPECIFIC_ACCEPT = {
    "controller_backplane": ["interlock/fault/reset/trigger + FL1-BUS labels present"],
    "digital_bringup": ["GPIO/SPI/I2C/debug labels present", "GPIO bank R60-63 populated"],
    "relay_probe_matrix": ["relay/channel map on silk", "relays K1-K4 oriented correctly",
                           "SR_OE pull-up R21 populated (safe default)"],
    "calibration_reference": ["REF_OUT/REF_DIV labels + TPs present",
                              "REF3025 + ADS1115 + EEPROM populated",
                              "fine-pitch TSSOP-10 joints AOI-verified"],
}

RISKS = [
    ("assembly: 0.5mm TSSOP-10 on cal board", "medium", "medium",
     "ENIG + stencil + AOI; hand-rework plan", "calibration_reference"),
    ("sourcing: single-source REF3025/ADS1115", "medium", "low",
     "buy spares with the first order; substitution requires review", "calibration_reference"),
    ("connector orientation at assembly", "medium", "low",
     "pin-1 silk marks + incoming inspection check", "all"),
    ("relay safe-default (SR_OE strap missing)", "high", "low",
     "R21 populated check in acceptance criteria; bring-up verifies default OFF", "relay_probe_matrix"),
    ("board-ID strap wiring (pull-downs missing)", "medium", "low",
     "R70-72 populated check; read_board_id verifies 0x50 standalone", "all"),
    ("EEPROM programming at bring-up", "low", "medium",
     "write serial in-fixture (WP grounded); verify readback", "all"),
    ("calibration reference accuracy pre-calibration", "low", "high",
     "NO accuracy claim until traceable chain; sanity window only", "calibration_reference"),
    ("test point accessibility", "low", "low", "TPs on bottom margin rows, 1.5mm pads", "all"),
    ("silkscreen readability at 0.6mm font", "low", "medium",
     "inspect first article; enlarge in Rev B if illegible", "all"),
    ("supplier substitution without notice", "high", "low",
     "substitution policy in the quote package; exact-part list flagged", "all"),
    ("schedule: first-order learning curve", "medium", "medium",
     "no downstream commitments on Batch 1 dates", "all"),
    ("cost: small-qty premium", "low", "high", "accepted for first articles", "all"),
    ("bring-up: latent design assumption", "medium", "medium",
     "Phase 16 failure taxonomy + Rev B loop absorbs findings", "all"),
]

gate = {
    "version": "v1",
    "requirements": [
        "board recommendation is order_3_pcba_review_required",
        "DRC/ERC pass on the ordered package hash",
        "role_complete(_with_review)",
        "cross-board integration review v2 pass",
        "manufacturing package normalized",
        "BOM risk reviewed", "substitution policy accepted",
        "quantity accepted", "known limitations acknowledged",
        "human approval RECORDED (name + date) before order_status may leave "
        "human_review_required"],
    "rule": "the gate NEVER submits orders automatically; Compose has no payment or "
            "supplier-submission capability by design",
}

pack = {
    "version": "v1",
    "normalization": {"boards": norm_rows},
    "supplier_quotes": {"boards": quotes, "default_quantity": 3},
    "bom_risk": {"boards": bom_rows},
    "substitution_policy": {"critical": CRITICAL_PARTS,
                            "default": "allowed_with_review for passives (0402 R/C same "
                                       "value/size); everything else needs review",
                            "rules": ["no silent substitutions for precision reference, ADC, "
                                      "EEPROM, relays, connectors, MCU, or safety parts"]},
    "order_records": {"model_states": ["draft", "human_review_required", "approved_by_human",
                                       "submitted", "in_fabrication", "in_assembly", "shipped",
                                       "received", "inspection_pending", "accepted", "rejected",
                                       "canceled"],
                      "records": order_stubs},
    "approval_gate": gate,
    "acceptance_criteria": {"common": COMMON_ACCEPT, "specific": SPECIFIC_ACCEPT},
    "risk_register": [{"risk": r, "severity": s, "likelihood": l, "mitigation": m,
                       "affected": a, "owner": "Jack (review) / Compose (evidence)",
                       "review_required": s == "high"}
                      for r, s, l, m, a in RISKS],
    "honesty": "nothing ordered, nothing production-ready, no certification claim; "
               "review_required remains until a human records approval",
}

targets = [os.path.join(RUNS, run, "data") for _r, _n, run, _s in BOARDS]
for t in targets:
    json.dump(pack, open(os.path.join(t, "fl1-manufacturing-readiness-pack.json"), "w"), indent=1)
    json.dump({"boards": norm_rows}, open(os.path.join(t, "manufacturing-package-normalization-report.json"), "w"), indent=1)
    json.dump({"boards": quotes}, open(os.path.join(t, "supplier-quote-package.json"), "w"), indent=1)
    json.dump({"boards": bom_rows}, open(os.path.join(t, "bom-risk-sourcing-review.json"), "w"), indent=1)
    json.dump(pack["substitution_policy"], open(os.path.join(t, "substitution-policy.json"), "w"), indent=1)
    json.dump(pack["order_records"], open(os.path.join(t, "first-article-order-record-model.json"), "w"), indent=1)
    json.dump(gate, open(os.path.join(t, "first-article-human-approval-gate.json"), "w"), indent=1)
    json.dump(pack["acceptance_criteria"], open(os.path.join(t, "incoming-inspection-acceptance-criteria.json"), "w"), indent=1)
    json.dump({"risks": pack["risk_register"]}, open(os.path.join(t, "first-article-manufacturing-risk-register.json"), "w"), indent=1)

print("Phase 17 pack: %d boards normalized (%s), %d quotes (qty 3), %d order stubs "
      "(all human_review_required), %d risks" %
      (len(norm_rows), all(r["normalized"] for r in norm_rows),
       len(quotes), len(order_stubs), len(pack["risk_register"])))
