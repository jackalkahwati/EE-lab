"""Phase 23.6 regression: first physical evidence loop."""
import json
import os
import sys

import physical_evidence as pv

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui", "public", "runs")
D = os.path.join(RUNS, "power-entry-header-2l", "data")


def art(name, d=D):
    p = os.path.join(d, name + ".json")
    return json.load(open(p)) if os.path.exists(p) else None


check("1 evidence state model (15 states)",
      len(art("compose-physical-evidence-state-model")["states"]) == 15)
st, why = pv.advance("package_ready_with_review", "quote_requested")
check("2 states past package_ready require approval",
      st == "package_ready_with_review" and "REFUSED" in why)
st2, _ = pv.advance("package_ready_with_review", "human_approved_for_quote",
                    human_approval=True)
check("2b approval advances legitimately", st2 == "human_approved_for_quote")
sel = art("compose-first-physical-board-selection")
check("3-4 selection: power-entry-header 2L wins",
      "power-entry-header" in sel["recommendation"] and "2-LAYER" in
      sel["recommendation"])
check("5 QFN explicitly not first",
      "NOT the first physical target" in sel["qfn_note"])
pkg = art("power-entry-header-v1-physical-first-article-package-report")
check("6 first article package complete for human review",
      pkg["package_complete_for_human_review"]
      and "NOT PHYSICALLY VALIDATED" in pkg["status_banner"])
check("7 human approval packet exists (signature gates explicit)",
      "APPROVED FOR QUOTE" in open(os.path.join(
          D, "power-entry-header-v1-human-approval-packet.md")).read())
chk = art("power-entry-header-v1-order-approval-checklist")
check("7b approval gates null until signed",
      all(g["signed"] is None for g in chk["gates"]) and not chk["auto_order"])
qp = art("power-entry-header-v1-quote-package")
check("8-10 quote package: not submitted, not ordered, placeholder prices",
      qp["submitted"] is False and qp["ordered"] is False
      and "PLACEHOLDER" in qp["price_table"]["all values"])
wf = art("power-entry-header-v1-physical-validation-workflow")
check("11 validation workflow (15 steps, no cert claims)",
      len(wf["steps"]) == 15 and any("no certification" in r for r in wf["rules"]))
sch = art("compose-physical-evidence-ingestion-schema")
check("12 ingestion schema exists", sch is not None)
ok, probs = pv.validate_artifact({"artifact_type": "voltage_readings",
                                  "board_id": "x", "run_id": "y",
                                  "datetime": "t", "operator": None})
check("13 artifacts require attribution", not ok and any("operator" in p for p in probs))
ok2, probs2 = pv.validate_artifact({"artifact_type": "voltage_readings",
                                    "board_id": "x", "run_id": "y",
                                    "datetime": "t", "operator": "jack",
                                    "measurement_value": 4.98})
check("14 measurements require units", not ok2 and any("units" in p for p in probs2))
good = {k: {"pass": True, "has_measurement": True, "units": "V"}
        for k in pv.REQUIRED_FOR_PHYSICAL}
okg, _ = pv.promotion_gate(good)
check("15-16 promotion gate passes complete real evidence", okg)
photo = dict(good)
photo["continuity_pass"] = {"pass": True, "photo_only": True}
okp, pp = pv.promotion_gate(photo)
check("15b photos alone rejected for electrical",
      not okp and any("photos alone" in p for p in pp))
sim = dict(good)
sim["power_test_pass"] = {"pass": True, "simulated": True,
                          "has_measurement": True, "units": "V"}
oks, ps = pv.promotion_gate(sim)
check("17 gate rejects simulated evidence",
      not oks and any("simulated" in p for p in ps))
miss = dict(good)
del miss["visual_inspection_pass"]
okm, pm = pv.promotion_gate(miss)
check("18 gate rejects missing visual inspection",
      not okm and any("visual_inspection" in p for p in pm))
nomeas = dict(good)
nomeas["testpoint_voltage_pass"] = {"pass": True}
okn, pn = pv.promotion_gate(nomeas)
check("19 gate rejects missing electrical measurements",
      not okn and any("measurement" in p for p in pn))
noadj = dict(good)
del noadj["signed_adjudication"]
oka, pa = pv.promotion_gate(noadj)
check("20 gate rejects missing signed adjudication",
      not oka and any("adjudication" in p for p in pa))
led = art("compose-physical-evidence-ledger")
check("21-22 ledger exists, EMPTY, no fake passes",
      led["artifacts"] == [] and led["human_approvals"] == []
      and "no placeholder passes" in led["honesty"])
lad = art("compose-readiness-ladder-physical-update")
check("23-24 ladder (12 states) + production_ready structurally forbidden",
      len(lad["ladder"]) == 12 and "structurally forbidden" in lad["rules"][0])
flu = art("compose-first-physical-evidence-fleet-learning-update")
check("25 fleet update (QFN only after simpler boards pass)",
      any("ONLY after" in x for x in flu["next_physical_after_first"]))
gate = art("compose-physical-promotion-gate")
check("scoped promotion (no production-ready anywhere)",
      "production readiness" in
      gate["promotion_scope"]["explicitly_not_promoted"])
check("42-45 no order/quote/validation/production claims",
      led["order_status"] == "not_ordered"
      and led["quote_status"] == "not_requested")

npass = sum(1 for ok in checks if ok)
print("%d/%d Phase 23.6 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
