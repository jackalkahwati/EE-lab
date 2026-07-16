"""M3A — deterministic flroute fixture definitions + board builder.

Each fixture is a machine-readable spec that builds a REAL tiny KiCad board
(pcbnew), so every run exercises the actual toolchain path:
    build -> export_dsn -> flroute -> import_ses -> connectivity -> DRC.
Expected failures are first-class: a fixture that SHOULD fail passes the
harness only when flroute fails honestly (open net reported, no fake copper).

Run under kipython. No fixture success implies physical validation.
"""
import os
import sys

import pcbnew

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import toolchain  # noqa: E402

FP_SHARE = toolchain.kicad_footprints()
MM = pcbnew.FromMM


def _pad(board, ref, x, y, net, tht=False):
    name = ("TestPoint_THTPad_D1.5mm_Drill0.7mm" if tht
            else "TestPoint_Pad_D1.5mm")
    fp = pcbnew.FootprintLoad(os.path.join(FP_SHARE, "TestPoint.pretty"), name)
    fp.SetReference(ref)
    fp.SetPosition(pcbnew.VECTOR2I(MM(x), MM(y)))
    for p in fp.Pads():
        p.SetNet(net)
    board.Add(fp)


def _track(board, net, x0, y0, x1, y1, w=0.5, layer=pcbnew.F_Cu):
    t = pcbnew.PCB_TRACK(board)
    t.SetStart(pcbnew.VECTOR2I(MM(x0), MM(y0)))
    t.SetEnd(pcbnew.VECTOR2I(MM(x1), MM(y1)))
    t.SetWidth(MM(w))
    t.SetLayer(layer)
    t.SetNet(net)
    board.Add(t)


def _keepout(board, x0, y0, x1, y1):
    z = pcbnew.ZONE(board)
    z.SetIsRuleArea(True)
    z.SetDoNotAllowTracks(True)
    z.SetDoNotAllowVias(True)
    z.SetLayer(pcbnew.F_Cu)
    ls = pcbnew.LSET()
    ls.AddLayer(pcbnew.F_Cu)
    ls.AddLayer(pcbnew.B_Cu)
    z.SetLayerSet(ls)
    pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    z.Outline().NewOutline()
    for x, y in pts:
        z.Outline().Append(MM(x), MM(y))
    board.Add(z)


def build(fix, out_path):
    """Build the fixture board and save. Returns net names of interest."""
    board = pcbnew.CreateEmptyBoard()
    board.GetDesignSettings().SetCopperLayerCount(fix.get("layers", 2))
    w, h = fix.get("size", (30, 20))
    # outline
    for a, b in [((0, 0), (w, 0)), ((w, 0), (w, h)), ((w, h), (0, h)),
                 ((0, h), (0, 0))]:
        seg = pcbnew.PCB_SHAPE(board)
        seg.SetShape(pcbnew.SHAPE_T_SEGMENT)
        seg.SetStart(pcbnew.VECTOR2I(MM(a[0]), MM(a[1])))
        seg.SetEnd(pcbnew.VECTOR2I(MM(b[0]), MM(b[1])))
        seg.SetLayer(pcbnew.Edge_Cuts)
        seg.SetWidth(MM(0.1))
        board.Add(seg)
    nets = {}
    for name in fix["nets"]:
        ni = pcbnew.NETINFO_ITEM(board, name)
        board.Add(ni)
        nets[name] = ni
    ref = [0]
    for (net, x, y) in fix["pads"]:
        ref[0] += 1
        _pad(board, "TP%d" % ref[0], x, y, nets[net],
             tht=fix.get("tht_pads", False))
    for ob in fix.get("obstacle_tracks", []):
        net, x0, y0, x1, y1 = ob[:5]
        _track(board, nets[net], x0, y0, x1, y1,
               w=(ob[5] if len(ob) > 5 else 0.5))
    for ko in fix.get("keepouts", []):
        _keepout(board, *ko)
    board.Save(out_path)
    return fix["nets"]


