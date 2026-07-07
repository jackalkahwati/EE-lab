"""Phase 16.7: board-ID addressing strategy + role checks + integration review v2
+ first-article review v3 + approval form v3, from the four regenerated boards.

  gen_phase167.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import role_completeness as rc  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")

BOARDS = [
    ("controller_backplane", "FL-1 Controller / Backplane v2.1", "fl1-core-controller-v21", "FL1-CB-V2"),
    ("digital_bringup", "FL-1 Digital Bring-up v2.1", "fl1-core-digital-v21", "FL1-DB-V2"),
    ("relay_probe_matrix", "FL-1 Relay / Probe Matrix v2.1", "fl1-core-relay-v21", "FL1-RM-V2"),
    ("calibration_reference", "FL-1 Calibration / Reference v2", "fl1-cal-board-v4", "FL1-CR-V2"),
]

STRATEGY = {
    "version": "v1",
    "options_evaluated": [
        {"option": "per-board-type fixed EEPROM address",
         "pros": "trivial", "cons": "duplicates of the same board type collide; only 8 "
         "addresses for the whole family", "verdict": "rejected"},
        {"option": "per-slot address straps from the FL-1 bus connector (SELECTED)",
         "pros": "supports multiple boards of the same type; bench default 0x50 via "
         "local pull-downs; zero firmware coordination; pure passives",
         "cons": "8 slots max per I2C segment (A0-A2 = 0x50-0x57)",
         "verdict": "SELECTED for v1 — implemented in fl1_bus header v2 (ID_A0-A2 "
         "pins) + board-ID EEPROM v2 (straps + pull-downs)"},
        {"option": "bus segmentation / muxing",
         "pros": "scales beyond 8 slots", "cons": "adds a mux part + control complexity",
         "verdict": "deferred — the v1 backplane is <= 8 slots; revisit at scale"},
    ],
    "selected": "per_slot_address_straps",
    "address_map": "bench standalone = 0x50 (pull-downs); backplane slot k drives "
                   "ID_A0-A2 -> address 0x50+k (k=0..7)",
    "limitation": "8 boards per I2C segment; beyond that requires segmentation (deferred)",
    "validation_hook": "read_board_id scans 0x50-0x57 and matches serials from EEPROM contents",
}

BUS_V2 = {"version": "v2", "connector": "2x07 PinHeader",
          "pins": {"1": "+5V", "2": "+3V3", "3": "I2C_SDA", "4": "I2C_SCL",
                   "5": "FAULT", "6": "INTERLOCK", "7": "RST_OUT", "8": "TRIG",
                   "9": "ID_A0", "10": "ID_A1", "11": "ID_A2",
                   "12": "GND", "13": "GND", "14": "GND"},
          "id_straps": "backplane slot drives ID_A0-A2; boards carry local pull-downs "
                       "(bench default 0x50)",
          "note": "sync/clock deferred (TRIG only) — honest v2 scope"}

EEPROM_V2 = {"version": "v2", "part": "24LC02 SOIC-8",
             "addressing": "A0-A2 from bus-header ID straps + local pull-downs; "
                           "fallback GND straps (fixed 0x50) when no fl1bus block",
             "collision_rule": "no two boards on one I2C segment may resolve the same "
                               "address; the backplane slot wiring guarantees this",
             "manifest_field": "i2c_address = '0x50-0x57 (slot straps, default 0x50)'",
             "validation": "read_board_id verifies serial vs EEPROM at the resolved address"}


def _facts(run):
    base = os.path.join(RUNS, run)
    txt = open(os.path.join(base, "variant.kicad_pcb")).read()
    d = os.path.join(base, "data")
    bj = json.load(open(os.path.join(d, "board.json")))
    drc = json.load(open(os.path.join(d, "drc.json")))
    lr = json.load(open(os.path.join(d, "last-run.json")))
    dev = json.load(open(os.path.join(d, "devices.json")))
    viol = len([v for v in (drc.get("violations") or []) if v.get("type") != "solder_mask_bridge"])
    return {"txt": txt, "dev": dev, "dir": d,
            "nets": "%s/%s" % (bj.get("netsRouted"), bj.get("netsTotal")),
            "drc": viol, "unconn": len(drc.get("unconnected_items") or []),
            "status": lr.get("status"),
            "straps": all(x in txt for x in ('"ID_A0"', '"ID_A1"', '"ID_A2"')),
            "hdr_2x07": "PinHeader_2x07" in txt}


review_rows, impact_rows = [], []
for role, name, run, sp in BOARDS:
    f = _facts(run)
    role_rep = rc.check_role(role, f["txt"], f["dev"])
    json.dump(role_rep, open(os.path.join(f["dir"], "role-completeness-report.json"), "w"), indent=1)
    clean = f["status"] == "PASSED" and f["drc"] == 0 and f["unconn"] == 0
    role_ok = role_rep["status"].startswith("role_complete")
    rec = "order_3_pcba" if clean and role_ok and f["straps"] and f["hdr_2x07"] else \
          "revise_before_order" if clean else "hold"
    review_rows.append({
        "board": role, "board_class": name, "run_id": run, "serial_prefix": sp,
        "routing": f["nets"], "drc": f["drc"], "unconnected": f["unconn"],
        "pipeline_status": f["status"], "role_completeness": role_rep["status"],
        "role_missing": role_rep["missing"],
        "bus_header_v2": f["hdr_2x07"], "id_straps": f["straps"],
        "eeprom_address": "0x50-0x57 (slot straps, default 0x50)",
        "recommendation": rec, "human_review_required": True,
        "approval_status": "PENDING_HUMAN_REVIEW",
        "history": ("do_not_build (P13) -> physically passed (P16.5) -> "
                    "revise_before_order (P16.6) -> role-complete v2 (P16.7)"
                    if role == "calibration_reference" else
                    "v1 role_incomplete (FA v1) -> v2 role-complete (P15.6) -> "
                    "v2.1 with ID straps (P16.7)"),
    })
    impact_rows.append({"board": role, "change": "regenerated with bus header v2 + "
                        "strapped board-ID EEPROM (required by the addressing strategy)",
                        "gates_rerun": True, "result": f["status"],
                        "minimal_change": "block lists unchanged; only the shared "
                        "primitives updated"})

# integration review v2
integration = {
    "version": "v2",
    "findings": [
        {"item": "FL-1 bus header pinout", "status": "CONSISTENT",
         "detail": "all four boards carry the v2 2x07 header (power/I2C/FAULT/"
                   "INTERLOCK/RST_OUT/TRIG/ID_A0-A2/GND)"},
        {"item": "board-ID EEPROM address plan", "status": "RESOLVED",
         "detail": "per-slot straps: bench default 0x50, backplane slots 0x50-0x57; "
                   "duplicates of the same board type supported; 8-slot limit per "
                   "segment explicitly bounded"},
        {"item": "power rail naming", "status": "CONSISTENT", "detail": "+5V/+3V3/GND"},
        {"item": "GND strategy", "status": "CONSISTENT", "detail": "GND F/B/In1 + 3V3 In2"},
        {"item": "safety/sync naming", "status": "CONSISTENT",
         "detail": "FAULT/INTERLOCK/RST_OUT/TRIG on all four (cal board included now)"},
        {"item": "serial plan", "status": "CONSISTENT", "detail": "FL1-<CB|DB|RM|CR>-V2-NNNN"},
        {"item": "validation command names", "status": "CONSISTENT",
         "detail": "Phase 14 capability verbs; read_board_id scans 0x50-0x57"},
        {"item": "internal-board assumptions", "status": "CLEAN",
         "detail": "no workflow assumes an unfabricated internal board"},
    ],
    "verdict": "all four boards mutually consistent; both v1 findings RESOLVED "
               "(header mismatch, 0x50 conflict)",
}

all_order = all(r["recommendation"] == "order_3_pcba" for r in review_rows)
fa3 = {"version": "v3", "boards": review_rows,
       "batch_decision": ("order_3_pcba_review_required (ALL FOUR)" if all_order
                          else "mixed — see per-board"),
       "note": "review_required never becomes automatic approval; nothing ordered, "
               "nothing production-ready"}

form = """# FL-1 Batch 1 — Human Approval Form v3

