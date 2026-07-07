"""FL-1 board identity, serial plan, evidence ledger, failure taxonomy, Rev B
package model, and incoming inspection (Phase 16 A).

Prepares FirstLight for REAL boards arriving from fab: every board traceable
(identity + serial + hashes), every validation run evidence-backed (append-only
ledger), every failure classifiable, every redesign accountable to the Rev A
evidence it came from.

Hard rails: no fake traceability — hashes come from the real artifacts on disk;
simulated/mock evidence can never satisfy physical validation; failed evidence is
preserved, never overwritten; Rev B never hides Rev A.
"""
import hashlib
import json
import os

RUNS = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    "..", "..", "software", "prompt-to-pcb-ui", "public", "runs")

LIFECYCLE_STATES = ("design_generated", "first_article_review_required", "ordered",
                    "received", "inspection_pending", "validation_pending",
                    "validation_passed", "validation_failed", "calibrated",
                    "quarantined", "retired", "unknown")

EVIDENCE_TYPES = ("simulated", "mock", "cots_physical", "internal_physical",
                  "manual", "external_lab", "missing", "invalid")

FAILURE_CLASSES = (
    "design_intent_mismatch", "missing_component", "bad_symbol_or_footprint",
    "unrouted_net", "drc_violation", "erc_violation", "role_incomplete",
    "first_article_review_failure", "fine_pitch_escape_failure", "shared_bus_failure",
    "power_rail_failure", "current_limit_failure", "board_id_read_failure",
    "firmware_flash_failure", "debug_console_failure", "bus_test_failure",
    "gpio_failure", "interlock_failure", "fault_line_failure", "trigger_sync_failure",
    "relay_chatter", "relay_stuck", "relay_continuity_failure",
    "safe_disconnect_failure", "measurement_out_of_range", "calibration_failure",
    "manufacturing_defect", "assembly_defect", "component_substitution_issue",
    "external_instrument_error", "adapter_error", "operator_error", "unknown_failure")


def _hash_file(path):
    try:
        return "sha256:" + hashlib.sha256(open(path, "rb").read()).hexdigest()[:16]
    except Exception:
        return None


def _run_hashes(run_id):
    base = os.path.join(RUNS, run_id)
    d = os.path.join(base, "data")
    return {
        "generated_artifact_hash": _hash_file(os.path.join(base, "variant.kicad_pcb")),
        "kicad_project_hash": _hash_file(os.path.join(base, "variant.kicad_pcb")),
        "bom_hash": _hash_file(os.path.join(d, "bom.json")),
        "manufacturing_package_hash": _hash_file(os.path.join(d, "pick_and_place.csv")),
        "validation_package_hash": _hash_file(os.path.join(d, "fl1-validation.json")),
    }


def identity_model():
    return {
        "version": "v1",
        "fields": ["board_family", "board_type", "board_name", "board_revision",
                   "design_commit", "generated_artifact_hash", "kicad_project_hash",
                   "bom_hash", "manufacturing_package_hash", "validation_package_hash",
                   "serial_number", "lot_number", "board_id_eeprom_address",
                   "board_id_eeprom_fields", "qr_payload", "human_label",
                   "date_generated", "order_batch_id", "physical_received_date",
                   "current_lifecycle_state"],
        "lifecycle_states": list(LIFECYCLE_STATES),
        "rules": ["hashes are computed from the REAL artifacts on disk",
                  "lifecycle transitions are recorded in the evidence ledger",
                  "a board with no physical_received_date cannot pass 'received'"],
    }


BATCH1 = [
    {"code": "CB", "board_type": "controller_backplane", "run_id": "fl1-core-controller-v2",
     "board_name": "FL-1 Controller / Backplane v2",
     "limitations": ["fixture IO is header-level", "no sync/clock line (TRIG only)"]},
    {"code": "DB", "board_type": "digital_bringup", "run_id": "fl1-core-digital-v2",
     "board_name": "FL-1 Digital Bring-up v2",
     "limitations": ["no JTAG (SWD via Pico USB)", "no CAN/RS485 population",
                     "single 3V3 domain (no level shift)"]},
    {"code": "RM", "board_type": "relay_probe_matrix", "run_id": "fl1-core-relay-v2",
     "board_name": "FL-1 Relay / Probe Matrix v2",
     "limitations": ["4-channel v1 matrix", "no HV isolation claim",
                     "no precision/low-leakage switching claim"]},
]


