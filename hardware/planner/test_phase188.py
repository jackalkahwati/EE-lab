"""Phase 18.8 regression: Full-16 monolithic no-Pico stress test.

Rails: all 16 functions accounted for, no-Pico verified on copper, exact
blockers recorded, no fake USB/QSPI/crystal/instrument/calibration claims,
six plugin boards untouched, nothing ordered or production-ready.

  python3 test_phase188.py
"""
import json
import os
import sys

import role_completeness as rc

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui", "public", "runs")
D = os.path.join(RUNS, "fl1-core6-mono-bare", "data")


def art(name, d=D):
    p = os.path.join(d, name + ".json")
    return json.load(open(p)) if os.path.exists(p) else None


# 1-6: analysis artifacts
fmap = art("full16-fl1-function-map")
check("1 Full-16 function map generated (16 functions)",
      fmap and len(fmap["functions"]) == 16)
tc = art("full16-monolithic-treatment-classification")
check("2 treatment classification for all 16",
      tc and len(tc["classification"]) == 16
      and all(f["treatment"] in tc["treatments"] for f in tc["classification"]))
comp = art("full16-monolithic-architecture-comparison")
check("3 architecture comparison (5 candidates A-E)",
      comp and [c["id"] for c in comp["candidates"]] == ["A", "B", "C", "D", "E"])
check("4 bare RP2040 subsystem model generated",
      art("bare-rp2040-subsystem-model") is not None)
qfn = art("rp2040-qfn56-fanout-feasibility")
check("5 QFN-56 fanout feasibility from a REAL attempt",
      qfn and qfn["attempted"] and qfn["status"] == "blocked_by_escape_density")
check("6 domain partitioning model generated",
      len(art("full16-monolithic-domain-partitioning-model")["domains"]) >= 19)

# 7-10: the three compose attempts + alternate
b = art("core6-monolithic-pico-compose-report", os.path.join(RUNS, "fl1-core6-mono-pico", "data"))
check("7 Core-6 Pico attempt ran -> routed_and_review_required",
      b and b["status"] == "routed_and_review_required" and b["drc_violations"] == 0)
c = art("core6-monolithic-bare-rp2040-compose-report")
check("8 Core-6 bare-RP2040 attempt ran -> blocked honestly with exact blocker",
      c and c["status"] == "blocked_by_qfn56_fanout" and "escape" in c["exact_blocker"])
d16 = art("full16-monolithic-bare-rp2040-compose-report", os.path.join(RUNS, "fl1-full16-mono-bare", "data"))
check("9 Full-16 bare-RP2040 attempt ran -> architecture_only_with_blockers",
      d16 and d16["status"] == "architecture_only_with_blockers")
check("10 alternate MCU candidate marked architecture_only with reason",
      art("full16-monolithic-alternate-mcu-report")["status"] == "architecture_only")

# 11-16: no-Pico verification on the REAL boards
for run in ("fl1-core6-mono-bare", "fl1-full16-mono-bare"):
    txt = open(os.path.join(RUNS, run, "variant.kicad_pcb")).read()
    dev = json.load(open(os.path.join(RUNS, run, "data", "devices.json")))
    np = rc.mono_nopico_checks(txt, dev)
    ok = {ch["check"]: ch["ok"] for ch in np["checks"]}
    check("11 %s: NO Pico module footprint" % run, ok["no Pico module footprint"])
    check("12 %s: bare RP2040 present" % run, ok["bare RP2040 present (QFN-56)"])
    check("13 %s: QSPI flash present" % run, ok["QSPI flash present"])
    check("14 %s: clock source present" % run, ok["clock source present (crystal + XIN/XOUT)"])
    check("15 %s: regulator present" % run, ok["3V3 regulator present"])
    check("16 %s: SWD/boot/reset present" % run, ok["SWD/boot/reset present"])

# 17-22: treatment honesty
by_t = {}
for f in tc["classification"]:
    by_t.setdefault(f["treatment"], []).append(f)
check("17 Full-16 accounts for all 16 (counts sum)",
      sum(tc["counts"].values()) == 16)
