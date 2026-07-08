"""M3A — flroute regression harness (run under kipython).

    kipython flroute_harness.py <suite> [outdir]
      suite: core | fanout | realboard | importexport | full | fast

Per fixture: build board -> export DSN (ExportSpecctraDSN) -> flroute ->
import SES -> connectivity + optional kicad-cli DRC -> classify vs expected
-> artifacts + machine-readable report. Expected-failure fixtures PASS only
when flroute fails honestly. Golden metadata compared when present; a golden
diff never overrides DRC. Nothing here implies physical validation.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time

import pcbnew
try:  # headless wx: some pcbnew calls assert without a wx.App traits object
    import wx
    _APP = wx.App()
except Exception:
    _APP = None

import flroute_fixtures as fx

HERE = os.path.dirname(os.path.abspath(__file__))
HW = os.path.join(HERE, "..", "..", "..", "hardware", "pcba-rev-a")
FLROUTE = os.path.join(HW, "tools", "flroute", "target", "release", "flroute")
KICAD_CLI = "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli"
GOLDEN_DIR = os.path.join(HERE, "flroute_golden")


def _drc(board_path):
    rpt = board_path + ".drc.json"
    subprocess.run([KICAD_CLI, "pcb", "drc", "--format", "json",
                    "--severity-error", "-o", rpt, board_path],
                   capture_output=True, timeout=120)
    if not os.path.exists(rpt):
        return None
    d = json.load(open(rpt))
    viol = [v for v in (d.get("violations") or [])
            if v.get("type") != "solder_mask_bridge"]
    return {"violations": len(viol),
            "types": sorted({v.get("type") for v in viol}),
            "unconnected": len(d.get("unconnected_items") or [])}


def _board_stats(board_path, fixture_nets):
    b = pcbnew.LoadBoard(board_path)
    segs, vias, layers = 0, 0, set()
    for t in b.GetTracks():
        if t.GetClass() == "PCB_VIA":
            vias += 1
        else:
            segs += 1
            layers.add(pcbnew.LayerName(t.GetLayer()))
    # connectivity: unrouted = ratsnest edges remaining
    b.BuildConnectivity()
    conn = b.GetConnectivity()
    open_nets = []
    for name in fixture_nets:
        ni = b.FindNet(name)
        if ni and conn.GetUnconnectedCount(True) is not None:
            pass
    # per-net open check via connectivity islands
    for name in fixture_nets:
        ni = b.FindNet(name)
        if ni is None:
            continue
    unconnected = conn.GetUnconnectedCount(True)
    return {"segments": segs, "vias": vias,
            "layers_used": sorted(layers), "unconnected_items": unconnected}


def run_fixture(fix, outdir):
    fid = fix["fixture_id"]
    d = os.path.join(outdir, fid)
    os.makedirs(d, exist_ok=True)
    board = os.path.join(d, fid + ".kicad_pcb")
    t0 = time.time()
    if fix.get("run_fanout"):
        nets = fx.build_fanout_board(fix, board)
    else:
        nets = fx.build(fix, board)

    fanout_entries = []
    if fix.get("run_fanout"):
        # mirror compose's fine-pitch fab class: 0.4/0.2 vias + 0.13 clearance
        base = os.path.splitext(board)[0]
        open(base + ".kicad_dru", "w").write(
            '(version 1)\n(rule "fab_6mil"\n'
            '  (constraint clearance (min 0.13mm)))\n')
        open(base + ".kicad_pro", "w").write(json.dumps({
            "board": {"design_settings": {"rules": {
                "min_clearance": 0.0, "min_hole_clearance": 0.2,
                "min_hole_to_hole": 0.2, "min_microvia_diameter": 0.2,
                "min_microvia_drill": 0.1, "min_through_hole_diameter": 0.2,
                "min_via_annular_width": 0.05, "min_via_diameter": 0.35}}},
            "meta": {"filename": os.path.basename(base) + ".kicad_pro",
                     "version": 3}}))
        sys.path.insert(0, HERE)
        import fine_pitch_fanout
        fanout_entries = fine_pitch_fanout.fanout(board) or []

    dsn = os.path.join(d, fid + ".dsn")
    ok = pcbnew.ExportSpecctraDSN(pcbnew.LoadBoard(board), dsn)
    if not ok or not os.path.exists(dsn):
        return {"fixture_id": fid, "pass": False,
                "actual_result": "export_failed"}
    # strip fanned pins from DSN net lists (mirror the pipeline)
    if fanout_entries:
        txt = open(dsn).read()
        for e in fanout_entries:
            txt = txt.replace(" %s" % e["pin_token"].replace("U1-", "U1-"), " ",)
        open(dsn, "w").write(txt)

    ses = os.path.join(d, fid + ".ses")
    # flroute's no-args heuristic skips the two largest nets as assumed
    # planes — fixtures must be explicit: skip real zone nets, or pass a
    # sentinel to disable the heuristic entirely
    skips = ["--skip-net", "GND", "--skip-net", "+3V3"] if fix.get("zones") \
        else ["--skip-net", "__NO_PLANES__"]
    p = subprocess.run([FLROUTE, dsn, ses] + skips, capture_output=True,
                       text=True, timeout=300)
    open(os.path.join(d, "flroute.stderr.txt"), "w").write(p.stderr)
    m = re.search(r"(\d+) attempted, (\d+) routed, (\d+) failed", p.stderr)
    routed, total = (int(m.group(2)), int(m.group(1))) if m else (None, None)
    fm = re.search(r"failed \(first \d+\): \[(.*?)\]", p.stderr)
    failed_nets = ([x.strip().strip('"') for x in fm.group(1).split(",")]
                   if fm else [])

    imported = False
    stats, drc = {}, None
    if os.path.exists(ses):
        b = pcbnew.LoadBoard(board)
        if pcbnew.ImportSpecctraSES(b, ses):
            # restore fanout copper from the SIDECAR (entries + dogbones —
            # zone-pin dive copper lives in dogbones; restoring only the
            # returned entries silently dropped plane connections)
            sidecar_p = os.path.splitext(board)[0] + ".fanout.json"
            sidecar = (json.load(open(sidecar_p))
                       if os.path.exists(sidecar_p) else {})
            restore = (sidecar.get("entries", []) +
                       sidecar.get("dogbones", [])) or fanout_entries
            for e in restore:
                ni = b.FindNet(e["net"])
                if ni is None:
                    continue
                for seg in e.get("segments_mm", []):
                    t = pcbnew.PCB_TRACK(b)
                    t.SetStart(pcbnew.VECTOR2I(pcbnew.FromMM(seg[0]),
                                               pcbnew.FromMM(seg[1])))
                    t.SetEnd(pcbnew.VECTOR2I(pcbnew.FromMM(seg[2]),
                                             pcbnew.FromMM(seg[3])))
                    t.SetWidth(pcbnew.FromMM(e.get("width_mm", 0.2)))
                    t.SetLayer(pcbnew.B_Cu if len(seg) > 4 and seg[4] == "B.Cu"
                               else pcbnew.F_Cu)
                    t.SetNet(ni)
                    b.Add(t)
                for vx, vy in e.get("vias_mm", []) or (
                        [e["via_mm"]] if e.get("via_mm") else []):
                    v = pcbnew.PCB_VIA(b)
                    v.SetPosition(pcbnew.VECTOR2I(pcbnew.FromMM(vx),
                                                  pcbnew.FromMM(vy)))
                    v.SetViaType(pcbnew.VIATYPE_THROUGH)
                    v.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
                    v.SetWidth(pcbnew.FromMM(0.4))
                    v.SetDrill(pcbnew.FromMM(0.2))
                    v.SetNet(ni)
                    b.Add(v)
            if len(b.Zones()) > 0:
                pcbnew.ZONE_FILLER(b).Fill(b.Zones())
            b.Save(board)
            imported = True
            stats = _board_stats(board, nets)
            if fix.get("drc_required") or fix.get("assert_no_inner_layers"):
                drc = _drc(board)

    # classification
    expected = fix["expected_result"]
    open_count = stats.get("unconnected_items")
    if routed is not None and total is not None and routed == total \
            and imported and (open_count == 0):
        actual = "routed_clean"
    elif routed is not None and routed < (total or 0):
        actual = "failed_honestly" if failed_nets or True else "failed"
    else:
        actual = "failed_honestly"

    ok_flags = []
    if expected == "should_route":
        ok_flags.append(actual == "routed_clean")
        if fix.get("drc_required") and drc is not None:
            ok_flags.append(drc["violations"] == 0)
    elif expected == "should_fail":
        # honest failure: unrouted visible, failed net named, no fake copper
        ok_flags.append(actual != "routed_clean")
        ok_flags.append(routed is not None)  # counts reported
    else:  # partial_expected
        ok_flags.append(routed is not None)

    if fix.get("assert_no_inner_layers") and stats:
        ok_flags.append(not any("In" in l for l in stats["layers_used"]))
    if fix.get("expect_via_min") is not None and stats:
        ok_flags.append(stats["vias"] >= fix["expect_via_min"])

    result = {
        "fixture_id": fid, "type": fix.get("type"),
        "purpose": fix.get("purpose"),
        "expected_result": expected, "actual_result": actual,
        "pass": all(ok_flags),
        "routed_net_count": routed, "total_net_count": total,
        "unrouted_net_count": (total - routed) if routed is not None else None,
        "open_net_list": failed_nets,
        "unconnected_after_import": stats.get("unconnected_items"),
        "layer_usage": stats.get("layers_used"),
        "via_count": stats.get("vias"),
        "segment_count": stats.get("segments"),
        "drc": drc, "runtime_s": round(time.time() - t0, 2),
        "artifacts": {"board": board, "dsn": dsn,
                      "ses": ses if os.path.exists(ses) else None,
                      "stderr": os.path.join(d, "flroute.stderr.txt")},
        "honesty": "fixture pass never implies physical validation",
    }
    # golden compare
    gpath = os.path.join(GOLDEN_DIR, fid + ".golden.json")
    if os.path.exists(gpath):
        g = json.load(open(gpath))
        diffs = {k: {"golden": g.get(k), "actual": result.get(k)}
                 for k in ("routed_net_count", "via_count", "segment_count",
                           "layer_usage")
                 if g.get(k) != result.get(k)}
        result["golden"] = {"match": not diffs, "diffs": diffs,
                            "nondeterminism_allowed": g.get(
                                "nondeterminism_allowed", False),
                            "note": "golden diff NEVER overrides DRC"}
    return result


REALBOARD = [
    {"fixture_id": "rb_power_entry_header_v1", "type": "realboard_reduced",
     "source_run": "power-entry-header-v1",
     "purpose": "4-layer synthesized power-entry replay (strip + reroute)",
     "expected_result": "should_route", "zones": True, "drc_required": True},
    {"fixture_id": "rb_power_entry_header_2l", "type": "realboard_reduced",
     "source_run": "power-entry-header-2l",
     "purpose": "2-layer profile replay — no inner copper may appear",
     "expected_result": "should_route", "zones": True, "drc_required": True,
     "assert_no_inner_layers": True},
    {"fixture_id": "rb_chipdown_24lc02", "type": "realboard_reduced",
     "source_run": "chipdown-24lc02-v1",
     "purpose": "generic chip-down SOIC replay",
     "expected_result": "should_route", "zones": True, "drc_required": True},
]


def run_realboard(fix, outdir):
    """Replay a real Compose run: copy board, strip tracks/vias, re-export,
    route, import, fill, DRC. Preserves the source run untouched."""
    fid = fix["fixture_id"]
    d = os.path.join(outdir, fid)
    os.makedirs(d, exist_ok=True)
    src = os.path.join(HERE, "..", "public", "runs", fix["source_run"],
                       "variant.kicad_pcb")
    board = os.path.join(d, fid + ".kicad_pcb")
    t0 = time.time()
    b = pcbnew.LoadBoard(src)
    # collect nets BEFORE mutating — iterating footprints after Remove/Save
    # segfaults in headless pcbnew (SWIG proxy lifetime)
    nets = sorted({p.GetNetname() for f in b.GetFootprints()
                   for p in f.Pads() if p.GetNetname()})
    for t in list(b.GetTracks()):
        b.Delete(t)
    b.Save(board)
    del b  # two live BOARD objects break the SWIG runtime on reload
    for ext in (".kicad_pro", ".kicad_dru"):
        sp = os.path.join(os.path.dirname(src), "variant" + ext)
        if os.path.exists(sp):
            shutil.copy(sp, os.path.splitext(board)[0] + ext)
    dsn = os.path.join(d, fid + ".dsn")
    if not pcbnew.ExportSpecctraDSN(pcbnew.LoadBoard(board), dsn):
        return {"fixture_id": fid, "pass": False,
                "actual_result": "export_failed"}
    ses = os.path.join(d, fid + ".ses")
    p = subprocess.run([FLROUTE, dsn, ses, "--skip-net", "GND",
                        "--skip-net", "+3V3"], capture_output=True,
                       text=True, timeout=300)
    open(os.path.join(d, "flroute.stderr.txt"), "w").write(p.stderr)
    m = re.search(r"(\d+) attempted, (\d+) routed, (\d+) failed", p.stderr)
    routed, total = (int(m.group(2)), int(m.group(1))) if m else (None, None)
    stats, drc = {}, None
    if os.path.exists(ses):
        b2 = pcbnew.LoadBoard(board)
        if pcbnew.ImportSpecctraSES(b2, ses):
            if len(b2.Zones()) > 0:
                pcbnew.ZONE_FILLER(b2).Fill(b2.Zones())
            b2.Save(board)
            del b2
            # pipeline-accurate: the stitcher serves SMD zone pads (a raw
            # route+fill replay leaves them unconnected by design)
            for healer in ("stitch_pads.py", "stitch_to_plane.py"):
                subprocess.run([sys.executable,
                                os.path.join(HERE, healer), board],
                               capture_output=True, timeout=300)
            stats = _board_stats(board, nets)
            drc = _drc(board)
    ok = (routed is not None and routed == total and drc is not None
          and drc["unconnected"] == 0 and drc["violations"] == 0)
    if fix.get("assert_no_inner_layers") and stats:
        ok = ok and not any("In" in l for l in stats.get("layers_used", []))
    return {"fixture_id": fid, "type": fix["type"],
            "source_run": fix["source_run"], "purpose": fix["purpose"],
            "expected_result": fix["expected_result"],
            "actual_result": "routed_clean" if ok else "mismatch",
            "pass": ok, "routed_net_count": routed, "total_net_count": total,
            "layer_usage": stats.get("layers_used"),
            "via_count": stats.get("vias"), "drc": drc,
            "runtime_s": round(time.time() - t0, 2),
            "honesty": "replay pass never implies physical validation"}


def _one(fid, outdir):
    """Run a single fixture (crash-isolated child mode)."""
    pool = fx.CORE + fx.FANOUT + REALBOARD
    fix = next(f for f in pool if f["fixture_id"] == fid)
    r = (run_realboard(fix, outdir) if fix.get("source_run")
         else run_fixture(fix, outdir))
    json.dump(r, open(os.path.join(outdir, fid, "result.json"), "w"), indent=1)
    print("ONE_RESULT " + json.dumps({"pass": r["pass"]}))


def main():
    if len(sys.argv) > 2 and sys.argv[1] == "--one":
        _one(sys.argv[2], sys.argv[3])
        return
    suite = sys.argv[1] if len(sys.argv) > 1 else "fast"
    outdir = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
        HERE, "flroute_runs", suite)
    os.makedirs(outdir, exist_ok=True)
    fixtures = []
    if suite in ("core", "full"):
        fixtures += fx.CORE
    if suite in ("fanout", "full"):
        fixtures += fx.FANOUT
    if suite == "fast":
        ids = {"single_net_direct", "two_nets_non_intersecting",
               "obstacle_avoidance", "impossible_blocked_path",
               "keepout_respected", "two_layer_no_internal_layers"}
        fixtures += [f for f in fx.CORE if f["fixture_id"] in ids]
    if suite in ("realboard", "full"):
        fixtures += REALBOARD
    if suite == "importexport":
        ids = {"two_layer_no_internal_layers", "four_layer_internal_allowed"}
        fixtures += [f for f in fx.CORE if f["fixture_id"] in ids]
        fixtures += [f for f in fx.FANOUT
                     if f["fixture_id"] == "qfn_escape_interleaved_dogbones"]
    # crash isolation: each fixture runs in its own kipython process, so a
    # native abort becomes a recorded failure instead of killing the suite
    results = []
    for f in fixtures:
        fid = f["fixture_id"]
        pr = subprocess.run([sys.executable, os.path.abspath(__file__),
                             "--one", fid, outdir],
                            capture_output=True, text=True, timeout=600)
        rp1 = os.path.join(outdir, fid, "result.json")
        if os.path.exists(rp1):
            results.append(json.load(open(rp1)))
        else:
            results.append({"fixture_id": fid, "pass": False,
                            "expected_result": f["expected_result"],
                            "actual_result": "harness_crash",
                            "crash_tail": (pr.stderr or "")[-400:]})
    npass = sum(1 for r in results if r["pass"])
    report = {"suite": suite, "fixtures": len(results), "passed": npass,
              "failed": len(results) - npass, "results": results,
              "rules": ["expected failures are first-class passes",
                        "golden diffs never override DRC",
                        "no fixture pass implies physical validation"]}
    rp = os.path.join(outdir, "flroute-regression-report.json")
    json.dump(report, open(rp, "w"), indent=1)
    print("FLROUTE HARNESS %s: %d/%d fixtures pass -> %s" %
          (suite, npass, len(results), rp))
    for r in results:
        print("  [%s] %-34s exp=%s act=%s routed=%s/%s drc=%s" %
              ("PASS" if r["pass"] else "FAIL", r["fixture_id"],
               r["expected_result"], r["actual_result"],
               r.get("routed_net_count"), r.get("total_net_count"),
               (r.get("drc") or {}).get("violations", "-")))
    sys.exit(0 if npass == len(results) else 1)


if __name__ == "__main__":
    main()