def serial_plan(design_commit="", units=3, batch_id="FL1-BATCH1"):
    """Serial plan for the Batch 1 v2 boards. Identity STUBS: lifecycle starts at
    first_article_review_required — nothing is 'ordered'/'received' until it is."""
    plan = {"version": "v1", "batch_id": batch_id, "units_per_board": units, "serials": []}
    for b in BATCH1:
        hashes = _run_hashes(b["run_id"])
        for i in range(1, units + 1):
            sn = "FL1-%s-V2-%04d" % (b["code"], i)
            plan["serials"].append({
                "serial_number": sn,
                "board_family": "FL-1 Instrument Core",
                "board_type": b["board_type"],
                "board_name": b["board_name"],
                "board_revision": "V2/revA",
                "design_commit": design_commit or "see git log (role-completeness fixes)",
                **hashes,
                "lot_number": batch_id,
                "board_id_eeprom_address": "0x50",
                "board_id_eeprom_fields": {
                    "magic": "FL1B", "serial": sn, "board_type": b["board_type"],
                    "revision": "V2", "bom_hash": hashes["bom_hash"],
                    "cal_state": "uncalibrated"},
                "qr_payload": "fl1://board/%s?type=%s&rev=V2" % (sn, b["board_type"]),
                "human_label": "%s  S/N %s" % (b["board_name"], sn),
                "order_batch_id": batch_id,
                "physical_received_date": None,
                "current_lifecycle_state": "first_article_review_required",
                "validation_workflow": "%s_bringup" % b["board_type"],
                "calibration_workflow": "%s_verification" % b["board_type"],
                "evidence_ledger": "ledger/%s.jsonl (append-only)" % sn,
                "manufacturing_package": "/runs/%s (order pack v2)" % b["run_id"],
                "known_limitations": b["limitations"],
            })
    return plan


def ledger_model():
    return {
        "version": "v1",
        "entry_fields": ["evidence_id", "run_id", "board_serial", "board_type",
                         "board_revision", "workflow_id", "workflow_version",
                         "adapter_id", "adapter_type", "instrument_identity",
                         "calibration_state_before", "calibration_state_after",
                         "command_log_hash", "raw_evidence_hash", "result_summary",
                         "pass_fail_status", "warnings", "errors", "manual_steps",
                         "operator", "timestamp", "artifact_links",
                         "redesign_recommendation_id", "evidence_type"],
        "evidence_types": list(EVIDENCE_TYPES),
        "rules": ["simulated evidence cannot satisfy physical validation",
                  "mock evidence cannot satisfy physical validation",
                  "manual evidence must be marked manual",
                  "COTS evidence must include instrument identity",
                  "internal evidence must include board serial + calibration state",
                  "failed evidence remains attached to its redesign record",
                  "the ledger is APPEND-ONLY — entries are never overwritten"],
    }


def ledger_entry(run, serial, workflow_id, evidence_type, **kw):
    """Build one append-only ledger entry from a validation run result."""
    assert evidence_type in EVIDENCE_TYPES
    cmd_log = json.dumps(run.get("command_log", []), sort_keys=True)
    entry = {
        "evidence_id": "EV-%s-%s" % (serial, run.get("run_id", "run")),
        "run_id": run.get("run_id"), "board_serial": serial,
        "board_type": run.get("board_id"), "board_revision": "V2/revA",
        "workflow_id": workflow_id, "workflow_version": "v1",
        "adapter_id": (run.get("adapter_list") or ["?"])[0],
        "adapter_type": "mock" if evidence_type in ("simulated", "mock") else "unknown",
        "instrument_identity": kw.get("instrument_identity",
                                      "mock (no physical instrument)" if evidence_type
                                      in ("simulated", "mock") else None),
        "calibration_state_before": kw.get("cal_before", "uncalibrated"),
        "calibration_state_after": kw.get("cal_after",
                                          "mock_calibrated" if evidence_type in ("simulated", "mock")
                                          else "uncalibrated"),
        "command_log_hash": "sha256:" + hashlib.sha256(cmd_log.encode()).hexdigest()[:16],
        "raw_evidence_hash": "sha256:" + hashlib.sha256(
            json.dumps(run.get("measurement_records", []), sort_keys=True).encode()).hexdigest()[:16],
        "result_summary": run.get("final_verdict"),
        "pass_fail_status": run.get("final_verdict"),
        "warnings": run.get("warnings", []), "errors": run.get("errors", []),
        "manual_steps": kw.get("manual_steps", []), "operator": kw.get("operator"),
        "timestamp": kw.get("timestamp", "<stamped-at-run>"),
        "artifact_links": kw.get("artifact_links", []),
        "redesign_recommendation_id": kw.get("redesign_id"),
        "evidence_type": evidence_type,
        "satisfies_physical_validation": evidence_type in ("cots_physical", "internal_physical",
                                                           "external_lab"),
    }
    return entry


