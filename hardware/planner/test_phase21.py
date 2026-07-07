"""Phase 21 regression: general-purpose PCBA design engine."""
import json
import os
import sys

import pcba_engine as pe

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui", "public", "runs")
D = os.path.join(RUNS, "fl1-backplane-v1", "data")


def art(name, d=D):
    p = os.path.join(d, name + ".json")
    return json.load(open(p)) if os.path.exists(p) else None


# 1-9 artifacts
for n, a in enumerate(["compose-pcba-request-schema", "compose-board-type-classifier",
                       "compose-fabrication-decision-engine",
                       "compose-general-claim-gate-model",
                       "compose-design-pattern-library",
                       "compose-component-capability-checker",
                       "compose-general-architecture-planner",
                       "compose-arbitrary-board-job-schema",
                       "compose-general-design-examples"], 1):
    check("%d %s generated" % (n, a), art(a) is not None)

ex = {e["request"]: e for e in art("compose-general-design-examples")["examples"]}

# 10-17 example classifications
check("10 env sensor -> sensor_board, buildable_with_review",
      ex["Make a battery-powered environmental sensor board"]["classification"]
      ["board_family"] == "sensor_board"
      and ex["Make a battery-powered environmental sensor board"]["job"]
      ["buildability"] == "buildable_with_review")
usb = ex["Make a USB-C power monitor"]
check("11 USB-C monitor -> power_monitor with USB-C caveat",
      usb["classification"]["board_family"] == "power_monitor"
      and usb["job"]["buildability"] in ("buildable_with_review", "architecture_only"))
mot = ex["Make a 24V brushed DC motor controller"]
check("12 motor controller -> motor_controller, not buildable_now",
      mot["classification"]["board_family"] == "motor_controller"
      and mot["job"]["buildability"] != "buildable_now")
hat = ex["Make a Raspberry Pi HAT for relay control"]
check("13 Pi HAT -> relay_or_switch_matrix, buildable_with_review",
      hat["classification"]["board_family"] == "relay_or_switch_matrix"
      and hat["job"]["buildability"] == "buildable_with_review")
sat = ex["Make a satellite watchdog board"]
check("14 satellite watchdog blocks space-qualified claims",
      sat["classification"]["board_family"] == "space_or_high_reliability"
      and any("space_ready" in c for c in sat["classification"]["blocked_claims"]))
rf = ex["Make an RF adapter board"]
check("15 RF adapter flags RF/impedance requirements",
      any("RF_compliant" in c or "impedance" in c
          for c in rf["classification"]["blocked_claims"])
      and rf["job"]["buildability"] in ("architecture_only",
                                        "blocked_by_missing_component_model"))
pcie = ex["Make a PCIe capture board"]
check("16 PCIe capture -> architecture_only with external SI/PI",
      pcie["job"]["buildability"] == "architecture_only"
      and "external SI/PI" in pcie["fabrication"]["reason"])
ai = ex["Make an AI accelerator carrier board"]
check("17 AI carrier blocked on HDI/BGA/SI-PI",
      ai["job"]["buildability"] == "blocked_by_unproven_fabrication"
      and "HDI" in ai["fabrication"]["reason"])

# 18-20 capability honesty
check("18 fabrication engine never recommends unproven HDI as buildable",
      ai["fabrication"]["capability"] == "blocked_by_unproven_fabrication")
check("19 bare RP2040 QFN-56 remains blocked",
      pe.capability_check(["RP2040 bare QFN-56"])["items"][0]["status"]
      == "blocked_by_qfn56_escape")
gates = pe.claim_gates(pe.parse_request("simple sensor board"), "buildable_with_review")
check("20 production_ready forbidden without physical evidence",
      gates["production_ready"].startswith("forbidden_without_evidence"))

# 21-24 no FL-1 assumptions in the generic job
job = ex["Make a battery-powered environmental sensor board"]["job"]
check("21 generic job has no FL-1-specific names",
      "FL-1" not in json.dumps(job) and "fl1" not in json.dumps(job).lower())
check("22 generic job does not assume the FL-1 bus",
      "bus header" not in json.dumps(job).lower() and "fl1bus" not in json.dumps(job))
check("23 Pico appears only when the planner selects it",
      any("Pico" in c for c in job["required_components"])  # sensor board selects it
      and "Pico" not in json.dumps(ex["Make an RF adapter board"]["job"]
                                   ["required_components"]))
check("24 layer count is a recommendation with confidence, not always 4",
      "2-layer" in job["layer_recommendation"] and job["layer_confidence"])

# 26 FL-1 untouched
fa3 = art("fl1-final-first-article-review-v3", os.path.join(RUNS, "fl1-cal-board-v4", "data"))
dash = art("fl1-production-readiness-dashboard")
check("26 FL-1 seven-board system unchanged (review-required, human-gated)",
      all(b["recommendation"] == "order_3_pcba" for b in fa3["boards"])
      and dash["current_state"] == "first_article_ready_for_human_approval")

# pattern library generic
pats = art("compose-design-pattern-library")["patterns"]
check("pattern library: 19 FL-1-proven patterns, portability noted",
      len(pats) == 19 and all("generic" in p["portability"] for p in pats))
check("examples honesty: no general-success claim beyond tested set",
      "no general-purpose success" in art("compose-general-design-examples")["honesty"])

npass = sum(1 for ok in checks if ok)
print("%d/%d Phase 21 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
