"""Phase 23.6: first physical evidence loop artifacts.

  gen_phase236.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import physical_evidence as pv  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")
BOARD_RUN = "power-entry-header-2l"   # the 2-layer variant is the cheap target
FALLBACK_RUN = "power-entry-header-v1"
TARGETS = ["fl1-backplane-v1", BOARD_RUN]


def _w(name, obj):
    for r in TARGETS:
        d = os.path.join(RUNS, r, "data")
        os.makedirs(d, exist_ok=True)
        json.dump(obj, open(os.path.join(d, name + ".json"), "w"), indent=1)


_w("compose-physical-evidence-state-model", {
    "version": "v1", "states": list(pv.EVIDENCE_STATES),
    "human_gated": pv.HUMAN_GATED, "evidence_gated": pv.EVIDENCE_GATED,
    "rules": ["nothing past package_ready_with_review without human approval "
              "or real-world evidence", "failed validation preserves evidence",
              "physically_validated is NOT production_ready",
              "one physical pass does not imply yield or certification"]})

CANDIDATES = [
    ("power-entry-header (2L)", 1, 1, 1, 1, "none", "HIGH — validates "
     "synthesized structures + 2L flow + package generation", "multimeter + "
     "bench supply", "hours", False, False, False),
    ("connector breakout", 1, 1, 1, 1, "none", "medium — passive only",
     "multimeter", "hours", False, False, False),
    ("USB-C 5V power entry", 2, 2, 2, 2, "low", "high — USB-C primitive",
     "USB-C source + multimeter", "hours", False, False, False),
    ("BME280 sensor breakout", 2, 3, 3, 2, "low", "high — JIT sensor + LGA "
     "assembly", "I2C master + multimeter", "day", True, False, True),
    ("Environmental Sensor v2", 3, 3, 4, 3, "low", "high but needs firmware "
     "bring-up", "USB + host tooling", "days", True, False, True),
    ("bare-MCU QFN-56 sandbox", 4, 5, 5, 4, "low-med", "STRATEGIC but complex "
     "first target", "reflow + AOI/X-ray review + SWD probe", "days+", True,
     True, True),
]
_w("compose-first-physical-board-selection", {
    "version": "v1",
    "candidates": [{"board": b, "fab_cost_1to5": c, "assembly_1to5": a,
                    "test_complexity_1to5": t, "bringup_risk_1to5": r,
                    "safety_risk": s, "evidence_value": ev, "tools": tools,
                    "time_to_validate": tt, "firmware_required": fw,
                    "special_equipment": se, "fine_pitch_assembly": fp}
                   for b, c, a, t, r, s, ev, tools, tt, fw, se, fp in CANDIDATES],
    "recommendation": "power-entry-header (2-LAYER variant, run %s; 4-layer "
                      "fallback %s retained)" % (BOARD_RUN, FALLBACK_RUN),
    "why": "lowest fab cost + assembly + test complexity; zero firmware; no "
           "fine pitch; simple claim gates; one multimeter validates it — and "
           "a pass promotes the synthesized-structure generator, the 2-layer "
           "flow, and two capability packs in one article",
    "qfn_note": "STRATEGICALLY IMPORTANT but explicitly NOT the first physical "
                "target (reflow/EP/AOI complexity); attempt only after simpler "
                "boards pass",
    "second_target": "USB-C 5V power entry if the first article passes"})

# first article package: verify the REAL artifacts exist
d2 = os.path.join(RUNS, BOARD_RUN, "data")
have = {f: os.path.exists(os.path.join(d2, f)) for f in
        ("board.json", "bom.json", "pick_and_place.csv", "drc.json",
         "devices.json", "assembly-readiness.json")}
bj = json.load(open(os.path.join(d2, "board.json")))
_w("power-entry-header-v1-physical-first-article-package-report", {
    "version": "v1", "board_run": BOARD_RUN, "fallback_4l": FALLBACK_RUN,
    "purpose": "first physical evidence article: power inlet + LED + TPs + "
               "divider monitor, pure synthesis, 2-layer",
    "fabrication_class": "2-layer FR-4 1.6mm, lowest-cost class",
    "layers": bj.get("layers"), "dimensions_mm": [
        bj.get("boardSize", {}).get("wMm"), bj.get("boardSize", {}).get("hMm")],
    "artifacts_present": have,
    "gerbers": "generated deterministically at order time from the package "
               "hash (established Phase 17 mechanism)",
    "reports": "DRC/ERC/role/audit all in the run dir",
    "status_banner": "REVIEW-REQUIRED · NOT PHYSICALLY VALIDATED · NOT "
                     "PRODUCTION-READY · quote/order requires human approval",
    "package_complete_for_human_review": all(have.values())})

# human approval packet (md)
packet = """# First Physical Board — Human Approval Packet

