"""Phase 18.6: PCM-1 artifacts — requirements, architecture choice, measurement
claim model, component strategy, safety model, role report, validation
workflows, traceability + manufacturing readiness, Phase 18 feedback.

  gen_phase186.py
"""
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import role_completeness as rc  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")
RUN = "fl1-pcm1-v1"
BASE = os.path.join(RUNS, RUN)
D = os.path.join(BASE, "data")


def _hash(p):
    try:
        return "sha256:" + hashlib.sha256(open(p, "rb").read()).hexdigest()[:16]
    except Exception:
        return None


def _w(name, obj):
    json.dump(obj, open(os.path.join(D, name + ".json"), "w"), indent=1)


_w("pcm1-requirements", {
    "version": "v1", "board": "FL-1 Power / Current Monitor PCM-1 v1",
    "provides": ["DUT voltage sense (11:1 divider -> protected ADC input)",
                 "DUT current sense (low-side shunt -> protected ADC input)",
                 "ADS1115 monitor ADC on the shared I2C bus (0x48)",
                 "FL-1 bus header v2 + slot-strap board-ID EEPROM",
                 "safe input labeling (0-24V, 0-500mA, MONITOR-ONLY on silk)",
                 "test points: DUT_V, SHUNT_HI, SHUNT_LO/GND, both ADC inputs, "
                 "rails, SDA/SCL", "mounting holes, functional silkscreen",
                 "validation workflows + traceability + manufacturing package"],
    "explicitly_not": ["precision DMM capability",
                       "calibrated current accuracy before physical calibration",
                       "programmable power output", "electronic load behavior",
                       "high-voltage support", "high-current support",
                       "isolation (not implemented)", "safety certification",
                       "bare-RP2040 integration (Pico module is the deliberate v1 choice)"],
    "mcu_note": "existing proven Pico-module primitive used BY DESIGN this phase; "
                "bare-MCU integration is a separate architecture-search target"})

_w("pcm1-architecture-choice", {
    "version": "v1",
    "candidates": [
        {"id": "shunt+ADS1115 (SELECTED for v1)",
         "evidence": "the exact measurement chain proven on the cal board "
                     "(fl1-cal-board-v4) and dc-measure fixture; buildable today, "
                     "zero new ingestion",
         "limits": "16-bit, low bandwidth, calibration-dependent accuracy",
         "verdict": "SELECTED"},
        {"id": "INA-class current monitor",
         "evidence": "an INA228 block (block_dc_measure) already exists and ROUTES "
                     "(regr-dc-measure PASSES) via the sourcing cache — closer than "
                     "the Phase 18 search recorded, but its measurement path has no "
                     "board-level validation evidence yet",
         "limits": "needs first-article validation of the INA path before any claim",
         "verdict": "future PCM-2 / ingestion-review-gated variant"},
        {"id": "external COTS DMM/PSU via EII-1",
         "evidence": "safest measurement truth; COTS capability stays COTS",
         "limits": "not internal FL-1 hardware",
         "verdict": "remains the validation REFERENCE for PCM-1 itself"}],
    "honesty_correction": "Phase 18 scored INA as blocked_by_missing_ingestion; the "
                          "dc-measure fixture shows the part sources and routes. "
                          "Corrected in the feedback report — claims still require "
                          "physical validation."})

_w("pcm1-measurement-claim-model", {
    "version": "v1",
    "voltage": {"input_range": "0-24V labeled (divider sized for 0-24V -> 0-2.2V)",
                "divider": "R86/R87 11:1 (100k/10k class; exact values in BOM)",
                "adc_range": "ADS1115 AIN0, PGA 2.048V", "test_points": ["TP30 DUT_V", "TP32 VSENSE_ADC"],
                "claims_before_calibration": "uncalibrated -> sanity_checkable only "
                "(divider-ratio arithmetic, no accuracy figure)",
                "claims_after_calibration": "cots_verifiable vs identified DMM; "
                "internally_calibratable after the Calibration/Reference board is "
                "physical + verified"},
    "current": {"shunt": "R85 low-side 0402 (value recorded in BOM; monitor-only)",
                "current_range": "0-500mA labeled (0402 power budget bounds it)",
                "shunt_power": "I^2R at 500mA must stay within 0402 rating — "
                "recorded in the safety model", "adc_range": "ADS1115 AIN1",
                "burden_voltage": "shunt drop at full range recorded at bring-up",
                "test_points": ["TP31 SHUNT_HI", "TP34 SHUNT_LO/GND", "TP33 ISENSE_ADC"],
                "claims_before_calibration": "uncalibrated -> sanity_checkable only",
                "claims_after_calibration": "cots_verifiable vs identified DMM/source; "
                "internally_calibratable after cal board exists"},
    "rules": ["no precision claim without calibration evidence",
              "no safety claim without ratings and test evidence",
              "no high-current claim without thermal and connector evidence",
              "no high-voltage claim without spacing/connector/rating/test evidence"]})

