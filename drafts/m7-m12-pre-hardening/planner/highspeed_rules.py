"""M11 — High-Speed / SI-PI Rules v1. Detection + gates; PCIe/DDR/USB3
remain architecture_only until analysis and routing support exist."""

HS_CLASSES = {
    "PCIe": {"pairs": True, "match_um": 125, "z_diff": 85},
    "USB3": {"pairs": True, "match_um": 150, "z_diff": 90},
    "USB2_FS": {"pairs": True, "match_um": 1250, "z_diff": 90,
                "note": "advisory pads only today; still no compliance claim"},
    "DDR3/4": {"pairs": "addr/data groups", "match_um": 25, "z_diff": 80},
    "MIPI/LVDS": {"pairs": True, "match_um": 100, "z_diff": 100},
}
REQUIRED = ("impedance_stackup", "length_matching_engine",
            "reference_plane_audit", "via_transition_model",
            "external_SI_PI_analysis", "PI_decoupling_network_analysis")
BLOCKED = ["SI_correctness", "PI_correctness", "eye_diagram", "timing_closure",
           "high_speed_validation", "DDR_readiness", "PCIe_readiness",
           "USB3_readiness"]


HS_KEYWORDS = {"PCIe": ["pcie", "pci-e", "pci express"],
               "USB3": ["usb3", "usb 3", "superspeed"],
               "USB2_FS": ["usb2", "usb 2", "usb full speed"],
               "DDR3/4": ["ddr", "sdram", "sodimm"],
               "MIPI/LVDS": ["mipi", "lvds", "csi-2", "dsi"]}


def hs_gate(request):
    t = request.lower()
    hits = [k for k, kws in HS_KEYWORDS.items() if any(w in t for w in kws)]
    if hits:
        return {"verdict": "architecture_only", "classes": hits,
                "missing": list(REQUIRED), "blocked_claims": BLOCKED}
    return {"verdict": "no_high_speed_content"}
