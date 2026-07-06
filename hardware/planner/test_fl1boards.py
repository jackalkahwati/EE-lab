"""FL-1 exotic-boards regression (Phase 13) — verifies the reports generate and,
critically, that NO fake compute/RF/scope/funcgen/LA/DDR/PCIe/MIPI/BGA/mfg claims
are made. Unsupported must be honest.

  python3 test_fl1boards.py
"""
import json
import os
import sys
import tempfile

import fl1_boards as fb

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


tmp = tempfile.mkdtemp()
names = fb.generate_all(tmp)

# 8-10. taxonomy + family + bus artifacts generated
check("8 taxonomy artifact generated",
      os.path.exists(os.path.join(tmp, "fl1-exotic-board-taxonomy.json"))
      and len(fb.EXOTIC_TAXONOMY) == 13, "%d classes" % len(fb.EXOTIC_TAXONOMY))
fam = fb.board_family_map()
check("9 board family architecture (10 boards)", len(fam["boards"]) == 10)
check("10 instrument bus v1 (not final)",
      "NOT final" in fb.INSTRUMENT_BUS["version"])

# 11. RF report generated, no guaranteed RF performance
rf = fb.rf_50ohm_report()
check("11 RF report: 50ohm estimate, no RF guarantee",
      "ESTIMATE" in rf["honesty"]["impedance"] and rf["honesty"]["rf_performance"] == "NOT guaranteed"
      and rf["honesty"]["s_parameters"] == "NOT claimed")

# 12. scope-lite report: no oscilloscope-class performance
sc = fb.scope_lite_report()
check("12 scope-lite: unsupported, no scope-class perf",
      sc["status"] == "unsupported" and "NO oscilloscope-class" in sc["honesty"]["performance"])

# 13. stimulus report: no funcgen-class performance
st = fb.stimulus_report()
check("13 stimulus: no funcgen-class perf",
      "NO frequency-range" in st["honesty"]["performance"])

# 14. logic capture report: no LA-class performance
lg = fb.logic_capture_report()
check("14 logic: no logic-analyzer-class perf",
      "NO logic-analyzer-class" in lg["honesty"]["performance"])

# 15. FPGA/module carrier: DDR/PCIe/MIPI/BGA unsupported
fp = fb.fpga_module_carrier_report()
u = fp["unsupported"]
check("15 FPGA carrier: DDR/PCIe/MIPI/BGA unsupported",
      u["unsupported_ddr"] and u["unsupported_pcie"] and u["unsupported_mipi"]
      and u["unsupported_bga_fanout"] and u["unsupported_high_speed_memory"])

# 16-17. manufacturing + pattern readiness reports generated
mfg = fb.manufacturing_capability()
check("16 manufacturing capability report", len(mfg["boards"]) == 13
      and any(b["capability"] == "specialist_instrument_board_required" for b in mfg["boards"]))
pr = fb.pattern_readiness()
check("17 reference pattern readiness map", len(pr["patterns"]) >= 15
      and "unsupported" not in [p["status"] for p in pr["patterns"] if p["pattern"] == "usb_diff_pair"])

# honesty: scope-lite is NEVER marked ready/buildable
check("scope-lite never claimed buildable",
      next(b["readiness"] for b in fam["boards"] if b["name"] == "Scope-lite board") == "unsupported")

# 18. a FL-1 demo board passed (fl1-cal-reference)
RD = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                  "..", "..", "software", "prompt-to-pcb-ui", "public", "runs",
                  "fl1-cal-reference", "data", "last-run.json")
if os.path.exists(RD):
    check("18 FL-1 starter board attempted (passed or honest fail)",
          json.load(open(RD)).get("status") in ("PASSED", "GATE FAILED"))
else:
    check("18 FL-1 starter board attempted", False, "no fl1-cal-reference run")

npass = sum(1 for ok in checks if ok)
print("%d/%d FL-1 board checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
