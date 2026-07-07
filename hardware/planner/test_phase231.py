"""Phase 23.1 regression: BME280 JIT sandbox + environmental sensor v2."""
import json
import os
import sys

import jit_primitives as jp

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui", "public", "runs")
D = os.path.join(RUNS, "bme280-sandbox-v1", "data")
D2 = os.path.join(RUNS, "env-sensor-benchmark-v2", "data")


def art(name, d=D):
    p = os.path.join(d, name + ".json")
    return json.load(open(p)) if os.path.exists(p) else None


acq = art("bme280-primitive-acquisition-record")
check("1 acquisition record exists (8 pins from library extraction)",
      acq and len(acq["extracted_pinout"]) == 8)
check("2 does not start physically_validated",
      acq["initial_state"] == "candidate_from_library_import")
pm = art("bme280-symbol-pinmap-report")
check("3 symbol/pinmap report exists + gate ok", pm and pm["gate"]["ok"])
check("4 unknown pins would block (gate function)",
      not jp.pinmap_gate([{"name": "?", "number": "1", "kind": "unknown"},
                          {"name": "VDD", "number": "2", "kind": "power"},
                          {"name": "GND", "number": "3", "kind": "ground"}])["ok"])
fpv = art("bme280-footprint-verification-report")
check("5 footprint verification exists (8 pads, 0.65 pitch, review state)",
      fpv["meta"]["pad_count"] == 8 and fpv["verdict"]["state"]
      == "footprint_supported_with_review")
check("6 footprint mismatch blocks (gate function)",
      jp.verify_footprint(8, {"pad_count": 6, "pitch_mm": 0.65,
                              "datasheet_pitch_mm": 0.65, "has_courtyard": True,
                              "has_pin1_marker": True})["state"] == "blocked")
check("7 missing pin-1 blocks (gate function)",
      jp.verify_footprint(8, {"pad_count": 8, "pitch_mm": 0.65,
                              "datasheet_pitch_mm": 0.65, "has_courtyard": True,
                              "has_pin1_marker": False})["state"] == "blocked")
refc = art("bme280-reference-circuit")
check("8 reference circuit exists (straps review-required)",
      "REVIEW-REQUIRED" in refc["circuit"]["CSB"])
check("9 I2C pull-up ownership explicit",
      "OWNERSHIP EXPLICIT" in refc["circuit"]["pullups"])
sbj = art("bme280-sandbox-board-job")
check("10 sandbox board job exists", sbj is not None)
txt = open(os.path.join(RUNS, "bme280-sandbox-v1", "variant.kicad_pcb")).read()
check("11-13 sandbox FL-1-free on copper (no bus/slots/safety nets)",
      all(x not in txt for x in ('"FAULT"', '"INTERLOCK"', '"TRIG"',
                                 '"RST_OUT"', "PinHeader_2x07", '"ID_A0"')))
run = art("bme280-sandbox-compose-run")
check("14 sandbox synthesis attempted (PASSED 5/5, 0 DRC)",
      run["status"] == "PASSED" and run["routing"] == "5/5" and run["drc"] == 0)
check("15 sandbox is NOT physical validation",
      "NOT physical validation" in run["honesty"])
promo = art("bme280-primitive-promotion-report")
check("16 promotion limited to manufacturing_package_supported_with_review; "
      "physical REFUSED",
      promo["final_state"] == "manufacturing_package_supported_with_review"
      and "REFUSED" in promo["physical_promotion_attempt"]["why"])
arch = art("env-sensor-v2-architecture-plan", D2)
check("17 v2 architecture gated on BME280 state", "ALLOWED" in arch["gate"])
check("18 v2 board job generated (upgrade recorded)",
      "LM75B" in art("env-sensor-v2-board-job", D2)["upgrade"])
txt2 = open(os.path.join(RUNS, "env-sensor-benchmark-v2", "variant.kicad_pcb")).read()
check("19-21 v2 FL-1-free on copper",
      all(x not in txt2 for x in ('"FAULT"', '"INTERLOCK"', '"TRIG"',
                                  '"RST_OUT"', "PinHeader_2x07", '"ID_A0"')))
r2 = art("env-sensor-v2-compose-run", D2)
check("22 v2 synthesis attempted (PASSED 14/14, 0 DRC)",
      r2["status"] == "PASSED" and r2["routing"] == "14/14" and r2["drc"] == 0)
check("23 non-FL-1 verification report exists",
      art("env-sensor-v2-non-fl1-verification-report", D2)["all_absent"])
role = art("role-completeness-report", D2)
check("24 generic sensor-board role runs (complete_with_review)",
      role["status"] == "role_complete_with_review")
vw = art("env-sensor-v2-validation-workflow", D2)
check("25 validation workflow v2 (12 steps, T+H+P sanity reads)",
      len(vw["steps"]) == 12 and any("humidity" in x for x in vw["steps"])
      and any("pressure" in x for x in vw["steps"]))
check("26-28 no calibration/accuracy/low-power claims",
      all(x in arch["blocked_claims"] for x in
          ("calibrated", "sensor_accuracy_validated", "low_power_validated")))
check("29 no production-ready claim", "production_ready" in arch["blocked_claims"])
flu = art("bme280-env-sensor-v2-fleet-learning-update")
check("30 fleet learning updated (loop proven, gaps closed + remaining)",
      "COMPLETE" in flu["loop_proven"] and len(flu["gaps_closed"]) == 2
      and "USB-C" in flu["next_recommendation"])
check("evidence is generated-class",
      flu["evidence"]["simulated_or_physical"] == "generated")
check("no ordering", "NEVER automatic" in r2["order"])

npass = sum(1 for ok in checks if ok)
print("%d/%d Phase 23.1 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
