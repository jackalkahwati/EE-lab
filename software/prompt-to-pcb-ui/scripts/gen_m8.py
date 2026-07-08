"""M8: HDI/microvia/advanced fabrication gates."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import advanced_fab as af  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")

CASES = {
    "simple 2L power board": {},
    "QFN-56 core (4L)": {},
    "coarse full-array BGA-121 (iCE40)": {"bga_pitch_mm": 0.8,
                                          "full_array_bga": True},
    "fine BGA 0.5mm": {"bga_pitch_mm": 0.5},
    "WLCSP": {"wlcsp": True},
    "congested 3-signal-layer board": {"congestion_layers": 3},
}
out = {"version": "v1", "milestone": "M8 HDI/Microvia/Advanced Fabrication",
       "profiles": af.FAB_PROFILES,
       "requirement_triggers": [{"trigger": t, "requires": r, "profile": p}
                                for t, r, p in af.REQUIREMENT_TRIGGERS],
       "gate_results": {k: af.gate(v) for k, v in CASES.items()},
       "integration": "layer-count planner + package planner consult "
                      "advanced_fab.gate; anything beyond PROVEN 2L/4L "
                      "classes returns architecture_only with the exact gap",
       "honesty": "no HDI/microvia/via-in-pad/6-layer emission exists; "
                  "these gates make Compose REFUSE to pretend otherwise"}
for r in ["fl1-backplane-v1", "bare-mcu-qfn56-core-sandbox-v1"]:
    json.dump(out, open(os.path.join(
        RUNS, r, "data", "compose-m8-advanced-fab-gates.json"), "w"), indent=1)
print({k: v["verdict"] for k, v in out["gate_results"].items()})
