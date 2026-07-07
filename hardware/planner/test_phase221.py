"""Phase 22.1 regression: first non-FL-1 benchmark board."""
import json
import os
import sys

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui", "public", "runs")
D = os.path.join(RUNS, "env-sensor-benchmark-v1", "data")


def art(name, d=D):
    p = os.path.join(d, name + ".json")
    return json.load(open(p)) if os.path.exists(p) else None


req = art("env-sensor-benchmark-request")
check("1 request instantiated with forbidden claims",
      req and "battery-safety-certified" in req["forbidden_claims"])
check("2 classifies as sensor_board",
      art("env-sensor-classification")["board_family"] == "sensor_board")
fab = art("env-sensor-fabrication-decision")
check("3 fabrication decision generated with citations",
      fab and fab["citation"]["net_count"] == 14)
check("4 no HDI required", "HDI" not in fab["recommendation"])
check("4b 2-layer-vs-4-layer correction RECORDED, not silent",
      "RECORDED capability gap" in fab["correction_recorded"])
arch = art("env-sensor-architecture-plan")
check("5 architecture plan generated (planner selected Pico; honest reductions)",
      "SELECTED BY THE PLANNER" in arch["compute"]
      and "TEMPERATURE-ONLY" in arch["sensor"])
cap = art("env-sensor-component-capability-check")
check("6 capability check: BME280 gap honest, charger omitted",
      any("BME280" in r for r in cap["resolutions"])
      and any("charger" in r and "OMITTED" in r for r in cap["resolutions"]))
job = art("env-sensor-board-job")
check("7 board job generated", job is not None)
js = json.dumps(job)
check("8 job does not require FL-1 bus", "FL-1 bus" not in js.replace("no FL-1 bus", ""))
check("9 job does not require FL-1 slot connector", "slot strap" not in js.replace("no slot straps", ""))
check("10 job does not require FL-1 envelope", "envelope" not in js.replace("no FL-1 envelope", ""))
check("11 Pico only via planner selection", "SELECTED BY THE PLANNER" in arch["compute"])
check("12 layer count from the engine (2-layer candidate cited, 4-layer flow "
      "recorded)", "2-layer" in fab["recommendation"])

run = art("env-sensor-compose-run")
check("13 compose synthesis attempted (real pipeline)", run["pipeline_status"] == "PASSED")
check("14 routing recorded (14/14)", run["routing"] == "14/14")
check("15 DRC/ERC recorded (0 violations)", run["drc_violations"] == 0
      and run["unconnected"] == 0)
role = art("role-completeness-report")
check("16 GENERIC sensor_board role checker ran (10/10, with_review)",
      role["role"] == "sensor_board" and role["status"] == "role_complete_with_review")
check("17 validation workflow generated (11 steps + honesty rules)",
      len(art("env-sensor-validation-workflow")["steps"]) == 11)
flu = art("env-sensor-fleet-learning-update")
check("18 fleet learning updated (gaps + classifier-bug discovery + next rec)",
      len(flu["gaps_discovered"]) == 6 and "USB-C" in flu["next_recommendation"]
      and any("CAUGHT BY THIS BENCHMARK" in g for g in flu["gaps_discovered"]))

# on-copper FL-1-freedom
txt = open(os.path.join(RUNS, "env-sensor-benchmark-v1", "variant.kicad_pcb")).read()
check("20 board is FL-1-free ON COPPER",
      all(x not in txt for x in ('"FAULT"', '"INTERLOCK"', '"ID_A0"',
                                 '"TRIG"', '"RST_OUT"', "PinHeader_2x07")))
check("21 no physical validation claimed",
      "NOT physically validated" in run["honesty"])
check("22 no production-ready claim",
      "production_ready" in req["forbidden_claims"]
      and "NEVER automatic" in run["order"])
check("evidence is generated-class, not physical",
      flu["evidence"]["simulated_or_physical"] == "generated")

npass = sum(1 for ok in checks if ok)
print("%d/%d Phase 22.1 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