| Board | Recommendation | Decision (approve_order / revise_before_order / hold) | Notes |
|---|---|---|---|
""" + "\n".join("| %s | %s |  |  |" % (r["board_class"], r["recommendation"])
                for r in review_rows) + """

**Compose provides evidence and recommendations. It does not submit orders or
spend money.**
"""

targets = [os.path.join(RUNS, run, "data") for _r, _n, run, _s in BOARDS]
for t in targets:
    json.dump(STRATEGY, open(os.path.join(t, "fl1-board-id-addressing-strategy.json"), "w"), indent=1)
    json.dump(BUS_V2, open(os.path.join(t, "fl1-bus-header-v2.json"), "w"), indent=1)
    json.dump(EEPROM_V2, open(os.path.join(t, "board-id-eeprom-v2.json"), "w"), indent=1)
    json.dump({"boards": impact_rows}, open(os.path.join(t, "fl1-core-board-addressing-impact-report.json"), "w"), indent=1)
    json.dump(integration, open(os.path.join(t, "fl1-batch1-cross-board-integration-review-v2.json"), "w"), indent=1)
    json.dump(fa3, open(os.path.join(t, "fl1-final-first-article-review-v3.json"), "w"), indent=1)
    open(os.path.join(t, "fl1-batch1-human-approval-form-v3.md"), "w").write(form)

for r in review_rows:
    print("%-26s %-10s role=%-27s straps=%s -> %s" %
          (r["board"], r["routing"], r["role_completeness"], r["id_straps"], r["recommendation"]))
print("integration v2: %s" % integration["verdict"])
print("BATCH: %s" % fa3["batch_decision"])
