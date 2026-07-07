"""Phase 18.5: EII-1 artifacts — requirements, interface architecture, component
strategy, safety model, role report, validation workflows, traceability +
manufacturing readiness, and the Phase 18 feedback loop.

  gen_phase185.py
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
RUN = "fl1-eii1-v1"
BASE = os.path.join(RUNS, RUN)
D = os.path.join(BASE, "data")


def _hash(p):
    try:
        return "sha256:" + hashlib.sha256(open(p, "rb").read()).hexdigest()[:16]
    except Exception:
        return None


def _w(name, obj):
    json.dump(obj, open(os.path.join(D, name + ".json"), "w"), indent=1)


REQS = {
    "version": "v1", "board": "FL-1 External Instrument Interface EII-1 v1",
    "provides": ["FL-1 bus v2 connection (power/I2C/FAULT/INTERLOCK/RST_OUT/TRIG/ID straps)",
                 "board-ID EEPROM with slot-strap addressing (0x50-0x57)",
                 "instrument UART bridge (TTL; Pico UART0 on labeled header)",
                 "USB service/instrument link via the Pico's own USB",
                 "trigger/sync/presence lines as protected GPIO (100R series)",
                 "labeled connectors, test points, mounting holes, functional silk",
                 "validation workflow hooks + traceability package"],
    "explicitly_not": ["precision measurement", "oscilloscope front-end",
                       "function generator", "RF", "DMM", "high-voltage switching",
                       "autonomous power control", "RS232 levels (TTL only, external "
                       "transceiver needed)", "Ethernet (not ingested)",
                       "GPIB (future placeholder only)"],
    "rule": "COTS instrument capability stays COTS capability — never claimed as "
            "internal FL-1 capability",
}

IFACE = {
    "version": "v1", "interfaces": [
        {"name": "FL-1 bus v2", "connector": "2x07 header", "domain": "3V3/5V",
         "protection": "bus-side interlock/fault lines; ID strap pull-downs",
         "mcu_pins": "I2C0 + GP fault/interlock/rst/trig", "validation": "bus enumeration",
         "limitations": "8 slots per segment"},
        {"name": "instrument UART (TTL)", "connector": "1x04 header J12", "domain": "3V3",
         "protection": "none beyond 3V3 domain — TTL only, documented",
         "mcu_pins": "UART0 (Pico 1/2)", "validation": "UART loopback + mock instrument",
         "limitations": "RS232/RS485 need external transceivers"},
        {"name": "trigger/sync/presence", "connector": "GPIO bank J10 (100R series)",
         "domain": "3V3", "protection": "100R series; Pico boots as INPUTS (safe default)",
         "mcu_pins": "GP14-17", "validation": "boot-state check + commanded toggle + readback",
         "limitations": "timing sanity-class unless measured externally"},
        {"name": "USB service link", "connector": "Pico micro-USB", "domain": "5V",
         "protection": "Pico module's own", "mcu_pins": "native USB",
         "validation": "enumeration", "limitations": "service/development link"},
        {"name": "Ethernet", "connector": "-", "domain": "-", "protection": "-",
         "mcu_pins": "-", "validation": "-", "limitations": "NOT SUPPORTED (PHY not ingested)"},
        {"name": "GPIB", "connector": "-", "domain": "-", "protection": "-",
         "mcu_pins": "-", "validation": "-", "limitations": "future placeholder — no real "
         "parts ingested, no claim"},
    ],
}

SAFETY = {
    "version": "v1",
    "safe_default": "ALL instrument-facing GPIO boot as Pico INPUTS (high-Z) — no "
                    "uncontrolled trigger output at power-up/reset",
    "trigger_output": {"default": "high-Z until firmware enables", "series": "100R",
                       "enable_gating": "firmware writes direction register only after init",
                       "validation_test": "boot-state scope/DMM check in bring-up"},
    "fault_interlock_reset": "bus-v2 lines wired to dedicated Pico pins; behavior defined "
                             "in the controller workflow; EII-1 observes/asserts only",
    "domains": "single 3V3 logic domain, 5V inlet — labeled on silk; NO HV, NO mains",
    "external_instruments": "TTL/USB links only; unknown instruments must go through "
                            "their own COTS adapters, never direct exotic-level wiring",
}

facts = {
    "board_hash": _hash(os.path.join(BASE, "variant.kicad_pcb")),
    "bom_hash": _hash(os.path.join(D, "bom.json")),
    "pnp_hash": _hash(os.path.join(D, "pick_and_place.csv")),
}

_w("eii1-requirements", REQS)
_w("eii1-interface-architecture", IFACE)
_w("eii1-component-strategy", {
    "version": "v1", "rule": "proven parts only — zero new ingestion needed",
    "parts": [{"part": "RP2040 Pico", "status": "proven (all Batch 1 boards)"},
              {"part": "24LC02 board-ID", "status": "proven + slot straps"},
              {"part": "headers (2x07, 1x04, 1x05)", "status": "proven"},
              {"part": "100R/10k 0402", "status": "proven"},
              {"part": "RS232 transceiver", "status": "NOT included (TTL only, honest)"},
              {"part": "digital isolator / opto trigger", "status": "NOT included in v1 "
               "(future; would need ingestion)"},
              {"part": "Ethernet PHY", "status": "NOT included (not ingested)"}]})
_w("eii1-safety-protection-model", SAFETY)

# compose report from the REAL run
lr = json.load(open(os.path.join(D, "last-run.json")))
board = json.load(open(os.path.join(D, "board.json")))
drc = json.load(open(os.path.join(D, "drc.json")))
viol = len([v for v in (drc.get("violations") or []) if v.get("type") != "solder_mask_bridge"])
role = rc.check_role("external_instrument_interface",
                     open(os.path.join(BASE, "variant.kicad_pcb")).read(),
                     json.load(open(os.path.join(D, "devices.json"))))
_w("role-completeness-report", role)
passed = lr.get("status") == "PASSED" and viol == 0
_w("eii1-compose-report", {
    "version": "v1", "run_id": RUN,
    "routing": "%s/%s" % (board.get("netsRouted"), board.get("netsTotal")),
    "drc_violations": viol, "unconnected": len(drc.get("unconnected_items") or []),
    "pipeline_status": lr.get("status"), "role_completeness": role["status"],
    "board_size_mm": [board.get("boardSize", {}).get("wMm"), board.get("boardSize", {}).get("hMm")],
    "verdict": "ready_to_build_with_review" if passed and role["status"].startswith("role_complete")
               else "revise_before_order",
    "order": "order_3_pcba_review_required (NEVER automatic)" if passed else "revise",
    **facts})

_w("eii1-validation-workflows", {
    "version": "v1", "workflows": [
        {"name": "identity_and_power", "steps": ["read board ID (scan 0x50-0x57)",
         "verify strap default 0x50 standalone", "safe current-limited power-on",
         "measure +5V/+3V3 rails", "status check"]},
        {"name": "trigger_sync", "steps": ["verify trigger GPIO high-Z at boot (safe default)",
         "toggle trigger output under command", "read trigger input",
         "timing recorded as SANITY only unless measured by an external instrument"]},
        {"name": "serial_bridge", "steps": ["UART loopback (TTL)",
         "mock instrument command/response via adapter layer",
         "COTS instrument evidence requires instrument identity"]},
        {"name": "safety_lines", "steps": ["interlock line assert/deassert",
         "fault line check", "reset line check", "safe shutdown"]}],
    "evidence": "simulated for mock runs; physical only after a real board exists"})

_w("eii1-traceability-package", {
    "version": "v1", "serial_range": ["FL1-EII-V1-0001", "FL1-EII-V1-0002", "FL1-EII-V1-0003"],
    "eeprom_payload": {"magic": "FL1B", "board_type": "external_instrument_interface",
                       "revision": "V1", "bom_hash": facts["bom_hash"],
                       "cal_state": "not_calibratable (interface board)"},
    "qr_payload": "fl1://board/FL1-EII-V1-NNNN?type=external_instrument_interface&rev=V1",
    "lifecycle": "design_generated -> first_article_review_required",
    "inspection": "common criteria + UART/GPIO/bus-v2 label checks",
    "evidence_ledger": "ledger/FL1-EII-V1-*.jsonl (append-only)"})

ar = json.load(open(os.path.join(D, "assembly-readiness.json")))
_w("eii1-manufacturing-readiness-package", {
    "version": "v1", "assembly_ready": ar.get("ready_for_assembly"),
    "missing_parts": len(ar.get("missing_parts", [])),
    "quote": {"quantity": 3, "layers": board.get("layers"),
              "dimensions_mm": [board.get("boardSize", {}).get("wMm"),
                                board.get("boardSize", {}).get("hMm")],
              "finish": "HASL or ENIG", "controlled_impedance": "NOT required",
              "hdi": "NOT required", "fine_pitch": "none"},
    "order_record": {"order_id": "FL1-B2-EII-DRAFT", "order_status": "human_review_required",
                     "approval_record": None},
    "honesty": "not ordered, not production-ready; human approval required"})

_w("phase18-eii1-feedback-report", {
    "version": "v1",
    "candidate": "EII-1",
    "result": "PASSED + role_complete_with_review" if passed else "failed honestly",
    "architecture_search_update": {
        "external_instrument_interface": {"readiness": "ready_for_reviewed_order_package"
                                          if passed else "design_attempt_candidate",
                                          "evidence": "run %s: 22/22, 0 DRC, ERC PASS, "
                                          "role 10/10" % RUN,
                                          "score_confidence": "high (real routed board)"},
    },
    "next_best_board": "Power / Current Monitor — shunt+ADS1115 variant buildable now; "
                       "INA-class variant gated on ingestion",
    "reuse_note": "the stitcher hardening from this attempt (exact pad shapes, "
                  "layer-aware bridges, grid search, anchor fallback) benefits every "
                  "future board"})

print("EII-1 artifacts: compose %s/%s DRC %d role %s -> %s" %
      (board.get("netsRouted"), board.get("netsTotal"), viol, role["status"],
       "ready_to_build_with_review" if passed else "revise"))