# ---------------------------------------------------------------------------
# fixture definitions — deterministic, machine-readable
# ---------------------------------------------------------------------------
CORE = [
 {"fixture_id": "single_net_direct", "type": "synthetic_unit",
  "purpose": "one net, two pads, clear path",
  "expected_result": "should_route", "layers": 2, "nets": ["N1"],
  "pads": [("N1", 5, 10), ("N1", 25, 10)]},
 {"fixture_id": "two_nets_non_intersecting", "type": "synthetic_unit",
  "purpose": "two parallel nets, no crossing",
  "expected_result": "should_route", "layers": 2, "nets": ["N1", "N2"],
  "pads": [("N1", 5, 6), ("N1", 25, 6), ("N2", 5, 14), ("N2", 25, 14)]},
 {"fixture_id": "two_nets_crossing_requires_via", "type": "synthetic_unit",
  "purpose": "X crossing — one net must change layer",
  "expected_result": "should_route", "layers": 2, "nets": ["N1", "N2"],
  "pads": [("N1", 5, 5), ("N1", 25, 15), ("N2", 5, 15), ("N2", 25, 5)],
  "expect_via_min": 0},
 {"fixture_id": "obstacle_avoidance", "type": "synthetic_unit",
  "purpose": "route around a foreign-net copper bar",
  "expected_result": "should_route", "layers": 2,
  "nets": ["N1", "OBS"],
  "pads": [("N1", 5, 10), ("N1", 25, 10), ("OBS", 15, 3), ("OBS", 15, 17)],
  "obstacle_tracks": [("OBS", 15, 3, 15, 17, 1.0)]},
 {"fixture_id": "impossible_blocked_path", "type": "expected_failure",
  "purpose": "pad sealed inside a keepout ring — must fail honestly",
  "expected_result": "should_fail", "layers": 2, "nets": ["N1"],
  "pads": [("N1", 15, 10), ("N1", 27, 10)],
  "keepouts": [(11, 6, 19, 7), (11, 13, 19, 14), (11, 7, 12, 13),
               (18, 7, 19, 13)],
  "expected_failure_reason": "target unreachable inside keepout ring"},
 {"fixture_id": "pad_clearance", "type": "synthetic_unit",
  "purpose": "route past an unrelated pad without violating clearance",
  "expected_result": "should_route", "layers": 2, "nets": ["N1", "N2"],
  "pads": [("N1", 5, 10), ("N1", 25, 10), ("N2", 15, 10.9)],
  "drc_required": True},
 {"fixture_id": "keepout_respected", "type": "synthetic_unit",
  "purpose": "legal detour exists around a keepout block",
  "expected_result": "should_route", "layers": 2, "nets": ["N1"],
  "pads": [("N1", 5, 10), ("N1", 25, 10)],
  "keepouts": [(13, 5, 17, 15)], "drc_required": True},
 {"fixture_id": "no_short_between_nets", "type": "synthetic_stress",
  "purpose": "dense two-net weave — no shorts allowed",
  "expected_result": "should_route", "layers": 2, "nets": ["N1", "N2"],
  "pads": [("N1", 5, 8), ("N1", 25, 12), ("N2", 5, 12), ("N2", 25, 8)],
  "drc_required": True},
 {"fixture_id": "open_net_reported", "type": "expected_failure",
  "purpose": "island pad with zero legal exits — open net must be visible",
  "expected_result": "should_fail", "layers": 2, "nets": ["N1"],
  "pads": [("N1", 15, 10), ("N1", 27, 17)],
  "keepouts": [(12.5, 7.5, 17.5, 8.5), (12.5, 11.5, 17.5, 12.5),
               (12.5, 8.5, 13.5, 11.5), (16.5, 8.5, 17.5, 11.5)],
  "expected_failure_reason": "open net must appear in failed list"},
 {"fixture_id": "multi_layer_route", "type": "synthetic_unit",
  "purpose": "F.Cu wall forces the route to another layer",
  "expected_result": "should_route", "layers": 2, "nets": ["N1", "WALL"],
  "tht_pads": True,
  "pads": [("N1", 5, 10), ("N1", 25, 10), ("WALL", 15, 2), ("WALL", 15, 18)],
  "obstacle_tracks": [("WALL", 15, 2, 15, 18, 2.0)],
  "expect_via_min": 0},
 {"fixture_id": "two_layer_no_internal_layers", "type": "import_export",
  "purpose": "2-layer profile must emit no In1/In2 copper",
  "expected_result": "should_route", "layers": 2, "nets": ["N1", "N2"],
  "pads": [("N1", 5, 6), ("N1", 25, 6), ("N2", 5, 14), ("N2", 25, 14)],
  "assert_no_inner_layers": True},
 {"fixture_id": "four_layer_internal_allowed", "type": "import_export",
  "purpose": "4-layer profile: inner layers legal per policy",
  "expected_result": "should_route", "layers": 4, "nets": ["N1", "N2"],
  "tht_pads": True,
  "pads": [("N1", 5, 5), ("N1", 25, 15), ("N2", 5, 15), ("N2", 25, 5)]},
 {"fixture_id": "narrow_channel", "type": "synthetic_stress",
  "purpose": "channel at the legal limit (1.0mm gap for 0.2 track + 2x0.2 "
             "clearance + margin)",
  "expected_result": "should_route", "layers": 2, "nets": ["N1"],
  "pads": [("N1", 5, 10), ("N1", 25, 10)],
  "keepouts": [(13, 4, 17, 9.4), (13, 10.6, 17, 16)], "drc_required": True},
 {"fixture_id": "too_narrow_channel", "type": "expected_failure",
  "purpose": "0.3mm gap is below track+clearance — must fail honestly, "
             "with the only alternate paths sealed",
  "expected_result": "should_fail", "layers": 2, "nets": ["N1"],
  "pads": [("N1", 15, 10), ("N1", 27, 10)],
  "keepouts": [(11, 6, 19, 9.85), (11, 10.15, 19, 14), (11, 9.85, 12, 10.15)],
  "expected_failure_reason": "channel below minimum track+clearance"},
]

