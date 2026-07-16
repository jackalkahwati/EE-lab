#!/usr/bin/env python3
"""Freeze a compose block's internal routing (density program).

Runs the block IN ISOLATION through the exact production chain — compose ->
export_dsn -> flroute -> import_ses -> stitch_pads -> kicad-cli DRC — then
extracts the copper belonging to the block's internal nets and stores it as a
block-local template in hardware/blocks/routes/<key>.json. At compose time
the template is transposed to wherever the block lands, flroute treats it as
fixed net-owned copper (v5 wiring cells) and skips those nets, and the
whole-board DRC re-verifies it in context on every board.

A template is only written when the isolation board's DRC is CLEAN — frozen
copper must be proven, not hopeful.

Run under KiCad's python (pcbnew needed):
  KPY freeze_routes.py esp32c3 [morekeys...]
"""
import json
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
BLOCKS = os.path.join(REPO, "hardware", "blocks")
SCRIPTS = os.path.join(REPO, "software", "prompt-to-pcb-ui", "scripts")
FLROUTE = os.path.join(REPO, "hardware", "pcba-rev-a", "tools", "flroute",
                       "target", "release", "flroute")
KCLI = os.environ.get("FL_KICAD_CLI",
                      "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli")
KPY = sys.executable  # we ARE KiCad's python
ROUTES_DIR = os.path.join(BLOCKS, "routes")

# nets that are never block-internal: global rails (zone-served) and the
# shared inter-block buses the MCU allocates
GLOBAL_NETS = {"", "GND", "+3V3", "+5V"}
SHARED_PAT = re.compile(r"^(I2C_|SPI_|UART_|GPS_|CELL_|CAN_|MOTOR|GPIO|GP1[0-3]|"
                        r"STEP$|DIR$|MOT_EN$|FAULT$|INTERLOCK$|RST_OUT$|TRIG$|ID_A)")


def run(argv, **kw):
    p = subprocess.run(argv, capture_output=True, text=True, timeout=600, **kw)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def freeze(key):
    wd = tempfile.mkdtemp(prefix="freeze-%s-" % key)
    board = os.path.join(wd, "iso.kicad_pcb")
    spec = os.path.join(wd, "spec.json")
    # 'standalone' suppresses the MCU/power auto-add so the board is JUST the
    # block — its internal nets are exactly what we want to freeze
    json.dump({"blocks": [key, "standalone"]}, open(spec, "w"))
    code, out = run([KPY, os.path.join(BLOCKS, "compose.py"), spec, board])
    if code != 0:
        return {"key": key, "error": "compose failed: %s" % out[-160:]}
    m = [json.loads(l.split(":", 1)[1]) for l in out.splitlines()
         if l.startswith("BLOCK_AT:")]
    origin = next(((b["x"], b["y"]) for b in m if b["key"] == key), None)
    if not origin:
        return {"key": key, "error": "no BLOCK_AT for key"}

    dsn, ses = os.path.join(wd, "iso.dsn"), os.path.join(wd, "iso.ses")
    code, out = run([KPY, os.path.join(SCRIPTS, "export_dsn.py"), board, dsn])
    if "DSN export OK" not in out and code != 0:
        return {"key": key, "error": "dsn export failed"}
    zone_nets = re.search(r"^ZONE_NETS:(.*)$", out, re.M)
    skip = []
    for n in (zone_nets.group(1).split(",") if zone_nets else []):
        if n:
            skip += ["--skip-net", n]
    code, out = run([FLROUTE, dsn, ses] + skip,
                    cwd=os.path.join(REPO, "hardware", "pcba-rev-a"))
    if code != 0 or not os.path.exists(ses):
        return {"key": key, "error": "flroute failed: %s" % out[-160:]}
    code, out = run([KPY, os.path.join(SCRIPTS, "import_ses.py"), board, ses])
    if "IMPORT_OK" not in out and code != 0:
        return {"key": key, "error": "ses import failed"}
    run([KPY, os.path.join(SCRIPTS, "stitch_pads.py"), board])

    # same auto-heal as prod: first DRC feeds stitch_to_plane (vias from
    # zone-served pads into their plane), then gate on the healed re-DRC
    drc = os.path.join(wd, "drc.json")
    run([KCLI, "pcb", "drc", "--output", drc, "--format", "json",
         "--severity-error", board])
    run([KPY, os.path.join(SCRIPTS, "stitch_to_plane.py"), board, drc])
    run([KCLI, "pcb", "drc", "--output", drc, "--format", "json",
         "--severity-error", board])
    try:
        rep = json.load(open(drc))
        hard = [v for v in rep.get("violations", [])
                if v.get("severity") == "error"]
        unconnected = rep.get("unconnected_items", [])
    except Exception:
        return {"key": key, "error": "drc unreadable"}
    if hard or unconnected:
        return {"key": key, "error": "isolation DRC not clean: %d errors, %d "
                "unconnected — refusing to freeze" % (len(hard), len(unconnected))}

    # extract copper for block-internal nets, block-local coordinates
    import pcbnew
    b = pcbnew.LoadBoard(board)
    ox, oy = origin
    nets_out = {}
    for t in b.GetTracks():
        net = str(t.GetNetname()).strip()
        if net in GLOBAL_NETS or SHARED_PAT.match(net):
            continue
        geo = nets_out.setdefault(net, {"segments_mm": [], "vias_mm": [],
                                        "width_mm": 0.25})
        if t.GetClass() == "PCB_VIA":
            pos = t.GetPosition()
            geo["vias_mm"].append([round(pcbnew.ToMM(pos.x) - ox, 4),
                                   round(pcbnew.ToMM(pos.y) - oy, 4)])
        else:
            s, e = t.GetStart(), t.GetEnd()
            lname = b.GetLayerName(t.GetLayer())
            geo["segments_mm"].append([
                round(pcbnew.ToMM(s.x) - ox, 4), round(pcbnew.ToMM(s.y) - oy, 4),
                round(pcbnew.ToMM(e.x) - ox, 4), round(pcbnew.ToMM(e.y) - oy, 4),
                lname, round(pcbnew.ToMM(t.GetWidth()), 3)])
    nets_out = {k: v for k, v in nets_out.items()
                if v["segments_mm"] or v["vias_mm"]}
    if not nets_out:
        return {"key": key, "error": "no internal-net copper to freeze"}
    os.makedirs(ROUTES_DIR, exist_ok=True)
    tpl = {"key": key, "provenance": {
        "frozenFrom": "isolation route + clean DRC",
        "router": "flroute", "drcErrors": 0}, "nets": nets_out}
    json.dump(tpl, open(os.path.join(ROUTES_DIR, key + ".json"), "w"), indent=1)
    nseg = sum(len(v["segments_mm"]) for v in nets_out.values())
    return {"key": key, "frozen": sorted(nets_out), "segments": nseg}


def main():
    keys = sys.argv[1:]
    if not keys:
        print(__doc__)
        return 2
    for k in keys:
        print(json.dumps(freeze(k)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
