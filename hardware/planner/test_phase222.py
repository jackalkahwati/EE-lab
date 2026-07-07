"""Phase 22.2 regression: JIT primitive acquisition engine."""
import json
import os
import sys

import jit_primitives as jp

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui", "public", "runs")
D = os.path.join(RUNS, "fl1-backplane-v1", "data")


def art(name, d=D):
    p = os.path.join(d, name + ".json")
    return json.load(open(p)) if os.path.exists(p) else None


check("1 gap detector generated (12 gap types)",
      len(art("compose-primitive-gap-detector")["gap_types"]) == 12)
check("2 evidence states generated (15)",
      len(art("compose-primitive-evidence-states")["states"]) == 15)
check("3 candidate cannot satisfy physical gate",
      not jp.satisfies_physical("candidate_from_datasheet")
      and jp.satisfies_physical("physically_validated"))
check("4 candidate cannot support production_ready",
      not jp.can_support_claim("candidate_from_library_import", "production_ready")
      and not jp.can_support_claim("routed_in_sandbox", "production_ready"))
check("5 datasheet ingestion interface generated (resolve_part path)",
      "resolve_part" in art("compose-datasheet-ingestion-interface")["implementation"])
check("6 symbol/pinmap generator generated",
      art("compose-symbol-pinmap-generator") is not None)
g = jp.pinmap_gate([{"name": "VDD", "number": "1", "kind": "power"},
                    {"name": "GND", "number": "2", "kind": "ground"},
                    {"name": "?", "number": "3", "kind": "unknown"}])
check("7 unknown pins block automatic use", not g["ok"] and "BLOCK" in g["problems"][0])
check("8 footprint verification generated",
      art("compose-footprint-acquisition-verification") is not None)
v = jp.verify_footprint(8, {"pad_count": 6, "pitch_mm": 0.65,
                            "datasheet_pitch_mm": 0.65, "has_courtyard": True,
                            "has_pin1_marker": True})
check("9 pad count mismatch blocks primitive", v["state"] == "blocked")
v2 = jp.verify_footprint(8, {"pad_count": 8, "pitch_mm": 0.65,
                             "datasheet_pitch_mm": 0.65, "has_courtyard": True,
                             "has_pin1_marker": False})
check("10 missing pin-1 marker blocks automatic use", v2["state"] == "blocked")
check("11 reference circuit extractor generated",
      art("compose-reference-circuit-extractor") is not None)
check("12 sandbox test-board generator generated",
      art("compose-sandbox-primitive-testboard-generator") is not None)
st, why = jp.promote("footprint_supported_with_review", "physically_validated",
                     "sandbox_route")
check("13 sandbox route is NOT physical validation (promotion refused)",
      st == "footprint_supported_with_review" and "REFUSED" in why)
check("14 runtime workflow generated (10 steps, 6 outcomes)",
      len(art("compose-runtime-primitive-acquisition-workflow")["steps"]) == 10)
cases = {c["gap"]: c for c in
         art("compose-jit-primitive-gap-application-report")["cases"]}
check("15 BME280 processed (library import + footprint w/ review)",
      any("BME280" in k and cases[k]["state"] == "footprint_supported_with_review"
          for k in cases))
check("16 USB-C processed (footprints exist, sandbox pending)",
      any("USB-C" in k and "sandbox pending" in cases[k]["outcome"] for k in cases))
check("17 SMA processed (candidate, RF claims blocked)",
      any("SMA" in k and "RF claims blocked" in cases[k]["outcome"] for k in cases))
check("18 gate driver processed WITHOUT fake support (blocked)",
      any("gate driver" in k and cases[k]["state"] == "blocked" for k in cases))
check("19 QFN-56 remains blocked by escape capability",
      any("QFN-56" in k and "escape planner" in cases[k]["outcome"] for k in cases))
check("20 fleet memory integration (all high-risk claims blocked)",
      "structural" in art("compose-jit-primitive-fleet-memory-update")["claim_blockers"])
check("22 acquired primitives are review-required",
      all("review" in c["state"] or c["state"] == "blocked"
          or c["state"].startswith("candidate")
          for c in cases.values()))
check("23 no physical validation invented",
      art("compose-jit-primitive-fleet-memory-update")["promotions"].startswith("none"))
check("24 no production-ready anywhere",
      "production_ready" in art("compose-primitive-evidence-states")["high_risk_claims"])
check("library evidence is REAL filesystem checks",
      "REAL filesystem checks" in
      art("compose-jit-primitive-gap-application-report")["evidence_note"]
      and all(any(c["library_evidence"].values()) or c["state"] == "blocked"
              for c in cases.values()))
check("demotion on failure",
      jp.promote("physically_validated", "repeatedly_validated",
                 "physical_test", status="fail")[0] == "deprecated")

npass = sum(1 for ok in checks if ok)
print("%d/%d Phase 22.2 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