def failure_taxonomy():
    return {
        "version": "v1", "failure_classes": list(FAILURE_CLASSES),
        "record_fields": ["failure_id", "board_serial", "board_type", "workflow_step",
                          "affected", "evidence_links", "severity",
                          "root_cause_confidence", "suspected_cause",
                          "recommended_action", "redesign_candidate",
                          "compose_can_attempt_fix", "human_review_required"],
    }


def failure_record(fclass, serial, board_type, step, affected, **kw):
    assert fclass in FAILURE_CLASSES, fclass
    return {"failure_id": "F-%s-%s" % (serial, fclass), "failure_class": fclass,
            "board_serial": serial, "board_type": board_type, "workflow_step": step,
            "affected": affected, "evidence_links": kw.get("evidence_links", []),
            "severity": kw.get("severity", "major"),
            "root_cause_confidence": kw.get("confidence", "medium"),
            "suspected_cause": kw.get("cause", "unknown"),
            "recommended_action": kw.get("action", "investigate"),
            "redesign_candidate": kw.get("redesign_candidate", False),
            "compose_can_attempt_fix": kw.get("compose_fix", False),
            "human_review_required": kw.get("human_review", True)}


def revb_package_model():
    return {
        "version": "v1",
        "fields": ["original_board_name", "original_board_revision",
                   "original_design_commit", "original_manufacturing_package_hash",
                   "original_validation_package_hash", "original_first_article_review",
                   "original_evidence_records", "failure_summary",
                   "root_cause_hypothesis", "proposed_design_changes",
                   "unchanged_constraints", "changed_constraints", "bom_impact",
                   "manufacturing_impact", "validation_workflow_impact",
                   "calibration_impact", "risk_assessment", "expected_pass_criteria",
                   "human_approval_required", "new_revision_target"],
        "rules": ["Rev B is NEVER created automatically — explicit request + human approval",
                  "Rev A evidence (including failures) is preserved in the package",
                  "requirements are never silently relaxed — changed constraints are listed",
                  "simulated evidence never becomes physical evidence in the package"],
    }


# ---- incoming inspection workflows (Phase 6) --------------------------------
COMMON_INSPECTION = [
    "verify board revision matches the order pack", "verify serial label / QR",
    "inspect board dimensions", "inspect mounting holes", "inspect connector placement",
    "inspect test points", "inspect solder quality", "inspect component orientation",
    "inspect for missing components", "inspect board-ID EEPROM presence",
    "inspect FL-1 bus connector", "photograph top and bottom",
    "attach photos to the evidence ledger", "record operator notes",
    "mark inspection pass/fail (ledger entry, evidence_type=manual)"]

INSPECTION_SPECIFIC = {
    "controller_backplane": ["verify interlock/fault/reset/trigger connector labels",
                             "verify status LEDs", "verify debug/programming access"],
    "digital_bringup": ["verify SPI/I2C/UART/SWD/GPIO/protected-IO labels",
                        "verify protected GPIO bank populated (R60-R63)",
                        "verify debug access"],
    "relay_probe_matrix": ["verify relay orientation (K1-K4)",
                           "verify probe/channel connector labels (BUS, PROBE 0-3)",
                           "verify safe-default components populated (R21 SR_OE pull-up)",
                           "verify channel map on silkscreen"],
}


def inspection_workflows():
    return {"version": "v1", "workflows": [
        {"board_type": b["board_type"], "board_name": b["board_name"],
         "common_steps": COMMON_INSPECTION,
         "specific_steps": INSPECTION_SPECIFIC[b["board_type"]],
         "evidence": "manual_evidence ledger entry with photos; pass -> validation_pending, "
                     "fail -> quarantined + failure record"}
        for b in BATCH1]}