# fanout/escape fixtures replay REAL escape machinery on real footprints; the
# harness runs fine_pitch_fanout before export (flag "run_fanout")
FANOUT = [
 {"fixture_id": "qfn_corner_escape_simple", "type": "fanout_escape",
  "purpose": "few wired pins near one QFN corner",
  "expected_result": "should_route", "layers": 4, "run_fanout": True,
  "qfn": {"at": (30, 24), "wire_pins": {"2": "S1", "3": "S2", "56": "S3"}},
  "nets": ["S1", "S2", "S3"],
  "pads": [("S1", 55, 8), ("S2", 55, 14), ("S3", 55, 20)],
  "size": (70, 62), "drc_required": True},
 {"fixture_id": "qfn_side_escape_dense", "type": "fanout_escape",
  "purpose": "8 contiguous wired pins on one side (bottom row)",
  "expected_result": "should_route", "layers": 4, "run_fanout": True,
  "qfn": {"at": (30, 24), "wire_pins": {str(n): "D%d" % i for i, n in
                                        enumerate(range(15, 23))}},
  "nets": ["D%d" % i for i in range(8)],
  "pads": [("D%d" % i, 60, 6 + 4 * i) for i in range(8)],
  "size": (74, 62), "drc_required": True},
 {"fixture_id": "qfn_escape_stub_vs_stub", "type": "regression_from_bug",
  "purpose": "adjacent-pin stubs at 0.4mm pitch must not collide "
             "(residual-risk fixture)",
  "expected_result": "should_route", "layers": 4, "run_fanout": True,
  "qfn": {"at": (30, 24), "wire_pins": {"15": "A0", "16": "A1", "17": "A2",
                                        "18": "A3"}},
  "nets": ["A0", "A1", "A2", "A3"],
  "pads": [("A%d" % i, 58, 8 + 5 * i) for i in range(4)],
  "size": (70, 62), "drc_required": True},
 {"fixture_id": "qfn_escape_interleaved_dogbones", "type": "fanout_escape",
  "purpose": "plane pins interleaved with signals (zone dive + signal lanes)",
  "expected_result": "should_route", "layers": 4, "run_fanout": True,
  "qfn": {"at": (30, 24), "wire_pins": {"33": "+3V3", "34": "S1", "42": "GND",
                                        "41": "S2"}},
  "nets": ["S1", "S2", "+3V3", "GND"],
  "pads": [("S1", 58, 10), ("S2", 58, 16), ("+3V3", 58, 22), ("GND", 58, 28)],
  "tht_pads": True,
  "zones": True, "size": (72, 62), "drc_required": True},
 {"fixture_id": "bme280_like_lga_escape", "type": "fanout_escape",
  "purpose": "LGA-8 0.65mm full escape (BME280 class)",
  "expected_result": "should_route", "layers": 4, "run_fanout": True,
  "lga": {"at": (22, 20), "wire_all": True},
  "nets": ["L%d" % i for i in range(1, 9)],
  "pads": [("L%d" % i, 44, 4 + 3.8 * i) for i in range(1, 9)],
  "size": (58, 48), "drc_required": True},
 {"fixture_id": "rp2040_like_qfn56_reduced", "type": "realboard_reduced",
  "purpose": "QFN-56 core-subsystem pin set (QSPI+XIN/XOUT+SWD+RUN)",
  "expected_result": "should_route", "layers": 4, "run_fanout": True,
  "qfn": {"at": (32, 28), "wire_pins": {"51": "Q3", "52": "QCK", "53": "Q0",
                                        "54": "Q2", "55": "Q1", "56": "QSS",
                                        "20": "XI", "21": "XO", "24": "SWC",
                                        "25": "SWD", "26": "RUN"}},
  "nets": ["Q0", "Q1", "Q2", "Q3", "QCK", "QSS", "XI", "XO", "SWC", "SWD",
           "RUN"],
  "pads": [("Q0", 62, 4), ("Q1", 62, 9), ("Q2", 62, 14), ("Q3", 62, 19),
           ("QCK", 62, 24), ("QSS", 62, 29), ("XI", 62, 34), ("XO", 62, 39),
           ("SWC", 4, 60), ("SWD", 14, 60), ("RUN", 24, 60)],
  "size": (74, 68), "drc_required": True},
 {"fixture_id": "rp2040_like_qfn56_stress", "type": "synthetic_stress",
  "purpose": "24 wired QFN pins across all four sides — may fail; must "
             "report trapped pins honestly",
  "expected_result": "partial_expected", "layers": 4, "run_fanout": True,
  "qfn": {"at": (36, 32),
          "wire_pins": {str(n): "G%d" % n for n in
                        [2, 3, 4, 5, 6, 11, 12, 13, 15, 16, 17, 18, 27, 28,
                         29, 30, 34, 35, 36, 37, 51, 52, 53, 54]}},
  "nets": ["G%d" % n for n in [2, 3, 4, 5, 6, 11, 12, 13, 15, 16, 17, 18,
                               27, 28, 29, 30, 34, 35, 36, 37, 51, 52, 53,
                               54]],
  "pads": [("G%d" % n, 74, 3 + i * 3.0) for i, n in enumerate(
      [2, 3, 4, 5, 6, 11, 12, 13, 15, 16, 17, 18, 27, 28, 29, 30, 34, 35,
       36, 37, 51, 52, 53, 54])],
  "size": (86, 84)},
]


