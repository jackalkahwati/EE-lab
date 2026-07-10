"""M3A regression: flroute harness + router evidence (invokes the REAL fast
suite under kipython)."""
import json
import os
import subprocess
import sys

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui",
                       "scripts")
D = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui", "public",
                 "runs", "fl1-backplane-v1", "data")
KIPY = ("/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/"
        "Versions/Current/bin/python3")


def art(name):
    p = os.path.join(D, name + ".json")
    return json.load(open(p)) if os.path.exists(p) else None


aud = art("flroute-audit")
check("1 flroute audit exists (hidden assumptions found)",
      aud is not None and any("PLANE HEURISTIC" in a for a in
                              aud["hidden_assumptions_found"]))
check("2 fixture schema exists",
      art("flroute-fixture-schema") is not None)
rep = art("flroute-regression-report")
check("3 full suite report: 21/21",
      rep["full_suite"]["passed"] == 21 and rep["full_suite"]["fixtures"] == 21)
check("4 realboard replays 3/3 (full heal chain)",
      rep["realboard_suite"]["passed"] == 3)
check("5 expected failures are first-class passes",
      set(rep["honest_failures_proven"]) >= {"impossible_blocked_path",
                                             "open_net_reported",
                                             "too_narrow_channel"})
by = {r["fixture_id"]: r for r in rep["full_suite"]["results"]}
check("6 open nets recorded on failure fixtures",
      by["open_net_reported"]["open_net_list"] == ["N1"]
      or by["open_net_reported"]["routed_net_count"] == 0)
check("7 stub-vs-stub residual-risk fixture green",
      by["qfn_escape_stub_vs_stub"]["pass"])
check("8 QFN-56 reduced + stress fixtures present and honest",
      by["rp2040_like_qfn56_reduced"]["pass"]
      and by["rp2040_like_qfn56_stress"]["pass"])
check("9 2-layer fixture rejects internal layers",
      by["two_layer_no_internal_layers"]["pass"]
      and not any("In" in layer for layer in
                  by["two_layer_no_internal_layers"]["layer_usage"]))
gold = art("flroute-golden-artifact-system")
check("10 golden system: 24 goldens, synthetic determinism proven",
      gold["goldens"] == 24 and "DETERMINISTIC" in gold["determinism_probe"])
check("11 golden diffs never override DRC",
      any("NEVER override DRC" in r for r in gold["rules"]))
check("12 import/export regression covers flattening + dropped copper",
      "M2 bug" in art("flroute-import-export-regression-report")["covered"][
          "layer_flattening"])
corr = art("flroute-drc-correlation-layer")
check("13 DRC correlation: router pass + DRC fail = FAIL (proven live)",
      "router pass + DRC fail" in corr["rules"][1])
bev = art("compose-board-router-evidence-report")
check("14 board router evidence (16 boards, failures visible, none physical)",
      len(bev["boards"]) == 16
      and any(b.get("router_evidence_state") == "routed_by_flroute_failed"
              for b in bev["boards"]))
check("15 CI integration report exists",
      art("flroute-ci-integration-report") is not None)
# 16: LIVE fast suite under kipython (crash-isolated)
r = subprocess.run([KIPY, os.path.join(SCRIPTS, "flroute_harness.py"),
                    "fast", "/tmp/m3a-ci-fast"], capture_output=True,
                   text=True, timeout=900)
live = json.load(open("/tmp/m3a-ci-fast/flroute-regression-report.json"))
check("16 LIVE fast suite green under kipython",
      live["passed"] == live["fixtures"] == 6)
hyg = art("compose-hardening-pause-hygiene-report")
check("17 pause hygiene: M6 committed first, drafts quarantined",
      "446530a" in hyg["m6_status"]["committed"]
      and "drafts/m7-m12-pre-hardening/" in hyg["quarantine"]["location"])

npass = sum(1 for ok in checks if ok)
print("%d/%d M3A checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
