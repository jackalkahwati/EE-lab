"""Generate the FL-1 machine test plan for a composed board.

Probe points come from the board's REAL pads: for every probe-worthy net
(power rails, one representative per bus, control lines) the generator picks
the largest accessible top-side pad — a connector pin or passive pad beats an
IC pin. FL-1's XY gantry probes component pads directly, so boards carry no
dedicated test-point stubs (which proved to be pure routing burden). Dedicated
TP footprints, if present, are preferred over pads automatically.

Emits fl1-testplan.json: probe map (net -> ref.pad + XY + pad size),
fiducials for vision registration, board outline, safe power-up sequence, and
per-point measurements with pass/fail limits from net-name rules.

  <kicad-python3> gen_testplan.py <board.kicad_pcb> <out.json>

Prints "TESTPLAN <points>" sentinel (KiCad swig teardown may segfault after a
clean save; callers key on the sentinel).
"""
import json
import re
import sys

import pcbnew

board_path, out_path = sys.argv[1], sys.argv[2]
b = pcbnew.LoadBoard(board_path)

edges = b.GetBoardEdgesBoundingBox()
x0, y0 = pcbnew.ToMM(edges.GetLeft()), pcbnew.ToMM(edges.GetTop())


def rel(pos):
    return round(pcbnew.ToMM(pos.x) - x0, 3), round(pcbnew.ToMM(pos.y) - y0, 3)


# ---- collect candidates per net: (is_dedicated_tp, pad_area, ref.pad, x, y, size)
RF_NET = re.compile(r"^(ANT\w*|RF\w*|\w*_RF)$", re.IGNORECASE)
candidates = {}
fiducials = []
for fp in b.GetFootprints():
    ref = fp.GetReference()
    if ref.startswith("FID"):
        x, y = rel(fp.GetPosition())
        fiducials.append({"ref": ref, "x_mm": x, "y_mm": y})
        continue
    is_tp = bool(re.match(r"^TP\d+$", ref))
    for pad in fp.Pads():
        net = pad.GetNetname()
        if not net or RF_NET.match(net):
            continue  # RF probed at the connector with a matched load, never mid-line
        if not pad.IsOnLayer(pcbnew.F_Cu):
            continue  # top-side access only (FL-1 probes from above)
        sz = pad.GetSize()
        area = sz.x * sz.y
        x, y = rel(pad.GetPosition())
        rec = (1 if is_tp else 0, area,
               "%s.%s" % (ref, pad.GetNumber()), x, y,
               round(pcbnew.ToMM(min(sz.x, sz.y)), 2))
        prev = candidates.get(net)
        if prev is None or rec[:2] > prev[:2]:
            candidates[net] = rec


def bus_rep(nets, pattern_order):
    """First present net matching each pattern — one representative per bus."""
    out = []
    for pat in pattern_order:
        for net in sorted(nets):
            if re.match(pat, net):
                out.append(net)
                break
    return out


all_nets = set(candidates)
targets = [n for n in ("+5V", "+3V3", "GND") if n in all_nets]
targets += bus_rep(all_nets, [
    r"^SPI_SCK$", r"^I2C_SDA$", r"^GPS_TX$", r"^CELL_TX$",
    r"^LORA_NSS$", r"^MOTOR1$",
])

test_points = []
for net in targets:
    tp, area, refpad, x, y, min_dim = candidates[net]
    test_points.append({
        "ref": refpad,
        "net": net,
        "x_mm": x,
        "y_mm": y,
        "pad_mm": min_dim,
        "side": "top",
        "dedicated_tp": bool(tp),
    })


def rules_for(net):
    """Measurement + limits by net-name convention."""
    if net == "+5V":
        return [{"type": "dc_voltage", "expect_v": 5.0, "min_v": 4.75, "max_v": 5.25,
                 "when": "after power_up step 1"}]
    if net == "+3V3":
        return [{"type": "dc_voltage", "expect_v": 3.3, "min_v": 3.135, "max_v": 3.465,
                 "when": "after power_up step 2"}]
    if net == "GND":
        return [{"type": "continuity", "to": "chassis GND", "max_ohm": 1.0,
                 "when": "pre-power"}]
    if re.match(r"^(SPI_|I2C_)", net):
        return [
            {"type": "dc_voltage", "min_v": -0.3, "max_v": 3.6, "when": "idle",
             "note": "bus idle level within logic rails"},
            {"type": "digital_activity", "when": "firmware self-test",
             "expect": "toggling", "note": "bus exercised by generated firmware"},
        ]
    if re.match(r"^(GPS_|CELL_)(TX|RX)$", net):
        return [{"type": "digital_activity", "when": "firmware self-test",
                 "expect": "uart_traffic", "baud_hint": 9600}]
    if net.endswith("_NSS") or net.endswith("_RST"):
        return [{"type": "dc_voltage", "min_v": 2.9, "max_v": 3.6, "when": "idle",
                 "note": "active-low control line idles high"}]
    if net.startswith("MOTOR"):
        return [{"type": "dc_voltage", "expect_v": 0.0, "min_v": -0.3, "max_v": 0.5,
                 "when": "boot", "note": "drivers must be off at boot"}]
    return [{"type": "dc_voltage", "min_v": -0.3, "max_v": 5.5, "when": "idle"}]


measurements = []
for tp in test_points:
    for rule in rules_for(tp["net"]):
        m = {"point": tp["ref"], "net": tp["net"]}
        m.update(rule)
        measurements.append(m)

pre_power = [
    {"check": "resistance", "between": [r, "GND"], "min_ohm": 10.0,
     "note": "supply short screen before first power"}
    for r in ("+5V", "+3V3")
    if any(t["net"] == r for t in test_points)
]

plan = {
    "version": 2,
    "generator": "firstlight-compose",
    "board": {
        "width_mm": round(pcbnew.ToMM(edges.GetWidth()), 2),
        "height_mm": round(pcbnew.ToMM(edges.GetHeight()), 2),
        "layers": b.GetCopperLayerCount(),
        "origin": "top-left of board outline, +x right, +y down",
    },
    "probe_strategy": "component pads (FL-1 gantry probes pads directly; "
                      "dedicated TPs used when present)",
    "fiducials": fiducials,
    "test_points": test_points,
    "pre_power": pre_power,
    "power_up": [
        {"step": 1, "action": "apply +5V at inlet", "limit_ma": 500,
         "verify": "+5V rail within limits"},
        {"step": 2, "action": "verify +3V3 regulator output", "limit_ma": 300,
         "verify": "+3V3 rail within limits"},
    ],
    "measurements": measurements,
    "notes": [
        "RF nets carry no probe point by design (probe stub degrades a 50R line); "
        "probe RF at the U.FL connector with a matched load.",
        "sub-1mm pads need the fine pogo cartridge; pad_mm records the probe target size.",
        "digital_activity checks assume the generated firmware self-test image.",
    ],
}

json.dump(plan, open(out_path, "w"), indent=1)
print("TESTPLAN %d" % len(test_points))