# M7R — BGA escape-gap fixtures. There is NO ball-grid escape emitter; these
# fixtures pin that gap down with real routing evidence instead of prose.
# Replay finding (downgrades the M7 draft estimate): at the proven fab class
# (0.2 track + 2x0.13 clearance = 0.46mm) a track cannot pass between ring-0
# balls (0.45mm gap at 0.8mm pitch / 0.35mm pads) — so only TRUE perimeter
# (ring-0) balls escape by plain routing; ring-1 is already trapped, not just
# the interior. The draft said "outer two rings escape"; the router says no.
BGA_FIXTURES = [
 {"fixture_id": "bga121_ring0_escape", "type": "bga_escape_gap",
  "purpose": "M7R: true perimeter (ring-0) balls of a full-array BGA-121 "
             "escape with plain routing (no emitter involved)",
  "expected_result": "should_route", "layers": 4,
  "bga": {"at": (30, 24), "wire_pins": {"A3": "O1", "L6": "O2",
                                        "F11": "O3", "H1": "O4"}},
  "nets": ["O1", "O2", "O3", "O4"],
  "pads": [("O1", 55, 8), ("O2", 55, 16), ("O3", 55, 24), ("O4", 55, 32)],
  "size": (70, 56), "drc_required": True},
 {"fixture_id": "bga121_ring1_trapped", "type": "bga_escape_gap",
  "purpose": "M7R replay finding: a single ring-1 ball cannot pass between "
             "ring-0 balls at the proven fab class — trapped even with the "
             "rest of the array unwired",
  "expected_result": "should_fail", "layers": 4,
  "bga": {"at": (30, 24), "wire_pins": {"B2": "R1"}},
  "nets": ["R1"],
  "pads": [("R1", 55, 12)],
  "size": (70, 56), "drc_required": True,
  "expected_failure_reason": "0.45mm ball gap < 0.46mm track+clearance; "
                             "needs dogbone via or finer fab class"},
 {"fixture_id": "bga121_interior_ball_no_emitter", "type": "bga_escape_gap",
  "purpose": "M7R: interior balls (ring>=2) of a full-array BGA-121 — no "
             "ball-grid escape emitter exists; failure must be honest and "
             "visible",
  "expected_result": "should_fail", "layers": 4,
  "bga": {"at": (30, 24), "wire_pins": {"F6": "I1", "D8": "I2"}},
  "nets": ["I1", "I2"],
  "pads": [("I1", 55, 12), ("I2", 55, 28)],
  "size": (70, 56), "drc_required": True,
  "expected_failure_reason": "interior balls unreachable without dogbone "
                             "via channels (no BGA escape emitter)"},
]


