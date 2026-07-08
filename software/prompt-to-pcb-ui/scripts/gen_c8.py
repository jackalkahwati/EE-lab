"""C8: physical evidence campaign readiness artifacts."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import physical_campaign as pc  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")

c = pc.campaign()
led = json.load(open(os.path.join(
    RUNS, "power-entry-header-2l", "data",
    "compose-physical-evidence-ledger.json")))
c["physical_ledger_state"] = {"artifacts": led["artifacts"],
                              "order_status": led["order_status"]}

recommended = {
    "version": "v1",
    "first_three_builds": [r for r in c["rungs"]
                           if r["recommended_order"] <= 3],
    "rationale": "cheapest DRC-clean boards first: power-entry opens the "
                 "DFM loop; USB-C adds fine-pitch assembly; BME280 adds "
                 "the first I2C bring-up evidence — maximum evidence per "
                 "dollar before the high-risk bare-MCU boot attempt",
    "human_gate": "each build needs APPROVED_FOR_QUOTE, then MANUAL quote "
                  "submission (E7); nothing here orders anything",
}

md = "# C8 — First Physical Evidence Campaign Readiness v1\n\n" \
     "13-rung ladder. Buildable now (quote packet generatable, human " \
     "approval pending): %s. Blocked: %s.\n\n" \
     "Ledger state: %d artifacts, %s.\n\n%s\n\n## Ladder\n%s\n" % (
         ", ".join(c["buildable_now"]), ", ".join(c["blocked"]),
         len(led["artifacts"]), led["order_status"],
         "\n".join("- " + r for r in c["rules"]),
         "\n".join("%d. **%s** (%s) — %s" % (
             r["recommended_order"], r["board"], r["risk"], r["why_build"])
             for r in c["rungs"]))

for r in ["fl1-backplane-v1", "bare-mcu-qfn56-core-sandbox-v1"]:
    d = os.path.join(RUNS, r, "data")
    json.dump(c, open(os.path.join(
        d, "first-physical-evidence-campaign-readiness-v1.json"), "w"),
        indent=1)
    open(os.path.join(
        d, "first-physical-evidence-campaign-readiness-v1.md"),
        "w").write(md)
    json.dump(recommended, open(os.path.join(
        d, "recommended-first-builds-report.json"), "w"), indent=1)
    open(os.path.join(d, "recommended-first-builds-report.md"),
         "w").write(md)

print("C8: %d rungs | buildable %d | blocked %d | ledger %d/%s" % (
    len(c["rungs"]), len(c["buildable_now"]), len(c["blocked"]),
    len(led["artifacts"]), led["order_status"]))
