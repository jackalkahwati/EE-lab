"""C5 regression: low/moderate power-tree synthesis."""
import json
import os
import sys

import power_tree as pt

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui", "public",
                 "runs", "fl1-backplane-v1", "data")
B = json.load(open(os.path.join(
    D, "power-tree-benchmark-report.json")))["benchmarks"]

ldo = B["ldo_5v_to_3v3"]
check("1 LDO tree: explicit rails + dependency graph",
      "+3V3" in ldo["rails"] and ldo["dependency_graph"]["+3V3"] == ["+5V"])
check("2 LDO application circuit review-required without evidence",
      "review_required" in ldo["rails"]["+3V3"]["application_circuit"])
buck = B["buck_missing_model"]
check("3 buck stays architecture_only with a MISSING-MODEL report",
      buck["rails"]["+5V"]["state"] == "architecture_only"
      and len(buck["rails"]["+5V"]["missing_model_report"]
              ["missing_evidence"]) >= 3)
check("4 buck placement hints: hot loop + NOISY switch node",
      any("NOISY" in h for h in buck["rails"]["+5V"]["placement_hints"]))
rp = B["rp2040_power_tree"]
check("5 RP2040 tree: MCU internal domains documented, not invented rails",
      rp["rails"]["DVDD_1V1_internal"]["type"] == "mcu_internal_domain")
check("6 multi-rail trees keep domains separate (TXB0102, DS3231M VBAT)",
      "VCCA_3V3" in B["txb0102_multi_rail"]["rails"]
      and "VBAT_RAIL" in B["ds3231m_vbat"]["rails"])
check("7 rail merge collision refused (never silent)",
      "never" in str(pt.build_power_tree(
          [{"rail": "+3V3"}],
          [pt.ldo_rail("+3V3", "+5V", 3.3)]).get("error", "")))
check("8 protection primitives candidate_review_required "
      "(fuse/reverse/tvs/sense)",
      all(p["state"] == "candidate_review_required"
          for p in B["power_entry_protection"]["protections"])
      and B["current_sense_fixture"]["protections"][0]["kind"]
      == "current_sense")
check("9 current widths are IPC-2221 ESTIMATES (M9 language preserved)",
      any("ESTIMATE" in w["basis"]
          for w in ldo["current_width_advisory"].values()))
check("10 PI + regulator stability blocked via live M3B gates",
      ldo["claim_gates"]["power_integrity_claim"] == "blocked"
      and B["regulator_stability_gate"]["state"] == "blocked")
check("11 motor + mains remain blocked (M9R unchanged)",
      B["motor_board"]["state"] == "blocked"
      and B["mains_board"]["state"] == "blocked")
check("12 tree honesty: rails never merged silently, no PI/thermal claim",
      "never merged silently" in ldo["honesty"])

npass = sum(1 for ok in checks if ok)
print("%d/%d C5 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
