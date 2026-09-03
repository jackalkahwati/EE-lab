#!/usr/bin/env python3
"""PCB manufacturing-process catalog.

The system was rigid-FR4-only. This models the real menu of processes a PCB fab
can make, each with the facts that actually matter downstream: substrate, the
stackup family, the EXTRA fabrication layers it needs (flex coverlay, stiffener,
bend/fold lines, …), the DRC deltas it imposes (min bend radius, no-via-in-bend,
…), which manufacturers offer it, and a rough cost multiplier vs 2-layer rigid.

This is the single source of truth the flex/rigid decision, the fab export, and
the sourcing/quote layer read from. Add a process here to "support" it everywhere.
Honesty: a process listed here declares what it NEEDS; producing fab-ready output
for it (e.g. real flex gerbers with coverlay + bend-zone DRC) is the export layer's
job and is flagged per-process with `export_ready`.
"""

PROCESSES = {
    "rigid": {
        "label": "Rigid FR-4",
        "substrate": "FR-4",
        "layers": [2, 4, 6, 8],
        "extra_fab_layers": [],
        "drc_deltas": {},
        "manufacturers": ["JLCPCB", "PCBWay", "OSHPark", "MacroFab"],
        "cost_mult": 1.0,
        "export_ready": True,
        "when": "the default — component-dense, planar, low cost.",
    },
    "hdi": {
        "label": "HDI (microvia) rigid",
        "substrate": "FR-4",
        "layers": [4, 6, 8, 10],
        "extra_fab_layers": ["laser-via map"],
        "drc_deltas": {"min_track_mm": 0.0635, "min_via_mm": 0.3, "microvia": True},
        "manufacturers": ["JLCPCB", "PCBWay"],
        "cost_mult": 1.8,
        "export_ready": True,
        "when": "fine-pitch BGAs / very dense escape routing needs microvias.",
    },
    "flex": {
        "label": "Flex (polyimide)",
        "substrate": "polyimide",
        "layers": [1, 2],
        "extra_fab_layers": ["coverlay_top", "coverlay_bottom", "stiffener", "bend_region"],
        "drc_deltas": {
            "min_bend_radius_mult": 10,   # bend radius >= 10x total flex thickness (dynamic: 20x)
            "no_via_in_bend": True,
            "no_plated_hole_in_bend": True,
            "trace_perp_to_bend": True,   # traces cross the bend at 90 deg
            "hatched_pour_in_bend": True, # solid pour cracks; hatch it in flex zones
            "teardrops": True,
        },
        "manufacturers": ["JLCPCB", "PCBWay"],
        "cost_mult": 2.5,
        "export_ready": False,  # needs coverlay/stiffener gerbers + bend-zone DRC (next slice)
        "when": "must bend/fold to fit, dynamic flexing (hinge), or replace a cable.",
    },
    "rigid_flex": {
        "label": "Rigid-flex",
        "substrate": "FR-4 rigid islands + polyimide flex",
        "layers": [4, 6, 8],
        "extra_fab_layers": ["coverlay_top", "coverlay_bottom", "stiffener", "bend_region", "rigid_flex_region_map"],
        "drc_deltas": {
            "min_bend_radius_mult": 10,
            "no_via_in_bend": True,
            "no_plated_hole_in_bend": True,
            "trace_perp_to_bend": True,
            "hatched_pour_in_bend": True,
            "no_components_in_flex": True,
            "teardrops": True,
        },
        "manufacturers": ["PCBWay", "JLCPCB (rigid-flex line)"],
        "cost_mult": 4.0,
        "export_ready": False,
        "when": "two-or-more rigid sections that must fold/stack — ONE part replacing "
                "separate boards + connectors + cable.",
    },
    "metal_core": {
        "label": "Metal-core (aluminum/IMS)",
        "substrate": "aluminum IMS",
        "layers": [1, 2],
        "extra_fab_layers": ["dielectric_map"],
        "drc_deltas": {"single_sided_components": True},
        "manufacturers": ["JLCPCB", "PCBWay"],
        "cost_mult": 1.6,
        "export_ready": False,
        "when": "high-power LEDs / heavy thermal dissipation into a heatsink.",
    },
    "ceramic": {
        "label": "Ceramic (Al2O3 / AlN)",
        "substrate": "alumina/AlN",
        "layers": [1, 2, 4],
        "extra_fab_layers": [],
        "drc_deltas": {},
        "manufacturers": ["specialist"],
        "cost_mult": 8.0,
        "export_ready": False,
        "when": "RF/microwave, extreme temperature, or hermetic.",
    },
    "heavy_copper": {
        "label": "Heavy copper (>=2oz)",
        "substrate": "FR-4",
        "layers": [2, 4],
        "extra_fab_layers": [],
        "drc_deltas": {"min_track_mm": 0.2, "min_space_mm": 0.2},
        "manufacturers": ["PCBWay", "JLCPCB"],
        "cost_mult": 1.5,
        "export_ready": True,
        "when": "high current (power distribution, >10 A traces).",
    },
}


def process(name):
    return PROCESSES.get(name)


def supports(name):
    return name in PROCESSES


def manufacturers_for(name):
    return PROCESSES.get(name, {}).get("manufacturers", [])


if __name__ == "__main__":
    import json
    import sys
    if len(sys.argv) > 1:
        print(json.dumps(PROCESSES.get(sys.argv[1], {"error": "unknown process"}), indent=1))
    else:
        for k, v in PROCESSES.items():
            rdy = "export-ready" if v["export_ready"] else "spec-only (export TODO)"
            print(f"{k:12} {v['label']:28} {v['cost_mult']:.1f}x  [{rdy}]  — {v['when']}")
