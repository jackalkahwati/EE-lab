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

# 8. the footprint-pick fix: a multi-pin part now lands on a matching-pad footprint
#    (MCP4725 6-pin -> SOT-23-6, not the old 3-pad SOT-23), and validates clean.
_s, r = ingest.ingest_part("MCP4725", kicad_symbol="MCP4725xxx-xCH", category="dac")
check("8 footprint pad count matches pin count (fix)",
      "SOT-23-6" in (_s["kicad_footprint"] or "") and not r["validation_errors"],
      "fp=%s errors=%s" % (_s["kicad_footprint"], r["validation_errors"][:1]))

# 8b. the mismatch DETECTION still works when a footprint genuinely lacks pads —
#     force a 3-pad SOT-23 onto the 6-pin symbol and it must be caught.
_sm = ingest.from_kicad_symbol("MCP4725xxx-xCH", mpn="MCP4725", category="dac",
                               overrides={"kicad_footprint": "Package_TO_SOT_SMD:SOT-23"})
_val = ingest.validate_component(_sm)
check("8b footprint/pin mismatch still detected on a bad footprint",
      any("pad" in e.lower() or "mismatch" in e.lower() for e in _val["errors"]),
      "errors=%s" % _val["errors"][:1])

# 9. a part with a real power pin resolves it (REF3025 IN reclassified as power) —
#    the 3-terminal reference power inference fix.
_s2, r2 = ingest.ingest_part("REF3025", kicad_symbol="REF3025", category="voltage_reference")
check("9 3-terminal reference gets a power pin (fix)",
      _s2["support_status"] != "unsupported" and _s2["power"]["pins"]["power"],
      "status=%s power=%s" % (_s2["support_status"], _s2["power"]["pins"]["power"]))

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
