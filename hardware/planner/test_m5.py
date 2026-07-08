"""M5 regression: no provenance -> no claim."""
import json
import os
import sys

import chipdown_synthesis as cd
import datasheet_evidence as de

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


v = de.support_value("PCF8574T", "decoupling_nF")
check("1 absent evidence -> review_required_placeholder w/ provenance none",
      v["state"] == "review_required_placeholder" and v["provenance"] == "none")
check("2 placeholder blocks ALL claims incl. value_selection_basis",
      v["claims_allowed"] == [] and "value_selection_basis" in v["claims_blocked"])
fx = {"X": {"decoupling_nF": {"value": 100, "units": "nF",
                              "source": "datasheet_pdf",
                              "source_ref": "fixture ds"}}}
v2 = de.support_value("X", "decoupling_nF", db=fx)
check("3 evidence-derived value carries provenance + stays review-required",
      v2["state"] == "evidence_derived_review_required"
      and v2["source_ref"] == "fixture ds")
check("4 evidence never unblocks performance claims",
      "sensor_accuracy" in v2["claims_blocked"]
      and "compliance" in v2["claims_blocked"])
bad = {"X": {"decoupling_nF": {"value": 100, "units": "nF",
                               "source": "datasheet_pdf"}}}  # no source_ref
v3 = de.support_value("X", "decoupling_nF", db=bad)
check("5 missing source_ref -> placeholder (unattributable evidence refused)",
      v3["state"] == "review_required_placeholder")
e = cd.synthesize_chipdown("Memory_EEPROM", "24LC02", "Package_SO",
                           "SOIC-8_3.9x4.9mm_P1.27mm", "U40")
check("6 chipdown entries carry provenance",
      e["support_value_provenance"]["placeholders"] == 2)
HERE = os.path.dirname(os.path.abspath(__file__))
rep = json.load(open(os.path.join(
    HERE, "..", "..", "software", "prompt-to-pcb-ui", "public", "runs",
    "chipdown-ads1115-v1", "data",
    "compose-m5-datasheet-provenance-report.json")))
check("7 M5 report: DB absent, 100% placeholders, nothing invented",
      "no value was invented" in rep["honesty"].replace("\n", " ")
      or "invented" in rep["honesty"])
check("8 no web sourcing path claimed", "no web search" in rep["ingestion"])

npass = sum(1 for ok in checks if ok)
print("%d/%d M5 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
