"""Ingestion regression (Phase 10, items 7-10) — asserts the datasheet-to-UCS
engine behaves honestly. Board-pipeline regression (items 1-6) lives in
demo_and_regression.py; this covers the ingestion-specific guarantees.

  python3 test_ingest.py     # prints PASS/FAIL per check, exits non-zero on fail
"""
import sys

import ingest
import ingest_library

checks = []


def check(name, ok, detail=""):
    checks.append((name, ok, detail))
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


# 7. a real part ingests into a valid UCS (pins + interface, needs_review)
spec, rep = ingest.ingest_part("ADS1115IDGS", kicad_symbol="ADS1115IDGS",
                               category="adc.precision", manufacturer="TI")
check("7 ADS1115 -> valid UCS",
      len(spec["pins"]) == 10 and "i2c" in rep["interfaces"]
      and spec["support_status"] == "needs_review",
      "pins=%d iface=%s status=%s" % (len(spec["pins"]), rep["interfaces"], spec["support_status"]))

# 8. symbol/footprint mismatch is caught (MCP4725 6-pin symbol vs SOT-23 3-pad)
_s, r = ingest.ingest_part("MCP4725", kicad_symbol="MCP4725xxx-xCH", category="dac")
check("8 footprint/pin mismatch caught",
      any("pad" in e.lower() or "mismatch" in e.lower() for e in r["validation_errors"]),
      "errors=%s" % r["validation_errors"][:1])

# 9. a part missing a required pin (no power) -> not usable (unsupported/needs_review)
_s2, r2 = ingest.ingest_part("REF3025", kicad_symbol="REF3025", category="voltage_reference")
check("9 missing power pin -> not supported",
      _s2["support_status"] in ("unsupported", "needs_review")
      and any("power" in e.lower() for e in r2["validation_errors"] + r2["warnings"]),
      "status=%s" % _s2["support_status"])

# 10. an approved ingested part is usable by synthesis (in the library, partial+)
approved = ingest_library.approve(spec, "partial")
usable = approved["support_status"] in ingest_library.USABLE and len(approved["pins"]) == 10
check("10 approved part usable in synthesis", usable,
      "status=%s pins=%d" % (approved["support_status"], len(approved["pins"])))

# honesty: fresh ingestion never auto-'supported'
check("honesty: fresh ingest never auto-supported",
      spec["support_status"] != "supported")

npass = sum(1 for _n, ok, _d in checks if ok)
print("%d/%d ingest checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