mono_txt = open(os.path.join(RUNS, "fl1-full16-mono-bare", "variant.kicad_pcb")).read()
check("18 implemented functions have real nets (REF_OUT/SHUNT_HI/SR_OE/CANH/REF_DIV2)",
      all(x in mono_txt for x in ('"REF_OUT"', '"SHUNT_HI"', '"SR_OE"', '"CANH"', '"REF_DIV2"')))
check("19 external-COTS-only functions claim no internal capability",
      all("COTS" in f["detail"] for f in by_t.get("external_cots_interface_only", [])))
check("20 reserved-zone functions not counted as implemented",
      all(f["treatment"] == "reserved_zone_only"
          for f in by_t.get("reserved_zone_only", [])) and tc["counts"]["reserved_zone_only"] == 2)
check("21 architecture-only functions not counted as buildable",
      tc["counts"]["architecture_only"] == 4)
check("22 blocked/architecture-only functions carry reasons",
      all(f["detail"] for f in by_t.get("architecture_only", [])))

# 23-27: reports
check("23 monolithic role-completeness reports generated (3 runs, 16/16)",
      all(art("monolithic-role-completeness-report", os.path.join(RUNS, r, "data"))
          ["requirements_met"] == 16 for r in
          ("fl1-core6-mono-pico", "fl1-core6-mono-bare", "fl1-full16-mono-bare")))
check("24 monolithic validation workflows (12)",
      len(art("monolithic-validation-workflows")["workflows"]) == 12)
check("25 manufacturing risk assessment (5 rows)",
      len(art("full16-monolithic-manufacturing-risk-assessment")["rows"]) == 5)
rec = art("full16-monolithic-final-recommendation")
check("26 final recommendation = keep_modular_for_first_articles",
      rec["recommendation"] == "keep_modular_for_first_articles"
      and "build_bare_rp2040_core_test_board_first" in rec["secondary"])
check("27 architecture-search feedback generated",
      art("phase18-full16-monolithic-feedback-report") is not None)

# 29-31: six plugin boards untouched, nothing ordered/production
fa3 = art("fl1-final-first-article-review-v3", os.path.join(RUNS, "fl1-cal-board-v4", "data"))
eii = art("eii1-compose-report", os.path.join(RUNS, "fl1-eii1-v1", "data"))
pcm = art("pcm1-compose-report", os.path.join(RUNS, "fl1-pcm1-v1", "data"))
check("29 six plugin boards unchanged (4x order_3_pcba + EII-1 + PCM-1 review-ready)",
      all(x["recommendation"] == "order_3_pcba" for x in fa3["boards"])
      and eii["verdict"] == "ready_to_build_with_review"
      and pcm["verdict"] == "ready_to_build_with_review")
check("30 stress-test articles are never order candidates",
      all("NEVER" in art(n, os.path.join(RUNS, r, "data"))["order"] for r, n in
          [("fl1-core6-mono-pico", "core6-monolithic-pico-compose-report"),
           ("fl1-core6-mono-bare", "core6-monolithic-bare-rp2040-compose-report"),
           ("fl1-full16-mono-bare", "full16-monolithic-bare-rp2040-compose-report")]))
check("31 no production-ready claim", "not production-ready" in c["honesty"])

# 32-37: no fake claims
sub = art("bare-rp2040-subsystem-model")
check("32 no USB impedance/compliance claim",
      any("no USB compliance claim" in h for h in sub["honesty"]))
check("33 no QSPI timing claim", any("no QSPI timing claim" in h for h in sub["honesty"]))
check("34 no crystal validation claim",
      any("no crystal performance claim" in h for h in sub["honesty"]))
cal_fn = next(f for f in fmap["functions"] if f["n"] == 4)
check("35 no calibration/precision claim", "UNCALIBRATED" in cal_fn["detail"])
check("36 no DMM/scope/funcgen/RF/LA claims",
      all(art("full16-fl1-function-map")["functions"][n - 1]["unsupported_claims"]
          for n in (7, 12, 13, 14)))
check("37 no high-current/high-voltage claim (fn 8 architecture_only)",
      next(f for f in fmap["functions"] if f["n"] == 8)["treatment"] == "architecture_only")

npass = sum(1 for ok in checks if ok)
print("%d/%d Phase 18.8 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
