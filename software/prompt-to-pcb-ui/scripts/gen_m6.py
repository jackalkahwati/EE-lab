"""M6: multi-rail + mixed-signal chip synthesis — real dual-rail runs."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import chipdown_synthesis as cd  # noqa: E402
import multirail  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")


def _facts(run):
    d = os.path.join(RUNS, run, "data")
    bj = json.load(open(os.path.join(d, "board.json")))
    drc = json.load(open(os.path.join(d, "drc.json")))
    return {"routing": "%s/%s" % (bj.get("netsRouted"), bj.get("netsTotal")),
            "drc": len([v for v in (drc.get("violations") or [])
                        if v.get("type") != "solder_mask_bridge"]),
            "status": json.load(open(os.path.join(d, "last-run.json")))["status"]}


txb = cd.synthesize_chipdown("Logic_LevelTranslator", "TXB0102DCU",
                             "Package_TO_SOT_SMD", "SOT-23-8", "U40",
                             rails={"overrides": {"VCCB": "+5V"}})
ds = cd.synthesize_chipdown("Timer_RTC", "DS3231M", "Package_SO",
                            "SOIC-16W_7.5x10.3mm_P1.27mm", "U40")
ads = cd.synthesize_chipdown("Analog_ADC", "ADS1115IDGS", "Package_SO",
                             "TSSOP-10_3x3mm_P0.5mm", "U40")
out = {
    "version": "v1", "milestone": "M6 Multi-Rail and Mixed-Signal Synthesis",
    "domain_model": {"patterns": [p for p, _d in multirail.DOMAIN_PATTERNS],
                     "rule": "every domain gets its OWN net; unknown domains "
                             "BLOCK with no guess; human rail_overrides carry "
                             "intent (VCCB=+5V)"},
    "proven_on_copper": {
        "chipdown-txb0102-v1": {**_facts("chipdown-txb0102-v1"),
                                "rails": {d: i["net"] for d, i in
                                          txb["rails"].items()}},
        "chipdown-ds3231m-v1": {**_facts("chipdown-ds3231m-v1"),
                                "rails": {d: i["net"] for d, i in
                                          ds["rails"].items()}}},
    "mixed_signal": {
        "ads1115_analog_pins": [x["name"] for x in
                                ads["analog_pins_requiring_afe"]],
        "rule": "analog inputs NEVER join a generic digital IO header — "
                "listed as requiring an analog front end (review); analog "
                "accuracy / noise / reference / calibrated-measurement "
                "claims stay blocked",
        "blocked": ads["mixed_signal_blocked_claims"]},
    "emitter_updates": ["per-DOMAIN decoupling (one cap per rail, never "
                        "assume +3V3)", "wide-body (SOIC-16W) column shift",
                        "fanout ZONE_NETS corrected to actual planes "
                        "(GND/+3V3) — a +5V 'zone' dogbone made orphan vias "
                        "(TXB VCCB signature)", "SOT-23-8/-6 join the "
                        "fine-pitch fab class"],
    "still_blocked": ["measurement packs stay 4-layer",
                      "precision/calibration claims",
                      "VBAT battery-backup POLICY (rail exists; charging/"
                      "switchover circuit not synthesized)"],
    "honesty": "routed_in_sandbox; domain nets carry review flags; nothing "
               "physical"}
for r in ["fl1-backplane-v1", "chipdown-txb0102-v1", "chipdown-ds3231m-v1"]:
    d = os.path.join(RUNS, r, "data")
    os.makedirs(d, exist_ok=True)
    json.dump(out, open(os.path.join(
        d, "compose-m6-multirail-mixed-signal-report.json"), "w"), indent=1)
print("txb:", out["proven_on_copper"]["chipdown-txb0102-v1"])
print("ds3231m:", out["proven_on_copper"]["chipdown-ds3231m-v1"])