**Board:** power-entry-header (2-layer variant, run `%s`)

**What is it?** A pure-synthesis power-entry board: 2-pin power inlet, power
LED, test points, voltage-divider monitor, mounting holes, labels. 4/4 nets,
0 DRC, ERC clean, 2 copper layers.

**Why this board first?** Cheapest possible physical evidence: no firmware,
no fine pitch, no special equipment. One multimeter and a current-limited
supply validate it.

**What a PASS proves (scoped):** the synthesized-structure generator emits
buildable copper; the automated 2-layer flow fabricates; the manufacturing
package survives contact with a real fab. Promotes: led_indicator,
testpoint_cluster, (conditionally) voltage_divider_monitor, power_entry_pack,
testpoint_inspection_pack — each scoped to what was tested.

**What it does NOT prove:** production readiness, yield, reliability,
certification, thermal, EMC, any other board, any QFN capability.

**Recommended posture:** QUOTE ONLY first. Lowest-cost 2-layer fab, minimum
quantity (3), bare PCB (hand assembly is plausible: 0402s + 0603 LED +
headers). No expedited options.

**Upload to fab:** gerbers + drill (generated from package hash at order
time). Assembly optional — bare PCB recommended.

**On arrival:** photos top/bottom -> visual inspection checklist ->
continuity -> power-off resistance -> current-limited power -> LED -> TP
voltages -> divider output. Upload every measurement WITH UNITS.

**Signature gates (nothing proceeds without them):**

- [ ] APPROVED FOR QUOTE          signed: ________  date: ________
- [ ] APPROVED FOR ORDER          signed: ________  date: ________

