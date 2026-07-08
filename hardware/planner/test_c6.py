"""C6 regression: enterprise module library."""
import json
import os
import sys

import module_library as ml

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui", "public",
                 "runs", "fl1-backplane-v1", "data")
B = json.load(open(os.path.join(
    D, "module-library-benchmark-report.json")))["benchmarks"]
rep = json.load(open(os.path.join(
    D, "enterprise-module-library-v1.json")))

check("1 15 module primitives with contract fields",
      len(ml.MODULES) == 15
      and all("blocked_claims" in m and "validation_workflow" in m
              for m in ml.MODULES.values()))
check("2 proven vs candidate footprint states distinguished honestly",
      len(rep["proven"]) >= 6 and len(rep["candidates"]) >= 5)
check("3 all 10 module boards compose (review states, none 'ready')",
      all(B[k]["state"] in ("composable_review_required", "review_required")
          for k in B if k != "unknown_module_blocked"))
check("4 RF modules: board-level RF performance + regulatory blocked",
      all(c in ml.MODULES["lora"]["blocked_claims"][0]
          or c in str(ml.MODULES["lora"]["blocked_claims"])
          for c in ("board_level_RF_performance",))
      and "regulatory" in str(ml.MODULES["cellular"]["blocked_claims"]))
check("5 GNSS fix = sky test; cellular registration = network test",
      any("SKY" in s for s in ml.MODULES["gnss"]["validation_workflow"])
      and any("network test" in s
              for s in ml.MODULES["cellular"]["validation_workflow"]))
check("6 motor driver module: low-risk only, high-current stays blocked",
      any("BLOCKED" in c and "M9R" in c
          for c in ml.MODULES["motor_driver_low"]["blocked_claims"]))
check("7 isolated CAN: isolation rating requires creepage review+evidence",
      any("creepage" in c
          for c in ml.MODULES["isolated_can"]["blocked_claims"]))
check("8 candidate footprints force board review",
      B["mcu_isolated_can"]["state"] == "review_required"
      and len(B["mcu_isolated_can"]
              ["candidate_footprints_requiring_review"]) >= 1)
check("9 unknown module BLOCKS, nothing substituted",
      B["unknown_module_blocked"]["state"] == "blocked"
      and "quantum_flux" in str(B["unknown_module_blocked"]["reason"]))
check("10 composed boards union their blocked claims",
      B["mcu_imu_lora_tracker"]["blocked"] >= 6
      if isinstance(B["mcu_imu_lora_tracker"].get("blocked"), int)
      else len(B["mcu_imu_lora_tracker"]["blocked_claims"]) >= 6)
check("11 ADC/DAC accuracy claims blocked without calibration evidence",
      any("calibration" in c for c in
          ml.MODULES["adc_module"]["blocked_claims"])
      and any("calibration" in c for c in
              ml.MODULES["dac_module"]["blocked_claims"]))
check("12 existing proven module classes stay recognized "
      "(lora/gnss/cellular/imu/relay/eeprom/debug)",
      all("PROVEN" in ml.MODULES[k]["footprint_source_state"]
          for k in ("lora", "gnss", "cellular", "imu", "relay_module",
                    "board_id_eeprom", "debug_module")))

npass = sum(1 for ok in checks if ok)
print("%d/%d C6 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
