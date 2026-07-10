"""M8 — HDI / Microvia / Advanced Fabrication v1.

Fabrication-class modeling and GATES. Nothing here makes Compose emit HDI
boards — it makes Compose refuse to pretend it can, with exact requirements
per class. Everything beyond fab_4layer_std is architecture_only until the
emitter/router/fab package prove it.
"""

FAB_PROFILES = {
    "fab_2layer_std": {"layers": 2, "min_track_clear": "0.2/0.2",
                       "min_via": "0.6/0.3", "microvias": False,
                       "state": "PROVEN in sandbox (7 boards + reruns)"},
    "fab_4layer_std": {"layers": 4, "min_track_clear": "0.2/0.13 fine class",
                       "min_via": "0.6/0.3 + 0.4/0.2 fine",
                       "microvias": False,
                       "state": "PROVEN in sandbox (FL-1 family + QFN-56)"},
    "fab_6layer_std": {"layers": 6, "min_track_clear": "0.15/0.15",
                       "min_via": "0.4/0.2", "microvias": False,
                       "state": "architecture_only — emitter/router support "
                                "absent (LAYERS6 stackup not implemented)"},
    "fab_hdi_1_2_1": {"layers": "6-8 (1+N+1 microvia stack)",
                      "microvias": "laser 0.1/0.05, single-hop",
                      "via_in_pad": "filled/capped REQUIRED for BGA<0.8",
                      "state": "architecture_only — no emitter, no router "
                               "layer model, no fab package support"},
    "fab_hdi_2_2_2": {"layers": "8-10 (2+N+2)", "microvias": "stacked",
                      "state": "architecture_only"},
}

REQUIREMENT_TRIGGERS = [
    ("BGA pitch < 0.8mm", "via_in_pad + filled/capped vias", "fab_hdi_1_2_1"),
    ("BGA pitch < 0.65mm", "HDI microvias", "fab_hdi_1_2_1"),
    ("WLCSP any", "HDI likely + assembly yield review", "fab_hdi_1_2_1"),
    ("full-array BGA interior escape", "dogbone channels across 4-6 layers "
     "+ possible via-in-pad", "fab_6layer_std or fab_hdi_1_2_1"),
    (">2 signal layer demand from congestion", "6-layer stackup",
     "fab_6layer_std"),
]


def hdi_check(board):
    """board: {bga_pitch_mm, wlcsp, full_array_bga, congestion_layers}.
    Returns (required_profile, reasons, allowed)."""
    reasons = []
    prof = "fab_4layer_std"
    if board.get("wlcsp"):
        prof = "fab_hdi_1_2_1"
        reasons.append("WLCSP requires HDI-class fabrication")
    p = board.get("bga_pitch_mm")
    if p is not None:
        if p < 0.65:
            prof = "fab_hdi_1_2_1"
            reasons.append("BGA pitch %.2f < 0.65 -> HDI microvias" % p)
        elif p < 0.8:
            prof = "fab_hdi_1_2_1"
            reasons.append("BGA pitch %.2f < 0.8 -> via-in-pad filled/capped" % p)
        elif board.get("full_array_bga"):
            prof = "fab_6layer_std"
            reasons.append("full-array coarse BGA -> 6-layer escape channels")
    if board.get("congestion_layers", 0) > 2:
        prof = "fab_6layer_std" if prof == "fab_4layer_std" else prof
        reasons.append("congestion demands >2 signal layers")
    allowed = FAB_PROFILES[prof]["state"].startswith("PROVEN")
    return prof, reasons, allowed


def gate(board):
    prof, reasons, allowed = hdi_check(board)
    if allowed:
        return {"profile": prof, "verdict": "allowed", "reasons": reasons}
    return {"profile": prof, "verdict": "architecture_only",
            "reasons": reasons,
            "exact_gap": FAB_PROFILES[prof]["state"],
            "blocked_claims": ["HDI readiness", "microvia support",
                               "via-in-pad support", "6-layer emission",
                               "advanced fab cost/yield"]}
