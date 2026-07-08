"""M7: BGA verified-part sandbox — a REAL verified part, an honest gap."""
import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import chipdown_synthesis as cd  # noqa: E402
import package_families as pf  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")

pins, how = cd.parse_symbol("FPGA_Lattice", "ICE40HX4K-BG121")
fp = os.path.join(pf.FP_SHARE, "Package_BGA.pretty",
                  "BGA-121_9.0x9.0mm_Layout11x11_P0.8mm_Ball0.4mm_Pad0.35mm"
                  "_NSMD.kicad_mod")
pads = set(re.findall(r'\(pad "([A-Z]+\d+)"', open(fp).read()))
balls = {p["number"] for p in pins}
bga = pf.bga_model(fp)
pwr = [p for p in pins if p["etype"] == "power_in"]
# escape feasibility: ring analysis of an 11x11 full array
rows = "ABCDEFGHJKL"
ring = {}
for b in sorted(balls):
    m = re.match(r"([A-Z])(\d+)$", b)
    r, c = rows.index(m.group(1)), int(m.group(2)) - 1
    ring[b] = min(r, c, 10 - r, 10 - c)
outer2 = sum(1 for v in ring.values() if v <= 1)
interior = len(ring) - outer2

out = {
    "version": "v1", "milestone": "M7 BGA Verified-Part Sandbox",
    "verified_part": {
        "part": "iCE40HX4K-BG121 (Lattice FPGA)",
        "symbol": "FPGA_Lattice:ICE40HX4K-BG121 (%s)" % how,
        "symbol_pins": len(pins), "footprint_balls": len(pads),
        "symbol_ball_match": balls == pads,
        "power_balls": len(pwr), "pitch_mm": bga["pitch_mm"],
        "array": "11x11 FULL array",
        "state": "symbol_verified + ball_map_parsed + pinout_verified"},
    "escape_feasibility": {
        "outer_two_rings": outer2, "interior_balls": interior,
        "estimate": "outer 2 rings (%d balls) escape on outer layers; the "
                    "%d interior balls need dogbone via channels across 4-6 "
                    "layers" % (outer2, interior),
        "via_in_pad_required": bga["via_in_pad_required"],
        "hdi_required": bga["hdi_required"]},
    "sandbox_attempt_allowed": False,
    "exact_gap": "NO BALL-GRID ESCAPE EMITTER: the fanout engine is "
                 "perimeter-only (rows/columns of edge pads); a full-array "
                 "BGA needs interior dogbone channels, layer-assignment, and "
                 "via-in-pad/filled-via manufacturing gates (M8). Attempting "
                 "a route would strand %d interior balls." % interior,
    "verdict": "architecture_only — UPGRADED from 'no verified part' to "
               "'verified part exists, emitter gap exact'",
    "blocked_claims": ["BGA routing support", "DDR", "PCIe", "high-speed",
                       "HDI/microvia", "X-ray/assembly/yield",
                       "FPGA functionality"],
    "no_fake": "no sandbox run was attempted; no primitive was faked"}
for r in ["fl1-backplane-v1", "bare-mcu-qfn56-core-sandbox-v1"]:
    d = os.path.join(RUNS, r, "data")
    json.dump(out, open(os.path.join(
        d, "compose-m7-bga-verified-part-report.json"), "w"), indent=1)
print("iCE40HX4K-BG121: %d pins == %d balls: %s | interior %d -> %s" %
      (len(pins), len(pads), balls == pads, interior, out["verdict"][:30]))
