"""Pipeline step — apply Constraint Manager v1 to a composed/synthesized board.

Runs AFTER the board is built (nets exist) and BEFORE routing. It:
  1. reads the board's nets,
  2. builds the constraint model (constraints.py) and writes <board>.constraints.json,
  3. merges per-class KiCad net-settings into the board's .kicad_pro (so KiCad DRC
     and the design carry the classes — real, not cosmetic),
  4. prints a summary + the HONEST unsupported list for the pipeline log.

  <kicad-python3> apply_constraints.py <board.kicad_pcb>

Prints "CONSTRAINTS <n_nets> <n_classes> <n_unsupported>" sentinel + a
"CONSTRAINT_REPORT:{...}" line the pipeline surfaces to the UI.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import constraints  # noqa: E402

import pcbnew  # noqa: E402

board_path = sys.argv[1]
b = pcbnew.LoadBoard(board_path)

net_names = [b.GetNetInfo().GetNetItem(i).GetNetname()
             for i in range(b.GetNetInfo().GetNetCount())]
net_names = [n for n in net_names if n]

bb = b.GetBoardEdgesBoundingBox()
model = constraints.build_model(net_names, {
    "width_mm": round(pcbnew.ToMM(bb.GetWidth()), 1),
    "height_mm": round(pcbnew.ToMM(bb.GetHeight()), 1),
    "layers": b.GetCopperLayerCount(),
})

base = os.path.splitext(board_path)[0]
json.dump(model, open(base + ".constraints.json", "w"), indent=1)

# ---- merge net-classes into the board's .kicad_pro (preserve any finer-via
# class already written by compose/synth for fine-pitch boards) ----------------
pro_path = base + ".kicad_pro"
pro = {}
if os.path.exists(pro_path):
    try:
        pro = json.load(open(pro_path))
    except Exception:
        pro = {}
ns = constraints.kicad_net_settings(model)
pro.setdefault("net_settings", {})
pro["net_settings"]["classes"] = ns["classes"]
pro["net_settings"]["netclass_patterns"] = ns["netclass_patterns"]
pro.setdefault("board", {}).setdefault("design_settings", {}).setdefault("rules", {})
pro.setdefault("meta", {"filename": os.path.basename(base) + ".kicad_pro", "version": 3})
json.dump(pro, open(pro_path, "w"), indent=1)

n_unsup = len(model["unsupported"])
print("CONSTRAINTS %d %d %d" % (model["summary"]["total_nets"],
                                model["summary"]["distinct_classes"], n_unsup))
# a compact report line for the pipeline/UI
print("CONSTRAINT_REPORT:" + json.dumps({
    "class_counts": model["class_counts"],
    "high_current": model["summary"]["has_high_current"],
    "unsupported": [{"net": u["net"], "feature": u["feature"], "why": u["why"],
                     "fallback": u["fallback"]} for u in model["unsupported"]],
    "high_risk": [h["net"] for h in model["high_risk_nets"]],
}))
sys.stdout.flush()
