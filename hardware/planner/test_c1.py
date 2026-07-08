"""C1 regression: role-aware placement engine."""
import json
import os
import sys

import role_placement as rp

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui", "public",
                 "runs", "fl1-backplane-v1", "data")
RUNS = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui",
                    "public", "runs")


def art(name):
    p = os.path.join(D, name + ".json")
    return json.load(open(p)) if os.path.exists(p) else None


check("1 33 roles + 15 rules defined",
      len(rp.ROLES) == 33 and len(rp.RULES) == 15)
check("2 role classification: MCU / crystal / decoupling / ESD / relay",
      rp.classify_role("U1", "RP2040 QFN-56") == "mcu"
      and rp.classify_role("Y1", "Crystal 12MHz") == "crystal"
      and rp.classify_role("C5", "100nF") == "decoupling_cap"
      and rp.classify_role("C9", "10uF") == "bulk_cap"
      and rp.classify_role("U3", "USBLC6-2SC6") == "esd_protection")

bp = os.path.join(RUNS, "fl1-core6-bare-rp2040-combination-v1",
                  "variant.kicad_pcb")
rep = rp.placement_report(bp)
check("3 REAL board parses (127 components, >75%% roles classified)",
      rep["components"] == 127
      and rep["roles_classified"] / rep["components"] > 0.75)
check("4 support-circuit grouping assigns caps/crystal/flash to owner ICs",
      len(rep["support_groups"]) >= 3
      and any(any(m["role"] == "crystal" for m in g)
              for g in rep["support_groups"].values()))
ev = rep["evaluation"]
check("5 rules EVALUATED with honest violations on the real board "
      "(crystal/flash distance)",
      ev["violations"] >= 2
      and any(f["rule"] == "crystal_near_mcu" and f["state"] == "violated"
              for f in ev["findings"]))
check("6 risk score = violations/applicable, bounded 0..1",
      0 <= ev["risk_score"] <= 1
      and ev["risk_score"] == round(
          ev["violations"] / ev["applicable_rules"], 3))
check("7 inapplicable rules reported as not_applicable, never passed",
      any(f["state"] == "not_applicable" for f in ev["findings"]))
check("8 evaluation carries the honesty statement",
      "not hidden" in ev["honesty"])

bench = art("role-aware-placement-benchmark-report")
check("9 benchmark report exists with 8 fixtures",
      bench is not None and len(bench["benchmarks"]) == 8)
check("10 synthetic fixtures labeled SYNTHETIC",
      any("SYNTHETIC" in str(v.get("source", ""))
          for v in bench["benchmarks"].values()))
eng = art("role-aware-placement-engine-v1")
check("11 engine artifact: rules carry rationale; RF stays module-contained",
      all(r["why"] for r in eng["rules"])
      and any("module-contained" in r["why"] for r in eng["rules"]))
check("12 no physical/production/advanced claim added",
      "No physical" in eng["honesty"])

# noisy-node marking on the buck fixture
buck = bench["benchmarks"]["buck_fixture"]["report"] \
    if "report" in bench["benchmarks"]["buck_fixture"] \
    else bench["benchmarks"]["buck_fixture"]
findings = (buck.get("evaluation") or buck)["findings"]
check("13 buck switch node marked NOISY; ADC-near-noise violation caught",
      any("NOISY" in n for f in findings for n in f.get("notes", []))
      and any(f["rule"] == "adc_away_from_noise"
              and f["state"] == "violated" for f in findings))

npass = sum(1 for ok in checks if ok)
print("%d/%d C1 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
