"""Generate the shared-bus report for a run: model the buses from the design and
check them against the realized (routed) board.

  <kicad-python3> gen_shared_bus_report.py <design.json> <board.kicad_pcb> <out_dir>
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import shared_bus  # noqa: E402
import pcbnew  # noqa: E402

design_path, board_path, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
design = json.load(open(design_path))

# net -> [(ref, pad, footprint)] actually on the routed board
b = pcbnew.LoadBoard(board_path)
board_pads = {}
for f in b.GetFootprints():
    ref = f.GetReference()
    fp = str(f.GetFPIDAsString())
    for p in f.Pads():
        net = str(p.GetNetname())
        if net:
            board_pads.setdefault(net, []).append((ref, p.GetPadName(), fp))

report = shared_bus.build_report(design, board_pads=board_pads)
os.makedirs(out_dir, exist_ok=True)
json.dump(report, open(os.path.join(out_dir, "shared-bus-report.json"), "w"), indent=1)

# markdown
lines = ["# Shared-bus report", "",
         "Model version %s - %d bus(es)." % (report["version"], report["bus_count"]), ""]
for bus in report["buses"]:
    lines.append("## %s (%s)" % (bus["name"], bus["type"]))
    lines.append("- source/master: %s" % bus["source"])
    lines.append("- devices (%d): %s" % (bus["device_count"], ", ".join(bus["devices"])))
    lines.append("- topology: %s" % bus["topology"])
    lines.append("- required nets: %s" % ", ".join(bus["required_nets"]))
    if bus.get("pullups"):
        lines.append("- pull-ups: %s on %s (provided by %s)"
                     % (", ".join(bus["pullups"]["nets"]), bus["pullups"]["rail"],
                        bus["pullups"]["provided_by"]))
    if bus.get("addresses"):
        lines.append("- addresses: %s" % json.dumps(bus["addresses"]))
    if bus.get("chip_selects"):
        lines.append("- chip-selects: %s" % json.dumps(bus["chip_selects"]))
    lines.append("- routing status: **%s**" % bus.get("routing_status", "modeled_only"))
    if bus.get("routed_connections"):
        lines.append("- routed connections: %s" % json.dumps(bus["routed_connections"]))
    for p in bus.get("problems", []):
        lines.append("  - [%s] %s: %s" % (p["severity"], p["code"], p["detail"]))
    lines.append("")
open(os.path.join(out_dir, "shared-bus-report.md"), "w").write("\n".join(lines))

for bus in report["buses"]:
    print("BUS %s %s -> %s (%s)" % (bus["name"], bus["type"],
          bus.get("routing_status"), json.dumps(bus.get("routed_connections", {}))))