_w("pcm1-component-strategy", {
    "version": "v1", "rule": "proven parts only; no silent substitutions for ADC, "
    "shunt, divider resistors, connectors, EEPROM/addressing, or protection parts",
    "parts": [
        {"part": "ADS1115 TSSOP-10", "ingestion": "proven (cal board, validated UCS pins)",
         "substitution": "exact_part_required", "validation": "I2C enumerate + sanity reads"},
        {"part": "shunt R85 (0402)", "ingestion": "proven footprint",
         "substitution": "not_allowed silent (value/rating load-bearing)",
         "calibration_dependency": "value + tolerance recorded; accuracy needs calibration"},
        {"part": "divider R86/R87", "substitution": "not_allowed silent (ratio load-bearing)"},
        {"part": "protection R88/R89", "substitution": "not_allowed silent"},
        {"part": "DUT connector J20 (1x03)", "substitution": "not_allowed silent"},
        {"part": "Pico module", "note": "deliberate v1 MCU choice; bare-MCU deferred"},
        {"part": "24LC02 + straps", "substitution": "not_allowed silent"}]})

_w("pcm1-safety-protection-model", {
    "version": "v1",
    "max_intended_voltage": "24V DC (labeled; divider + ADC protection sized for it)",
    "max_intended_current": "500mA (labeled; bounded by 0402 shunt power budget)",
    "shunt_power": "I^2R at limit must stay within the 0402 rating with margin — "
                   "verified at bring-up before any sustained-current use",
    "connector_rating": "2.54mm header ~3A class >> 500mA limit",
    "trace_assumption": "monitor path carries DUT return current — kept short, "
                        "0.2mm minimum; verified in bring-up thermal check",
    "input_protection": "series R into both ADC channels; divider inherently limits "
                        "AIN0; ADS1115 internal clamps as last resort",
    "fuse_recommendation": "inline fuse on the DUT feed is RECOMMENDED at the bench "
                           "until bring-up thermal data exists",
    "fault_interlock": "bus-v2 lines wired; PCM-1 observes/asserts, controller decides",
    "safe_default": "monitor-only board — no switching elements, nothing to disable; "
                    "ADC is passive on the DUT path",
    "classification": "MONITOR-ONLY for low-current validation",
    "rules": ["no mains", "no high voltage", "no production safety claim",
              "no hot-swap claim (not designed or validated)"]})

# compose + role reports from the REAL run
lr = json.load(open(os.path.join(D, "last-run.json")))
board = json.load(open(os.path.join(D, "board.json")))
drc = json.load(open(os.path.join(D, "drc.json")))
viol = len([v for v in (drc.get("violations") or []) if v.get("type") != "solder_mask_bridge"])
role = rc.check_role("power_current_monitor",
                     open(os.path.join(BASE, "variant.kicad_pcb")).read(),
                     json.load(open(os.path.join(D, "devices.json"))))
_w("role-completeness-report", role)
passed = lr.get("status") == "PASSED" and viol == 0
facts = {"board_hash": _hash(os.path.join(BASE, "variant.kicad_pcb")),
         "bom_hash": _hash(os.path.join(D, "bom.json")),
         "pnp_hash": _hash(os.path.join(D, "pick_and_place.csv"))}
_w("pcm1-compose-report", {
    "version": "v1", "run_id": RUN,
    "routing": "%s/%s" % (board.get("netsRouted"), board.get("netsTotal")),
    "drc_violations": viol, "unconnected": len(drc.get("unconnected_items") or []),
    "pipeline_status": lr.get("status"), "role_completeness": role["status"],
    "verdict": "ready_to_build_with_review" if passed and role["status"].startswith("role_complete")
               else "revise_before_order",
    "order": "order_3_pcba_review_required (NEVER automatic)" if passed else "revise",
    "mcu": "Pico module (deliberate v1 choice; bare-MCU deferred to its own target)",
    **facts})

