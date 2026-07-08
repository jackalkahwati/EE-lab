"""C7 regression: customer board program templates."""
import json
import os
import sys

import board_templates as bt

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui", "public",
                 "runs", "fl1-backplane-v1", "data")
T = json.load(open(os.path.join(D, "template-benchmark-report.json")))
B, C = T["benchmarks"], T["citations"]

check("1 eight templates cover the majority envelope",
      len(bt.TEMPLATES) == 8)
check("2 seven instantiate review-required; USB-FS honestly blocked",
      sum(1 for k in bt.TEMPLATES
          if B[k]["state"] == "instantiable_review_required") == 7
      and B["usb_fs_data_logger"]["state"] == "blocked")
check("3 USB-FS template names the exact C4 primitive gaps",
      any("esd" in str(m) or "dp_dm" in str(m)
          for m in B["usb_fs_data_logger"]["blocked_by"]))
check("4 every cited proven run exists with PASSED status",
      all(r["exists"] and r["status"] == "PASSED"
          for runs in C.values() for r in runs))
check("5 instances still run the REAL gates (not fake demos)",
      all("full" in B[k]["honesty"] for k in bt.TEMPLATES
          if B[k]["state"] == "instantiable_review_required"))
check("6 blocked variants name their gate: mains -> M9R",
      B["blocked_variant_mains"]["state"] == "blocked"
      and "M9R" in B["blocked_variant_mains"]["blocked_by"])
check("7 impedance coupon -> M3B stackup gate",
      "stackup" in B["blocked_variant_impedance_coupon"]["blocked_by"])
check("8 RF tuning variant -> module-contained rule",
      "module-contained" in B["blocked_variant_rf_tuning"]["blocked_by"])
check("9 unknown template blocks",
      B["unknown_template"]["state"] == "blocked")
check("10 evidence-pack mapping present per instantiable template",
      all("evidence_pack_mapping" in B[k] for k in bt.TEMPLATES
          if B[k]["state"] == "instantiable_review_required"))
check("11 compose specs use the proven block vocabulary",
      B["environmental_telemetry_node"]["compose_spec"]["blocks"][0]
      == "power"
      and "mcu" in B["industrial_io_controller"]["compose_spec"]["blocks"])
check("12 measurement/analog accuracy claims stay blocked in templates",
      "calibration" in str(bt.TEMPLATES["dut_power_monitor"]
                           ["blocked_variants"]).lower()
      or "calibration" in str(bt.TEMPLATES["calibration_reference_board"]
                              ["blocked_variants"]).lower())

npass = sum(1 for ok in checks if ok)
print("%d/%d C7 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
