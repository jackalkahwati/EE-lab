"""Phase 22: generate the fleet-learning artifacts, ingesting the Phase 21
examples + the FL-1 fleet as the initial memory.

  gen_phase22.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import fleet_learning as fl  # noqa: E402
import pcba_engine as pe  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")
TARGETS = ["fl1-backplane-v1", "fl1-cal-board-v4"]


def _w(name, obj):
    for r in TARGETS:
        json.dump(obj, open(os.path.join(RUNS, r, "data", name + ".json"), "w"), indent=1)


_w("compose-evidence-object-model", {
    "version": "v1", "evidence_types": list(fl.EVIDENCE_TYPES),
    "physical_only_types": sorted(fl.PHYSICAL_ONLY_TYPES),
    "fields": list(fl.make_evidence("X", "x", "design_generated", "pass",
                                    "generated", "engine").keys()),
    "rules": ["simulated evidence can NEVER satisfy physical evidence gates "
              "(fleet_learning.satisfies_physical)",
              "failed evidence is preserved", "physical evidence must identify "
              "source and instrument", "claim support/blocking is explicit"]})
_w("compose-fleet-memory-model", {
    "version": "v1", "categories": list(fl.MEMORY_CATEGORIES),
    "note": "yield_memory stays EMPTY until real yield data exists"})
_w("compose-failure-taxonomy", {"version": "v1", "classes": fl.failure_taxonomy()})

# pattern learning: FL-1 patterns are proven at DESIGN levels only
pat_states = []
for p in pe.pattern_library():
    routed = p["name"] in ("board identity EEPROM", "slot strap addressing",
                           "I2C pull-up ownership", "safe-default enable line",
                           "protected GPIO bank", "relay/probe matrix pattern",
                           "calibration/reference pattern",
                           "shunt + ADC monitor pattern",
                           "external instrument bridge pattern",
                           "interlock/fault/reset/trigger pattern",
                           "test-point policy")
    pkg = p["name"] in ("QR/serial traceability", "evidence ledger pattern",
                        "human-gated order package", "manufacturing package audit",
                        "build variant model", "incoming inspection plan",
                        "RevA->RevB feedback loop",
                        "connector orientation/keying policy")
    state = "proven_in_routed_board" if routed else \
            "proven_in_manufacturing_package" if pkg else "proven_in_generated_design"
    pat_states.append({"pattern": p["name"], "state": state,
                       "uses": "FL-1 seven-board fleet + stress tests",
                       "physical_promotion": "REQUIRES physical first-article "
                                             "evidence (none exists — nothing "
                                             "ordered)",
                       "demotion_rule": "failed evidence demotes; preserved"})
_w("compose-pattern-learning-engine", {
    "version": "v1", "states": list(fl.PATTERN_STATES),
    "patterns": pat_states,
    "promotion_rules": ["physical states require PHYSICAL evidence (enforced by "
                        "fleet_learning.promote)", "no silent promotion",
                        "no state skipping", "failed evidence demotes"]})

_w("compose-capability-gap-ranking", {
    "version": "v1", "ranking": fl.gap_ranking(),
    "note": "scores = boards+families unlocked minus complexity; strategic "
            "priorities can reorder with human review"})

# board job outcome ledger: 8 examples + FL-1 fleet
EXAMPLES = ["Make a battery-powered environmental sensor board",
            "Make a USB-C power monitor", "Make a 24V brushed DC motor controller",
            "Make a Raspberry Pi HAT for relay control",
            "Make a satellite watchdog board", "Make an RF adapter board",
            "Make a PCIe capture board", "Make an AI accelerator carrier board"]
plans = {t: pe.plan(pe.parse_request(t)) for t in EXAMPLES}
OUTCOME = {"buildable_with_review": "generated_only",
           "architecture_only": "architecture_only"}
ledger = []
for t, r in plans.items():
    b = r["job"]["buildability"]
    ledger.append({"board_job": t, "family": r["classification"]["board_family"],
                   "buildability": b,
                   "outcome": OUTCOME.get(b, "blocked"),
                   "next_action": r["next_required_capability"] or
                                  "attempt compose run as a benchmark",
                   "simulated_or_physical": "generated"})
for name, run in [("FL-1 Controller/Backplane v2.1", "fl1-core-controller-v21"),
                  ("FL-1 Digital Bring-up v2.1", "fl1-core-digital-v21"),
                  ("FL-1 Relay/Probe Matrix v2.1", "fl1-core-relay-v21"),
                  ("FL-1 Calibration/Reference v2", "fl1-cal-board-v4"),
                  ("FL-1 EII-1", "fl1-eii1-v1"), ("FL-1 PCM-1", "fl1-pcm1-v1"),
                  ("FL-1 Passive Backplane v1", "fl1-backplane-v1")]:
    ledger.append({"board_job": name, "family": "FL-1 fleet", "run_id": run,
                   "buildability": "first_article_ready_with_review",
                   "outcome": "first_article_ready_for_human_approval",
                   "next_action": "human approval form v2",
                   "simulated_or_physical": "generated (routed+gated, NOT "
                                            "physically validated)"})
_w("compose-board-job-outcome-ledger", {
    "version": "v1", "outcome_states": ["generated_only", "architecture_only",
    "blocked", "routed_with_review", "package_ready_with_review",
    "first_article_ready_for_human_approval", "ordered", "received",
    "physically_validated", "revb_required", "deprecated"],
    "jobs": ledger,
    "honesty": "no job has physical status; nothing ordered; no yield data"})

# learning report from the 8 examples
evidence, memory = [], fl.empty_fleet_memory()
for t, r in plans.items():
    ev = fl.make_evidence(t, r["classification"]["board_family"],
                          "capability_check",
                          "pass" if r["job"]["buildability"].startswith("buildable")
                          else "fail", "generated", "pcba_engine",
                          claims_blocked=r["classification"]["blocked_claims"],
                          notes=r["job"]["buildability"])
    evidence.append(ev)
    if not r["job"]["buildability"].startswith("buildable"):
        memory["failure_memory"].append({"job": t,
                                         "blocker": r["next_required_capability"]})
    for p in r["classification"]["suggested_patterns"]:
        memory["pattern_memory"].append({"pattern": p, "job": t})
_w("compose-phase21-example-learning-report", {
    "version": "v1", "evidence_objects": evidence,
    "fleet_memory_deltas": {k: v for k, v in memory.items() if v},
    "learned": [
        "environmental sensor + Pi HAT relay = general-purpose buildable "
        "regression candidates",
        "USB-C power monitor -> USB-C connector/protection primitive",
        "motor controller -> gate-driver/power-stage primitives",
        "RF adapter -> SMA footprint + impedance model",
        "PCIe capture -> external SI/PI integration",
        "AI accelerator -> HDI/BGA/SI-PI stack",
        "satellite watchdog -> high-reliability claim gating works"],
    "yield_memory": "EMPTY — no physical boards exist"})

_w("compose-next-board-benchmark-selector", fl.benchmark_selector())

sel = fl.benchmark_selector()
print("gap ranking top 3:", [g["capability"] for g in fl.gap_ranking()[:3]])
print("benchmark recommendation:", sel["recommendation"], "| runner-up:",
      sel["runner_up"])
print("excluded near-term:", sel["excluded_near_term"])
print("ledger: %d jobs, none physical" % len(ledger))
