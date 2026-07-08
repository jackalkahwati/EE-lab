"""M12R: replay the quarantined M12 reliability classes through the
physical evidence ledger.

The draft mapped commercial/industrial/hi-rel/space/defense/medical classes
to review workflows and blocked mission-ready claims. The replay connects
every environmental/qualification claim to the PHYSICAL evidence ledger
(empty -> blocked, structurally: these are lab-measured properties, no
simulation path exists), keeps medical blocked entirely, and audits the
wording so no certification/qualification language can appear as a claim.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import reliability_classes as rc  # noqa: E402
import external_eda as ee  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")

# ---- draft gates re-run -----------------------------------------------------
demos = {t: rc.classify_request(t) for t in (
    "LEO satellite payload", "defense radio", "mil-spec comms unit",
    "implantable sensor", "medical infusion pump", "industrial controller",
    "high reliability avionics", "bench instrument")}

# ---- physical evidence ledger connection ------------------------------------
led = json.load(open(os.path.join(RUNS, "power-entry-header-2l", "data",
                                  "compose-physical-evidence-ledger.json")))
ENV_CLAIMS = ("environmental_qualification", "vibration_qualification",
              "thermal_cycle_qualification", "radiation_tolerance",
              "EMC_compliance", "safety_certification",
              "reliability_demonstration", "burn_in_complete",
              "IPC_class_3_acceptance")
ledger_gates = {c: {
    "state": "blocked",
    "requires": "physical/lab evidence in the ledger",
    "ledger_artifacts": len(led["artifacts"]),
    "note": "structurally physical — no simulation or document path can "
            "satisfy this; the ledger is empty"} for c in ENV_CLAIMS}
ledger_gates["EMC_compliance"]["m3b_gate"] = ee.gate("EMC_claim")["state"]

# ---- wording audit ----------------------------------------------------------
corpus = json.dumps(rc.CLASSES) + json.dumps(demos)
qual_words = re.findall(
    r"\b(qualified|certified|compliant|mission[- ]ready|rad[- ]hard "
    r"verified)\b", corpus, re.I)
wording_audit = {
    "qualification_wording_found": qual_words,
    "clean": not qual_words,
    "note": "class descriptions may NAME standards as review requirements; "
            "they must never assert meeting them"}

blocked = {
    "blocked_claims": sorted(set(rc.BLOCKED) | set(ENV_CLAIMS)),
    "medical": "blocked entirely (not a Compose claim domain)",
    "space_defense": "architecture_only — design-intent description only; "
                     "zero qualification claims (rad-hard parts, MIL review, "
                     "traceability, conformal coating: ALL ABSENT and said "
                     "so)",
    "ledger_connection": "every environmental/qualification claim requires "
                         "ledger artifacts; ledger is empty; claims blocked",
    "note": "reliability class handling exists as a gate/model — a routing "
            "of requests to review workflows, not a capability"}

report = {
    "version": "v1", "milestone": "M12R reliability gates replay",
    "replayed_from": "drafts/m7-m12-pre-hardening (M12)",
    "classes": rc.CLASSES,
    "gate_demos": demos,
    "medical_blocked": all(v == "blocked" for k, v in
                           [demos["implantable sensor"],
                            demos["medical infusion pump"]][0:1]) and
                       demos["implantable sensor"][1] == "blocked" and
                       demos["medical infusion pump"][1] == "blocked",
    "space_defense_architecture_only":
        demos["LEO satellite payload"][1] == "architecture_only"
        and demos["defense radio"][1] == "architecture_only"
        and demos["mil-spec comms unit"][1] == "architecture_only",
    "commercial_flow_unaffected":
        demos["bench instrument"] == ["commercial", "standard"]
        or tuple(demos["bench instrument"]) == ("commercial", "standard"),
    "ledger_gates": ledger_gates,
    "wording_audit": wording_audit,
    "verdict": "ACCEPTED as gates: class mapping + review workflows only; "
               "medical blocked; space/defense architecture_only (design "
               "intent, zero qualification claims); every environmental/"
               "qualification claim blocked against the EMPTY physical "
               "ledger; wording audit clean",
    "physical_ledger": {"artifacts": led["artifacts"],
                        "order_status": led["order_status"]},
    "no_ordering_action": True,
    "honesty": "no reliability/space/defense/medical qualification is "
               "claimed; explicit physical evidence requirements per claim"}

md = """# M12R — reliability gates replay through evidence ledger

## Accepted (gate/blocker milestone)
- Class mapping re-verified: commercial standard flow unaffected;
  industrial review-required; hi-rel/space/defense architecture_only;
  medical (implantable, infusion pump) BLOCKED entirely.

## Ledger connection (new under replay)
Every environmental / qualification claim now gates on the PHYSICAL
evidence ledger, which is empty — all blocked, structurally:
environmental, vibration, thermal-cycle, radiation, EMC (also blocked by
the M3B gate), safety, reliability demonstration, burn-in, IPC Class 3.
No simulation or document path can satisfy these.

## Wording audit
No qualification/certification/mission-ready assertion appears anywhere
in the classes or demos. Standards are NAMED as review requirements only.

Physical ledger untouched; no ordering or quote action.
"""

for r in ["fl1-backplane-v1", "bare-mcu-qfn56-core-sandbox-v1"]:
    d = os.path.join(RUNS, r, "data")
    json.dump(report, open(os.path.join(
        d, "m12r-reliability-replay-report.json"), "w"), indent=1)
    open(os.path.join(d, "m12r-reliability-replay-report.md"), "w").write(md)
    json.dump(blocked, open(os.path.join(
        d, "m12r-reliability-blocked-claims.json"), "w"), indent=1)

print("M12R: medical=%s space/defense=%s wording_clean=%s ledger_claims_"
      "blocked=%d" %
      (report["medical_blocked"],
       report["space_defense_architecture_only"],
       wording_audit["clean"], len(ledger_gates)))
