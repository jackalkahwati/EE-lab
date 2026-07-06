"""Recovery regression (Phase 10 items 7-8, 11) — fast unit checks over the
taxonomy + strategy library + loop logic, using real saved DRC evidence. The
full end-to-end loop (4 pipeline runs) is exercised by recovery_loop.py directly.

  python3 test_recovery.py
"""
import glob
import json
import os
import sys

import failure_taxonomy as ftax
import recovery_strategies as rstrat
from recovery_loop import _score

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


RUNS = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    "..", "..", "software", "prompt-to-pcb-ui", "public", "runs")

# 7. the ADS1115 fine-pitch clearance is classified as a fine-pitch escape
d = sorted(glob.glob(os.path.join(RUNS, "run-fl1meas-*", "data", "drc.json")))
if d:
    drc = json.load(open(d[-1]))
    res = {"drc": drc, "unconnected": 0, "fine_pitch_refs": ["U2"],
           "devices": [{"ref": "U2", "footprint": "TSSOP-10_3x3mm_P0.5mm"}]}
    fails = ftax.classify(res)
    check("7 ADS1115 -> fine_pitch_escape",
          any(f["type"] == ftax.FINE_PITCH_ESCAPE for f in fails),
          "types=%s" % [f["type"] for f in fails])
else:
    check("7 ADS1115 -> fine_pitch_escape", False, "no run-fl1meas drc found")

# 8. an unconnected failure on a WROOM module -> keepout_placement
esp = {"drc": {"violations": [], "unconnected_items": [
        {"description": "Pad 12 [I2C_SDA] of U1"}]},
       "unconnected": 3,
       "devices": [{"ref": "U1", "footprint": "ESP32-S3-WROOM-1"}]}
ef = ftax.classify(esp)
check("8 ESP32 WROOM unconnected -> keepout_placement",
      any(f["type"] == ftax.KEEPOUT_PLACEMENT for f in ef),
      "types=%s" % [f["type"] for f in ef])

# strategy ranking ends in an honest mark_unsupported, never a fake pass
plans = rstrat.rank([{"type": ftax.FINE_PITCH_ESCAPE, "severity": "high",
                      "components": ["U2"], "nets": [], "auto_recovery": True}])
check("ranking ends in mark_unsupported",
      plans and plans[-1]["strategy"] == "mark_unsupported",
      "plan=%s" % [p["strategy"] for p in plans])

# fine-pitch maps to the right Phase-8 capability
check("phase8 capability for fine-pitch",
      rstrat.phase8_capability(ftax.FINE_PITCH_ESCAPE) == "fine-pitch fanout / escape routing")

# compare-and-revert: a worse result never beats the best (honesty of the loop)
best = {"status": "GATE FAILED", "violations": 1, "unconnected": 0}
worse = {"status": "GATE FAILED", "violations": 3, "unconnected": 0}
check("compare-and-revert: worse never kept", _score(worse) > _score(best))

# a real recovery-loop report was produced for the ADS1115 case
rep = sorted(glob.glob(os.path.join(RUNS, "fl1meas-rec*-a*", "data", "recovery-loop.json")))
check("11 recovery report generated", bool(rep),
      os.path.basename(os.path.dirname(os.path.dirname(rep[-1]))) if rep else "none")

npass = sum(1 for ok in checks if ok)
print("%d/%d recovery checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
