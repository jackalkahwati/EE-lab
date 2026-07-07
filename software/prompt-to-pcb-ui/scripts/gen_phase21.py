"""Phase 21: generate the general-purpose PCBA engine artifacts + 8 examples.

  gen_phase21.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import pcba_engine as pe  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")
TARGETS = ["fl1-backplane-v1", "fl1-cal-board-v4"]


def _w(name, obj):
    for r in TARGETS:
        json.dump(obj, open(os.path.join(RUNS, r, "data", name + ".json"), "w"), indent=1)


_w("compose-pcba-request-schema", {
    "version": "v1", "domains": list(pe.DOMAINS),
    "fields": list(pe.parse_request("example").keys()),
    "note": "parse_request() fills assumptions explicitly labeled '(assumed)'"})
_w("compose-board-type-classifier", {
    "version": "v1", "families": list(pe.FAMILIES),
    "outputs": ["board_family", "secondary_families", "confidence", "reason",
                "likely_risks", "suggested_patterns", "blocked_claims"]})
_w("compose-fabrication-decision-engine", {
    "version": "v1", "proven": pe.PROVEN, "blocked_capabilities": pe.BLOCKED_CAPS,
    "capability_states": ["proven_now", "likely_buildable_with_review",
                          "requires_new_capability", "architecture_only", "blocked"],
    "rule": "unproven fabrication (HDI/microvia/large BGA/high-speed) is NEVER "
            "recommended as buildable"})
_w("compose-general-claim-gate-model", {
    "version": "v1", "claim_types": list(pe.CLAIM_TYPES),
    "gate_states": ["allowed", "allowed_with_review", "forbidden_without_evidence",
                    "blocked", "not_applicable"],
    "rules": ["production_ready requires physical builds + validation + yield + "
              "human approval", "compliance claims require specific evidence",
              "high-speed claims require SI evidence", "RF claims require RF "
              "evidence", "calibration claims require physical calibration",
              "space/defense claims require qualification plan + evidence",
              "architecture_only designs are never marked buildable"]})
_w("compose-design-pattern-library", {
    "version": "v1", "patterns": pe.pattern_library()})
_w("compose-component-capability-checker", {
    "version": "v1", "known": pe.KNOWN,
    "states": ["supported", "supported_with_review", "missing_component_model",
               "missing_footprint", "missing_layout_primitive",
               "missing_routing_capability", "missing_validation_workflow",
               "missing_manufacturing_rule", "blocked"]})
_w("compose-general-architecture-planner", {
    "version": "v1", "buildability_states": list(pe.BUILDABILITY),
    "outputs": ["architecture", "functional blocks", "power tree", "interfaces",
                "connector strategy", "compute strategy", "analog strategy",
                "protection strategy", "test strategy", "risks", "buildability"]})
_w("compose-arbitrary-board-job-schema", {
    "version": "v1",
    "job_fields": ["board_name", "board_family", "intended_function",
                   "allowed_claims", "forbidden_claims", "required_components",
                   "interfaces", "power", "layer_recommendation",
                   "layer_confidence", "patterns", "validation_plan",
                   "manufacturing_plan", "evidence_gates", "buildability"],
    "non_assumptions": ["no FL-1-specific board names", "no FL-1 bus unless "
                        "requested", "no Pico module unless the planner selects "
                        "it", "no 4-layer unless the fabrication engine "
                        "recommends it"]})

EXAMPLES = [
    "Make a battery-powered environmental sensor board",
    "Make a USB-C power monitor",
    "Make a 24V brushed DC motor controller",
    "Make a Raspberry Pi HAT for relay control",
    "Make a satellite watchdog board",
    "Make an RF adapter board",
    "Make a PCIe capture board",
    "Make an AI accelerator carrier board",
]
results = [pe.plan(pe.parse_request(t)) for t in EXAMPLES]
_w("compose-general-design-examples", {
    "version": "v1",
    "examples": [{"request": EXAMPLES[i], **results[i]} for i in range(len(EXAMPLES))],
    "summary": [{"request": EXAMPLES[i],
                 "family": results[i]["classification"]["board_family"],
                 "buildability": results[i]["job"]["buildability"],
                 "layers": results[i]["fabrication"]["recommendation"],
                 "next_capability": results[i]["next_required_capability"]}
                for i in range(len(EXAMPLES))],
    "honesty": "these are the TESTED examples — no general-purpose success "
               "claim beyond them"})

for i, r in enumerate(results):
    print("%-46s %-26s %s" % (EXAMPLES[i][:44],
          r["classification"]["board_family"], r["job"]["buildability"]))