def build_fanout_board(fix, out_path):
    """Fanout fixtures place a REAL fine-pitch footprint with wired pins."""
    board = pcbnew.CreateEmptyBoard()
    bds = board.GetDesignSettings()
    bds.SetCopperLayerCount(fix.get("layers", 4))
    # fine-pitch fab class IN the board file (compose writes its own setup;
    # CreateEmptyBoard defaults reject 0.4/0.2 dive vias + 0.2mm stub gaps)
    bds.m_MinThroughDrill = MM(0.2)
    bds.m_ViasMinSize = MM(0.35)
    bds.m_MinClearance = MM(0.13)
    bds.m_MinThroughDrill = MM(0.2)
    bds.m_HoleClearance = MM(0.2)
    w, h = fix.get("size", (60, 45))
    for a, b in [((0, 0), (w, 0)), ((w, 0), (w, h)), ((w, h), (0, h)),
                 ((0, h), (0, 0))]:
        seg = pcbnew.PCB_SHAPE(board)
        seg.SetShape(pcbnew.SHAPE_T_SEGMENT)
        seg.SetStart(pcbnew.VECTOR2I(MM(a[0]), MM(a[1])))
        seg.SetEnd(pcbnew.VECTOR2I(MM(b[0]), MM(b[1])))
        seg.SetLayer(pcbnew.Edge_Cuts)
        seg.SetWidth(MM(0.1))
        board.Add(seg)
    nets = {}
    for name in fix["nets"]:
        ni = pcbnew.NETINFO_ITEM(board, name)
        board.Add(ni)
        nets[name] = ni
    if fix.get("zones"):
        for zn in ("+3V3", "GND"):
            if zn not in nets:
                ni = pcbnew.NETINFO_ITEM(board, zn)
                board.Add(ni)
                nets[zn] = ni
    if "qfn" in fix:
        fp = pcbnew.FootprintLoad(
            os.path.join(FP_SHARE, "Package_DFN_QFN.pretty"),
            "QFN-56-1EP_7x7mm_P0.4mm_EP3.2x3.2mm")
        fp.SetReference("U1")
        at = fix["qfn"]["at"]
        fp.SetPosition(pcbnew.VECTOR2I(MM(at[0]), MM(at[1])))
        for p in fp.Pads():
            n = fix["qfn"]["wire_pins"].get(p.GetPadName())
            if n:
                p.SetNet(nets[n])
        board.Add(fp)
    if "bga" in fix:
        fp = pcbnew.FootprintLoad(
            os.path.join(FP_SHARE, "Package_BGA.pretty"),
            "BGA-121_9.0x9.0mm_Layout11x11_P0.8mm_Ball0.4mm_Pad0.35mm_NSMD")
        fp.SetReference("U1")
        at = fix["bga"]["at"]
        fp.SetPosition(pcbnew.VECTOR2I(MM(at[0]), MM(at[1])))
        for p in fp.Pads():
            n = fix["bga"]["wire_pins"].get(p.GetPadName())
            if n:
                p.SetNet(nets[n])
        board.Add(fp)
    if "lga" in fix:
        fp = pcbnew.FootprintLoad(
            os.path.join(FP_SHARE, "Package_LGA.pretty"),
            "Bosch_LGA-8_2.5x2.5mm_P0.65mm_ClockwisePinNumbering")
        fp.SetReference("U1")
        at = fix["lga"]["at"]
        fp.SetPosition(pcbnew.VECTOR2I(MM(at[0]), MM(at[1])))
        for p in fp.Pads():
            board_net = "L%s" % p.GetPadName()
            if board_net in nets:
                p.SetNet(nets[board_net])
        board.Add(fp)
    ref = [0]
    for (net, x, y) in fix["pads"]:
        ref[0] += 1
        _pad(board, "TP%d" % ref[0], x, y, nets[net],
             tht=fix.get("tht_pads", False))
    if fix.get("zones"):
        # GND pour B.Cu + +3V3 pour In2 so plane dives have a landing
        for zn, layer in (("GND", pcbnew.B_Cu),
                          ("+3V3", pcbnew.In2_Cu if
                           fix.get("layers", 4) == 4 else pcbnew.B_Cu)):
            z = pcbnew.ZONE(board)
            z.SetLayer(layer)
            z.SetNet(nets[zn])
            z.Outline().NewOutline()
            for x, y in [(1, 1), (w - 1, 1), (w - 1, h - 1), (1, h - 1)]:
                z.Outline().Append(MM(x), MM(y))
            z.SetPadConnection(pcbnew.ZONE_CONNECTION_THERMAL)
            board.Add(z)
        # NOTE: no build-time fill — ZONE_FILLER at build time aborts in
        # headless kipython (native wx assert); the harness fills after
        # SES import, which is also the pipeline-accurate order
    board.Save(out_path)
    return fix["nets"]
