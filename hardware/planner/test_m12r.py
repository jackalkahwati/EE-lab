"""M12R regression: reliability gates replay through the evidence ledger."""
import json
import os
import sys

import reliability_classes as rc

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


rep = art("m12r-reliability-replay-report")
check("1 replay report exists, sourced from the quarantine",
      rep is not None and "m7-m12-pre-hardening" in rep["replayed_from"])
check("2 medical remains blocked (implantable + infusion pump)",
      rep["medical_blocked"] is True
      and rc.classify_request("implantable pump")[1] == "blocked")
check("3 space/defense remain architecture_only (design intent only)",
      rep["space_defense_architecture_only"] is True)
check("4 commercial standard flow unaffected",
      rep["commercial_flow_unaffected"] is True
      and rc.classify_request("bench power monitor")[0] == "commercial")
lg = rep["ledger_gates"]
check("5 all 9 environmental/qualification claims gate on the ledger",
      len(lg) == 9 and all(v["state"] == "blocked" for v in lg.values()))
check("6 ledger is empty and every gate says structurally physical",
      all(v["ledger_artifacts"] == 0 for v in lg.values())
      and all("structurally physical" in v["note"] for v in lg.values()))
check("7 EMC doubly blocked (ledger + M3B gate)",
      lg["EMC_compliance"]["m3b_gate"] == "blocked")
check("8 wording audit clean — no qualification/certification assertion",
      rep["wording_audit"]["clean"] is True
      and rep["wording_audit"]["qualification_wording_found"] == [])
bc = art("m12r-reliability-blocked-claims")
check("9 blocked claims: space/defense/mission/radiation/IPC3/burn-in/"
      "implantable + environmental set",
      all(c in bc["blocked_claims"] for c in
          ("space_readiness", "defense_readiness", "mission_critical",
           "radiation_tolerance", "IPC_class_3", "burn_in",
           "implantable_readiness", "environmental_qualification",
           "vibration_qualification", "thermal_cycle_qualification")))
check("10 physical ledger untouched; no ordering action",
      rep["physical_ledger"]["artifacts"] == []
      and rep["physical_ledger"]["order_status"] == "not_ordered"
      and rep["no_ordering_action"] is True)

npass = sum(1 for ok in checks if ok)
print("%d/%d M12R checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
