"""M8R regression: advanced fab gates replay through M3A/M3B."""
import json
import os
import sys

import advanced_fab as af

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui", "public",
                 "runs", "fl1-backplane-v1", "data")


def art(name):
    p = os.path.join(D, name + ".json")
    return json.load(open(p)) if os.path.exists(p) else None


rep = art("m8r-advanced-fab-replay-report")
check("1 replay report exists, sourced from the quarantine",
      rep is not None and "m7-m12-pre-hardening" in rep["replayed_from"])
g = rep["gate_results"]
check("2 proven classes still allowed (2L/4L)",
      g["simple 2L power board"]["verdict"] == "allowed"
      and g["QFN-56 core (4L)"]["verdict"] == "allowed")
check("3 unsupported classes NEVER appear routable",
      rep["unsupported_never_allowed"] is True
      and all(g[k]["verdict"] == "architecture_only" for k in
              ("coarse full-array BGA-121 (iCE40)", "fine BGA 0.5mm",
               "WLCSP", "congested 3-signal-layer board")))
rv = art("m8r-fab-router-evidence")
check("4 2L profile cites PASSING router fixtures (incl. real 2L replay)",
      rv["fab_2layer_std"]["state"] == "PROVEN"
      and len(rv["fab_2layer_std"]["fixtures"]) == 2
      and all(f["pass"] for f in rv["fab_2layer_std"]["fixtures"]))
check("5 4L profile cites PASSING router fixtures (QFN escape + realboard)",
      rv["fab_4layer_std"]["state"] == "PROVEN"
      and len(rv["fab_4layer_std"]["fixtures"]) >= 4
      and all(f["pass"] for f in rv["fab_4layer_std"]["fixtures"]))
check("6 6-layer: architecture_only, trigger case fixture-proven to fail",
      rv["fab_6layer_std"]["state"] == "architecture_only"
      and rv["fab_6layer_std"]["trigger_case_evidence"][0]["actual_result"]
      == "failed_honestly")
check("7 HDI: architecture_only, ring-1 trap evidence attached (M7R)",
      rv["fab_hdi_1_2_1"]["state"] == "architecture_only"
      and rv["fab_hdi_1_2_1"]["trigger_case_evidence"][0]["fixture_id"]
      == "bga121_ring1_trapped")
check("8 M3B: controlled impedance blocked, no stackup data in repo",
      rep["m3b_connection"]["controlled_impedance_claim"]["state"] == "blocked"
      and rep["m3b_connection"]["stackup_model_local"]["found"] is False)
check("9 impedance estimator refuses without stackup",
      rep["m3b_connection"]["impedance_estimator_behavior"]["result_status"]
      == "skipped_missing_input")
bc = art("m8r-fab-blocked-claims")
check("10 blocked claims: HDI/microvia/via-in-pad/6L/impedance",
      all(any(c in b for b in bc["blocked_claims"]) for c in
          ("HDI", "microvia", "via-in-pad", "6-layer",
           "controlled_impedance")))
check("11 6-layer stackup still honestly absent in the module",
      "not implemented" in af.FAB_PROFILES["fab_6layer_std"]["state"])
check("12 M7R finding folded in without upgrading any verdict",
      "unchanged" in rep["m7r_finding_folded_in"]
      and "ACCEPTED as gates" in rep["verdict"])
check("13 physical ledger untouched; no ordering action",
      rep["physical_ledger"]["artifacts"] == []
      and rep["physical_ledger"]["order_status"] == "not_ordered"
      and rep["no_ordering_action"] is True)

npass = sum(1 for ok in checks if ok)
print("%d/%d M8R checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
