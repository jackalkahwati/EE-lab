"""Pattern-learning regression (Phase 12 items 7-12) — fast checks over the
pattern spec / extraction / license gates / selection, using real local sources.

  python3 test_patterns.py
"""
import json
import os
import sys

import pattern_library as pl
import pattern_spec as ps
import reference_manifest as rm

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


RUNS = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    "..", "..", "software", "prompt-to-pcb-ui", "public", "runs")

pats = pl.build()

# 7. a reference design produces a Design Pattern Spec
adc = next((p for p in pats if p["category"] == "precision_adc_channel"), None)
check("7 reference -> Design Pattern Spec",
      adc is not None and adc.get("components") and adc.get("pattern_version"),
      "components=%d status=%s" % (len(adc["components"]) if adc else 0,
                                   adc["support_status"] if adc else "none"))

# 8. license status is required before direct reuse
p_nolic = ps.make_pattern("x", "test", "open_source", None, components=[{"role": "r"}])
check("8 license required (no license -> not reusable)",
      "license_status" in ps.validate(p_nolic)[0] if ps.validate(p_nolic) else False,
      "errs=%s" % ps.validate(p_nolic)[:1])

# 9. unsafe/unknown license blocks direct reuse
check("9 manufacturer/unknown license blocks direct reuse",
      not rm.can_direct_reuse("manufacturer_reference_only")
      and not rm.can_direct_reuse("unknown_needs_review")
      and rm.can_direct_reuse("permissive_reuse"))

# 10. pattern selection explains selected + rejected
sel = pl.select({"product_goal": "precision adc measurement", "capabilities": ["adc", "precision"], "buses": ["i2c"]})
check("10 selection explains selected + rejected",
      sel["selected"] is not None and sel["selected"]["why"] and len(sel["rejected"]) > 0,
      "selected=%s rejected=%d" % (sel["selected"]["category"] if sel["selected"] else None,
                                   len(sel["rejected"])))

# 11. high-risk parts require review (ADC -> preserve_exactly / reusable_with_review)
check("11 high-risk (ADC) -> review",
      adc and adc["support_status"] == "reusable_with_review"
      and any(c.get("zone") == "preserve_exactly" for c in adc["components"]),
      "status=%s" % (adc["support_status"] if adc else "none"))

# placeholders are never usable / never selected
placeholders = [p for p in pats if p.get("needs_reference")]
check("placeholders not usable",
      all(p["support_status"] not in pl.USABLE for p in placeholders),
      "%d placeholders, all non-usable" % len(placeholders))

# 12. a pattern-backed board attempt produced a real result (PASSED or honest fail)
v2 = os.path.join(RUNS, "fl1-meas-v2", "data", "last-run.json")
if os.path.exists(v2):
    st = json.load(open(v2)).get("status")
    check("12 pattern-backed board attempt ran", st in ("PASSED", "GATE FAILED"),
          "status=%s" % st)
else:
    check("12 pattern-backed board attempt ran", False, "no fl1-meas-v2 run")

npass = sum(1 for ok in checks if ok)
print("%d/%d pattern checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
