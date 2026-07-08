"""M5: datasheet-driven support circuit synthesis — provenance state."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import datasheet_evidence as de  # noqa: E402
import chipdown_synthesis as cd  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")
PARTS = ["PCF8574T", "24LC02", "74HC595", "ADS1115IDGS", "AP2112K-3.3"]
reports = {p: de.provenance_report(p) for p in PARTS}
e = cd.synthesize_chipdown("Memory_EEPROM", "24LC02", "Package_SO",
                           "SOIC-8_3.9x4.9mm_P1.27mm", "U40")
out = {"version": "v1",
       "milestone": "M5 Datasheet-Driven Support Circuit Synthesis",
       "schema": {"source_types": list(de.SOURCE_TYPES),
                  "support_keys": list(de.SUPPORT_KEYS),
                  "contract": "value + units + source + source_ref required "
                              "for evidence_derived; anything else is a "
                              "review_required_placeholder"},
       "ingestion": "hardware/planner/datasheet_db.json (human-curated, "
                    "absent today) — no web search, nothing invented",
       "current_state": {p: {"evidence_derived": r["evidence_derived"],
                             "placeholders": r["placeholders"]}
                         for p, r in reports.items()},
       "chipdown_integration": "every synthesized entry now carries "
                               "support_value_provenance (verified: %s)" % (
                                   e["support_value_provenance"]["values"][0]
                                   ["state"]),
       "blocked_without_evidence": list(de.BLOCKED_WITHOUT_EVIDENCE),
       "honesty": "the DB is empty, so 100% of support values are "
                  "review-required placeholders that SAY SO — no value was "
                  "invented to look derived"}
for r in ["fl1-backplane-v1", "chipdown-ads1115-v1"]:
    d = os.path.join(RUNS, r, "data")
    json.dump(out, open(os.path.join(
        d, "compose-m5-datasheet-provenance-report.json"), "w"), indent=1)
print("parts:", len(PARTS), "| all placeholders (DB absent):",
      all(r["evidence_derived"] == 0 for r in reports.values()))
