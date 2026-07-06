"""Pipeline step — advanced routing analysis + reports (Phase 9).

Reads the routed board's nets + devices + net classes, builds the advanced-
routing model (diff pairs, keepouts, analog/power rules, impedance plan), and
writes the reports. HONEST: high-speed pairs the v1 router cannot enforce are
reported as unsupported, never as routed/verified; impedance is an estimate that
requires a board-house controlled-impedance stackup.

  <kicad-python3> gen_advanced_routing.py <board.kicad_pcb> <out_dir>

Prints "ADVANCED dp=<n> hs=<n> keepout=<n> analog=<n> power=<n> routable=<bool>"
and, when a required high-speed pair is present, "ADVANCED_UNSUPPORTED:<json>".
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import advanced_constraints as ac  # noqa: E402

import pcbnew  # noqa: E402

board_path, out_dir = sys.argv[1], sys.argv[2]
b = pcbnew.LoadBoard(board_path)
nets = [b.GetNetInfo().GetNetItem(i).GetNetname()
        for i in range(b.GetNetInfo().GetNetCount())]
nets = [n for n in nets if n]


def _load(f, d):
    try:
        return json.load(open(os.path.join(out_dir, f)))
    except Exception:
        return d


devices = _load("devices.json", [])
cons = _load("constraints.json", {})
net_classes = cons.get("class_counts", {})
# intent isn't in the run dir; interface detection works from net names alone
model = ac.build_model(nets, devices, {"capabilities": [], "product_goal": ""},
                       net_classes=net_classes)

json.dump(model, open(os.path.join(out_dir, "advanced-routing-report.json"), "w"), indent=1)
json.dump(model["impedance_plan"]["stackup"],
          open(os.path.join(out_dir, "stackup-plan.json"), "w"), indent=1)
json.dump(model["impedance_plan"],
          open(os.path.join(out_dir, "impedance-plan.json"), "w"), indent=1)

# markdown report
s = model["summary"]
md = ["# Advanced Routing Report\n",
      "**Advanced-routable by v1:** %s\n" % ("yes" if s["advanced_routable"] else
                                             "NO — %s" % ", ".join(s["blockers"])),
      "- diff pairs: %d (high-speed: %d) · keepouts: %d · analog rules: %d · power rules: %d\n"
      % (s["diff_pairs"], s["high_speed_pairs"], s["keepouts"], s["analog_rules"], s["power_rules"])]
if model["differential_pairs"]:
    md.append("### Differential pairs")
    md.append("| Pair | Class | Zdiff | est W/S (mm) | enforcement |")
    md.append("|---|---|---|---|---|")
    for p in model["differential_pairs"]:
        md.append("| %s | %s | %dΩ | %s / %s | %s |" % (p["pair"], p["class"],
                  p["target_impedance_ohm"], p["est_width_mm"], p["est_spacing_mm"], p["enforcement"]))
    md.append("")
if model["unsupported_constraints"]:
    md.append("### Unsupported by the v1 router (honest)")
    for u in model["unsupported_constraints"]:
        md.append("- **%s** (%s): %s" % (u["pair"], u["class"], u["why"]))
    md.append("")
md.append("### Impedance plan (ESTIMATE)")
md.append("- 50Ω single-ended width ≈ %s mm on the default 4-layer FR4 stackup"
          % model["impedance_plan"]["single_ended_50ohm_width_mm"])
md.append("- controlled-impedance quote required: %s"
          % model["impedance_plan"]["controlled_impedance_quote_required"])
md.append("- %s\n" % model["impedance_plan"]["guarantee"])
if model["analog_rules"]:
    md.append("### Analog layout rules\n" +
              "\n".join("- %s (%s): %s" % (r["rule"], r.get("component", ""), r["detail"])
                        for r in model["analog_rules"]) + "\n")
if model["power_rules"]:
    md.append("### Power layout rules\n" +
              "\n".join("- %s: %s" % (r["rule"], r["detail"]) for r in model["power_rules"]) + "\n")
if model["keepouts"]:
    md.append("### Keepouts\n" +
              "\n".join("- %s (%s): %s" % (k["type"], k["component"], k["detail"])
                        for k in model["keepouts"]) + "\n")
open(os.path.join(out_dir, "advanced-routing-report.md"), "w").write("\n".join(md) + "\n")

print("ADVANCED dp=%d hs=%d keepout=%d analog=%d power=%d routable=%s"
      % (s["diff_pairs"], s["high_speed_pairs"], s["keepouts"], s["analog_rules"],
         s["power_rules"], s["advanced_routable"]))
if not s["advanced_routable"]:
    print("ADVANCED_UNSUPPORTED:" + json.dumps({
        "blockers": s["blockers"],
        "constraints": model["unsupported_constraints"]}))
sys.stdout.flush()