Compose prepares packages and ingests evidence. It does not submit quotes,
place orders, or spend money — ever.
""" % BOARD_RUN
for r in TARGETS:
    open(os.path.join(RUNS, r, "data",
                      "power-entry-header-v1-human-approval-packet.md"),
         "w").write(packet)
_w("power-entry-header-v1-order-approval-checklist", {
    "version": "v1", "gates": [
        {"gate": "APPROVED_FOR_QUOTE", "signed": None, "date": None},
        {"gate": "APPROVED_FOR_ORDER", "signed": None, "date": None}],
    "auto_submit": False, "auto_order": False,
    "note": "both gates are null until a human signs — Compose cannot fill them"})

_w("compose-quote-package-generator", {
    "version": "v1", "produces": ["gerbers zip ref", "drill ref", "BOM",
    "CPL if assembly", "board parameters", "quantity options", "assembly "
    "options", "fab notes", "disclaimers", "quote comparison placeholder",
    "human approval fields"],
    "rules": ["prices are PLACEHOLDERS until quotes ingested",
              "no quote request sent automatically",
              "no order placed automatically"]})
_w("power-entry-header-v1-quote-package", {
    "version": "v1", "board_run": BOARD_RUN,
    "board_parameters": {"layers": 2, "material": "FR-4 1.6mm",
                         "dimensions_mm": [bj.get("boardSize", {}).get("wMm"),
                                           bj.get("boardSize", {}).get("hMm")],
                         "min_trace_space": "0.2/0.2mm", "finish": "HASL ok"},
    "quantity_options": [3, 5, 10],
    "assembly_options": ["bare PCB (RECOMMENDED — hand assembly plausible)",
                         "PCB + stencil", "turnkey (BOM/CPL exist)",
                         "partial"],
    "price_table": {"all values": "PLACEHOLDER — no quotes ingested"},
    "fab_notes": "no controlled impedance; no special stackup; standard 2L",
    "disclaimers": ["REVIEW-REQUIRED", "NOT physically validated",
                    "NOT production-ready"],
    "human_approval": {"quote": None, "order": None},
    "submitted": False, "ordered": False})

STEPS = [
    ("package review", "human", "all reports read", "unclear artifact",
     "review sign-off"),
    ("fab file review", "human + gerber viewer", "gerbers match board",
     "mismatch", "review note"),
    ("order approval", "human signature", "gate signed", "unsigned",
     "signed checklist"),
    ("receipt logging", "camera", "boards + packing photos", "wrong boards",
     "photos + log entry"),
    ("visual inspection", "magnification/camera", "no defects, labels legible",
     "solder/fab defect", "checklist + photos"),
    ("continuity tests", "multimeter", "all TP nets continuous per netlist",
     "open", "readings (ohms)"),
    ("power-off resistance", "multimeter", "no rail short (>1k typical)",
     "short", "readings (ohms)"),
    ("controlled power", "current-limited supply", "current within expectation",
     "overcurrent", "V/I readings"),
    ("LED behavior", "eyes", "power LED lights", "dark LED", "photo + note"),
    ("testpoint voltages", "multimeter", "rails at TPs within tolerance",
     "off-rail", "readings (V)"),
    ("divider output", "multimeter", "VMON within review-defined tolerance",
     "out of tolerance", "reading (V) + computed ratio"),
    ("thermal touch/visual", "finger/IR optional", "nothing hot — NO thermal "
     "certification claim", "hot spot", "note"),
    ("evidence upload", "compose", "all artifacts ingested + attributable",
     "missing units/attribution", "ledger entries"),
    ("pass/fail adjudication", "human signature", "signed verdict",
     "unsigned", "signed adjudication"),
    ("promotion/demotion update", "compose gate", "scoped promotion or "
     "recorded failure", "gate refusal", "gate report"),
]
_w("power-entry-header-v1-physical-validation-workflow", {
    "version": "v1", "steps": [
        {"n": i + 1, "step": s, "tools": t, "expected": e, "failure": f,
         "evidence": ev, "approver": "human" if "human" in t or "signature"
         in t else "operator"}
        for i, (s, t, e, f, ev) in enumerate(STEPS)],
    "rules": ["no dangerous voltages", "no high-current tests",
              "no certification/production-test/calibration claims",
              "any failure blocks promotion and is captured for learning"]})

_w("compose-physical-evidence-ingestion-schema", {
    "version": "v1", "artifact_types": ["order_confirmation", "fab_quote",
    "fab_order_files", "received_photos", "closeup_photos",
    "visual_inspection_checklist", "continuity_readings", "voltage_readings",
    "current_readings", "testpoint_readings", "failure_photos", "rework_notes",
    "operator_notes", "adjudication", "signed_approval"],
    "required_fields": ["artifact_type", "board_id", "run_id", "datetime",
                        "operator", "file_or_ref", "measurement_value?",
                        "units (required with any measurement)", "pass_fail?",
                        "notes", "trust_level", "linked_step"],
    "rules": ["evidence must be attributable (validate_artifact enforces)",
              "measurements require units", "photos alone are not electrical "
              "validation", "order confirmation is not fabrication evidence",
              "received photos are not electrical validation",
              "promotion requires the full required evidence set"]})
_w("compose-physical-promotion-gate", {
    "version": "v1", "required": list(pv.REQUIRED_FOR_PHYSICAL),
    "implementation": "physical_evidence.promotion_gate (rejects simulated "
                      "evidence, photo-only electrical claims, unitless "
                      "measurements, missing adjudication)",
    "promotion_scope": pv.promotion_scope(),
    "rules": ["real evidence only", "scoped promotion only",
              "no production-ready promotion", "failures demote/constrain"]})
_w("compose-physical-evidence-ledger", {
    "version": "v1", "board_id": "power-entry-header-2l",
    "package_version": "phase 23.6",
    "human_approvals": [], "quote_status": "not_requested",
    "order_status": "not_ordered", "fabrication_status": "none",
    "receipt_status": "none", "inspection_status": "pending_hardware",
    "electrical_status": "pending_hardware", "promotion_status": "blocked_on_"
    "physical_evidence", "artifacts": [], "failures": [],
    "honesty": "ledger starts EMPTY — no fake evidence, no placeholder passes, "
               "no simulated physical results"})
_w("compose-readiness-ladder-physical-update", {
    "version": "v1", "ladder": list(pv.READINESS_LADDER),
    "current_position": "package_ready_with_review (awaiting APPROVED_FOR_QUOTE)",
    "rules": ["production_ready structurally forbidden without repeated "
              "validation + yield + process evidence + human approval",
              "pilot_ready_with_review requires physical validation + human "
              "approval", "physically_validated requires the promotion gate"]})
_w("compose-first-physical-evidence-fleet-learning-update", {
    "version": "v1", "selected": BOARD_RUN,
    "why": "lowest-risk, cheapest, tool-minimal; promotes 2 packs + 2-3 "
           "patterns + the 2L flow + the subcircuit generator in one article",
    "status": "package + approval packet + quote bundle prepared; awaiting "
              "the human APPROVED_FOR_QUOTE signature",
    "promotion_candidates": pv.promotion_scope(),
    "next_physical_after_first": ["USB-C 5V power entry", "BME280 breakout",
                                  "Environmental Sensor v2",
                                  "bare-MCU QFN-56 (ONLY after simpler boards "
                                  "pass)"],
    "platform_note": "every systemic sandbox capability now waits on the same "
                     "thing: one real board"})

print("selection: %s (QFN explicitly not-first)" % BOARD_RUN)
print("package complete for review:", all(have.values()))
print("ledger: EMPTY (no fake evidence); approvals: null until signed")