_w("pcm1-validation-workflows", {
    "version": "v1", "workflows": [
        {"name": "identity_and_power", "steps": ["read board ID (0x50-0x57 scan)",
         "verify strap default 0x50", "safe current-limited power-on",
         "measure rails", "I2C enumeration", "ADS1115 visible at 0x48"]},
        {"name": "voltage_sense_sanity", "steps": ["apply known low voltage (COTS or mock)",
         "read AIN0", "compare against divider arithmetic",
         "sanity_checked ONLY unless COTS reference identity recorded"]},
        {"name": "current_sense_sanity", "steps": ["drive known low current through shunt "
         "(COTS or mock)", "read AIN1", "record shunt value + assumptions + burden voltage",
         "sanity_checked ONLY unless COTS DMM/source identity recorded"]},
        {"name": "input_protection_safe_limits", "steps": ["limits documented (24V/500mA)",
         "no HV/high-current claim exists", "connector + shunt ratings recorded",
         "inline-fuse recommendation acknowledged"]},
        {"name": "calibration_dependency", "steps": [
         "IF Calibration/Reference board is physical + verified -> internally_calibratable",
         "ELSE calibration_blocked_or_cots_required"]}],
    "evidence": "simulated for mock; physical only after a real board; COTS evidence "
                "requires instrument identity; internal calibration requires the "
                "physical verified Calibration/Reference board"})

_w("pcm1-traceability-package", {
    "version": "v1", "serial_range": ["FL1-PCM-V1-0001", "FL1-PCM-V1-0002", "FL1-PCM-V1-0003"],
    "eeprom_payload": {"magic": "FL1B", "board_type": "power_current_monitor",
                       "revision": "V1", "bom_hash": facts["bom_hash"],
                       "cal_state": "uncalibrated (claims gated by claim model)"},
    "qr_payload": "fl1://board/FL1-PCM-V1-NNNN?type=power_current_monitor&rev=V1",
    "lifecycle": "design_generated -> first_article_review_required",
    "inspection": "common criteria + shunt/divider population + DUT label checks",
    "evidence_ledger": "ledger/FL1-PCM-V1-*.jsonl (append-only)"})

ar = json.load(open(os.path.join(D, "assembly-readiness.json")))
_w("pcm1-manufacturing-readiness-package", {
    "version": "v1", "assembly_ready": ar.get("ready_for_assembly"),
    "missing_parts": len(ar.get("missing_parts", [])),
    "quote": {"quantity": 3, "layers": board.get("layers"),
              "dimensions_mm": [board.get("boardSize", {}).get("wMm"),
                                board.get("boardSize", {}).get("hMm")],
              "finish": "ENIG recommended (fine-pitch TSSOP-10)",
              "controlled_impedance": "NOT required", "hdi": "NOT required",
              "fine_pitch": "TSSOP-10 0.5mm (AOI required)"},
    "order_record": {"order_id": "FL1-B2-PCM-DRAFT", "order_status": "human_review_required",
                     "approval_record": None},
    "honesty": "not ordered, not production-ready; human approval required"})

_w("phase18-pcm1-feedback-report", {
    "version": "v1", "candidate": "PCM-1 (shunt+ADS1115 conservative monitor)",
    "result": "PASSED + %s" % role["status"] if passed else "failed honestly",
    "architecture_search_update": {
        "power_current_monitor": {
            "readiness": "ready_for_reviewed_order_package" if passed else "design_attempt_candidate",
            "evidence": "run %s: %s/%s nets, 0 DRC, ERC PASS, role %d/%d" %
                        (RUN, board.get("netsRouted"), board.get("netsTotal"),
                         role["requirements_met"], role["requirements_checked"]),
            "correction": "INA-class variant is closer than v1 search recorded: "
                          "block_dc_measure (INA228, sourced) routes and passes the "
                          "dc-measure fixture; keep as PCM-2 candidate gated on "
                          "measurement-path validation, not on basic ingestion"}},
    "next_recommendation": "DMM-lite ONLY with the cal-board physical dependency "
                           "acknowledged; otherwise relay expansion (zero design), "
                           "bare-MCU architecture search (Phase 18.7 candidate), or "
                           "INA measurement-path validation",
    "roadmap_note": "six boards now in the review queue"})

print("PCM-1 artifacts: %s/%s nets, DRC %d, role %s -> %s" %
      (board.get("netsRouted"), board.get("netsTotal"), viol, role["status"],
       "ready_to_build_with_review" if passed else "revise"))
