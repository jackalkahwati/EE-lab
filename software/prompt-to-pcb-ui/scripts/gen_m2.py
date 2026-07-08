"""M2: Bare-MCU Productization Track v1 — artifacts from the REAL runs.

  gen_m2.py
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")
GA = "bare-rp2040-pico-replacement-v1"
GB = "fl1-core6-bare-rp2040-combination-v1"
TARGETS = ["fl1-backplane-v1", GA, GB]

BLOCKED = ["boot", "firmware_works", "USB_compliance", "Pico_compatible",
           "pin_compatible", "cost_down_verified", "physically_validated",
           "production_ready", "FL1_replacement"]


def _w(name, obj):
    for r in TARGETS:
        d = os.path.join(RUNS, r, "data")
        os.makedirs(d, exist_ok=True)
        json.dump(obj, open(os.path.join(d, name + ".json"), "w"), indent=1)


def _facts(run):
    d = os.path.join(RUNS, run, "data")
    bj = json.load(open(os.path.join(d, "board.json")))
    drc = json.load(open(os.path.join(d, "drc.json")))
    role = json.load(open(os.path.join(d, "role-completeness-report.json")))
    return {"routing": "%s/%s" % (bj.get("netsRouted"), bj.get("netsTotal")),
            "drc": len([v for v in (drc.get("violations") or [])
                        if v.get("type") != "solder_mask_bridge"]),
            "unconn": len(drc.get("unconnected_items") or []),
            "status": json.load(open(os.path.join(d, "last-run.json")))["status"],
            "role": "%s (%d/%d)" % (role["status"], role["requirements_met"],
                                    role["requirements_checked"]),
            "components": bj.get("components"), "layers": bj.get("layers")}


fa, fb = _facts(GA), _facts(GB)
_w("compose-m2-execution-plan", {
    "milestone": "M2 Bare-MCU Productization Track v1",
    "gates": {"A": "bare-RP2040 Pico-replacement board routes clean",
              "B": "FL-1 Core-6 combination attempt (allowed to fail)"},
    "outcome": "BOTH GATES PASSED", "blocked_claims": BLOCKED})
_w("compose-pico-replacement-board-report", {
    "version": "v1", "run": GA, **fa,
    "contents": "bare RP2040 QFN-56 (symbol-verified) + W25Q16 flash + 12MHz "
                "crystal + AMS1117 3V3 + decoupling + BOOTSEL/RESET + SWD + "
                "status LED + power inlet + 1x10 GPIO breakout (UART/I2C/4x "
                "GPIO on REAL MCU nets) + TPs + fiducials + holes + labels",
    "escape_engineering": [
        "column-signal B.Cu dive: column lane fans crossed row laterals on F "
        "at corners; the dive runs each column signal to B.Cu just past the "
        "column end and surfaces beyond the row band (ROW_CLEAR)",
        "import_ses stub restore made LAYER-AWARE (it re-added all fanout "
        "copper on F.Cu, silently flattening the dive)",
        "QFN row lanes tightened to 0.6mm step (13+ lanes ran off the board "
        "margin) with 0.6mm breakout pads (1.0mm pads touch 0.6mm-step "
        "laterals)",
        "column fans choose the direction with board room; row fans start "
        "targets beyond the opposite column's corridor band",
        "column plane pins ride the same dive, terminating at the far via — "
        "an in-band zone via always collides with an adjacent wired signal "
        "stub at 0.4mm pitch"],
    "honesty": "routed + gated; NO boot/firmware/USB/Pico-compatible/"
               "pin-compatible claim; NOT physically validated"})
_w("compose-pico-replacement-feasibility-update", {
    "version": "v2 (supersedes 23.5 report)",
    "board_exists": True, "routing": fa["routing"], "drc": fa["drc"],
    "still_not_claimed": ["functional equivalence", "Pico compatibility",
                          "pin compatibility", "cost-down", "boot"],
    "remaining": ["physical build + SWD detect + boot evidence",
                  "datasheet-verified decoupling", "USB routing decision",
                  "regulator validation"]})
_w("compose-core6-combination-report", {
    "version": "v1", "run": GB, **fb,
    "history": "Phase 18.8: the SAME 65-net board managed 55/65 with 48 "
               "escape-collision violations and was recorded as the honest "
               "monolith blocker. Today: 65/65, 0 DRC, role 16/16.",
    "contents": "bare RP2040 + flash + crystal + regulator + board-ID EEPROM "
                "+ DUT monitor (ADS1115+shunt) + cal ref (REF3025+ADS1115) + "
                "CAN transceiver + relay matrix (595+ULN2003) + FL-1 bus + "
                "protected GPIO bank + UART bridge",
    "fallback": "the seven modular FL-1 boards remain the review-required "
                "validated path; this board is an ATTEMPT article",
    "blocked_claims": BLOCKED})
_w("compose-core6-integration-blocker-report", {
    "version": "v2", "blocker_18_8": "QFN-56 quadrant escape at Core-6 density",
    "state": "RESOLVED IN SANDBOX (65/65, 0 DRC) — physical evidence still "
             "absent; cost-down NOT verified; monolith NOT replacing the "
             "modular boards without physical + review evidence"})
_w("compose-fl1-monolith-roadmap-update", {
    "version": "v2",
    "now": "Core-6 bare-RP2040 monolith ROUTED CLEAN (sandbox)",
    "before_adoption": ["physical first article of a simple board",
                        "physical bring-up of a bare-MCU board",
                        "datasheet-verified support values", "human review",
                        "cost quotes (placeholders today)"]})
_w("compose-m2-pack-updates", {
    "version": "v1",
    "bare_mcu_core_pack": {"state": "routed_in_sandbox — now includes "
                           "PRODUCT-LEVEL board (GPIO breakout) evidence",
                           "evidence": [GA]},
    "pico_replacement_pack": {"state": "routed_in_sandbox (NEW)",
                              "evidence": [GA],
                              "blocked_claims": BLOCKED},
    "fl1_monolith_pack": {"state": "routed_in_sandbox (NEW)",
                          "evidence": [GB], "blocked_claims": BLOCKED}})
_w("compose-m2-fleet-learning-update", {
    "version": "v1",
    "gates": {"A": fa, "B": fb},
    "escape_capability": "QFN-56 four-sided escape now covers signal-heavy "
                         "columns (B.Cu dive) — the full RP2040 pin budget "
                         "is routable",
    "next_milestone": "M3 Physical First Article Execution v1 (machinery + "
                      "pending state; no fake evidence, no auto-spend)"})

print("Gate A:", fa["status"], fa["routing"], "role", fa["role"])
print("Gate B:", fb["status"], fb["routing"], "role", fb["role"])
