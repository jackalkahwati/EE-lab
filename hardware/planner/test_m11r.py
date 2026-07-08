"""M11R regression: high-speed gates replay through M3B evidence."""
import json
import os
import sys

import highspeed_rules as hs

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


rep = art("m11r-high-speed-replay-report")
check("1 replay report exists, sourced from the quarantine",
      rep is not None and "m7-m12-pre-hardening" in rep["replayed_from"])
check("2 all 9 high-speed demo domains architecture_only",
      rep["all_domains_architecture_only"] is True
      and len(rep["gate_demos"]) == 9)
ddr = rep["ddr_detection_regression"]
check("3 DDR detection bug stays dead (phrasings + clean probes)",
      ddr["phrasings_detected"] is True
      and ddr["substring_false_positives_clean"] is True)
gap = rep["detection_gap_closure"]
check("4 USB high-speed detection gap CLOSED (architecture_only)",
      gap["usb_hs_now"] == "architecture_only"
      and hs.hs_gate("usb high speed data")["verdict"] == "architecture_only")
check("5 gigabit Ethernet detection gap CLOSED (architecture_only)",
      gap["eth_now"] == "architecture_only"
      and hs.hs_gate("RGMII phy")["verdict"] == "architecture_only")
m3b = rep["m3b_connection"]
check("6 no IBIS models in repo — recorded, SI claim blocked",
      m3b["ibis_models_local"]["found"] is False
      and m3b["high_speed_signal_integrity_claim"]["state"] == "blocked")
check("7 controlled impedance + diff-pair quality blocked (no stackup)",
      m3b["controlled_impedance_claim"]["state"] == "blocked"
      and m3b["differential_pair_quality_claim"]["state"] == "blocked"
      and m3b["stackup_model_local"]["found"] is False)
check("8 SI benchmark replay: pcie/usb3 architecture_only, missing-IBIS "
      "honest",
      m3b["si_benchmark_replay"]["pcie_request"] == "architecture_only"
      and m3b["si_benchmark_replay"]["usb3_request"] == "architecture_only"
      and m3b["si_benchmark_replay"]["missing_ibis_report"]
      == "skipped_missing_input")
bc = art("m11r-high-speed-blocked-claims")
check("9 blocked: SI/PI/eye/timing/DDR/PCIe/USB3 readiness + diff-pair "
      "beyond proven scope",
      all(c in bc["blocked_claims"] for c in
          ("SI_correctness", "PI_correctness", "eye_diagram",
           "timing_closure", "DDR_readiness", "PCIe_readiness",
           "USB3_readiness",
           "differential_pair_routing_beyond_proven_scope")))
check("10 every missing capability carries a citation",
      len(bc["missing_capability_citations"]) == 6
      and all(v for v in bc["missing_capability_citations"].values()))
check("11 physical ledger untouched; no ordering action",
      rep["physical_ledger"]["artifacts"] == []
      and rep["physical_ledger"]["order_status"] == "not_ordered"
      and rep["no_ordering_action"] is True)

npass = sum(1 for ok in checks if ok)
print("%d/%d M11R checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
