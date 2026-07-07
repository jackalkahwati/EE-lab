"""Fine-grid routing model, via-in-pad feasibility, HDI placeholder (Phase 16.5).

Models the fine-pitch escape capability that now EXISTS (exact-geometry pre-escape
fanout, proven on the FL-1 Calibration/Reference board) and honestly bounds what
does NOT exist (via-in-pad without fab confirmation, HDI).
"""

ESCAPE_STATUSES = ("fine_grid_escape_passed", "fine_grid_escape_drc_failed",
                   "blocked_by_grid_resolution", "blocked_by_clearance",
                   "blocked_by_pad_geometry", "blocked_by_router_topology",
                   "blocked_by_fab_rules")

VIP_STATUSES = ("via_in_pad_not_needed", "via_in_pad_candidate",
                "via_in_pad_required_but_unsupported", "via_in_pad_supported_with_review",
                "via_in_pad_blocked_by_fab")


def routing_model(component="U2 (ADS1115, TSSOP-10)", result="fine_grid_escape_passed"):
    return {
        "version": "v1",
        "component": component,
        "package": "TSSOP-10", "pitch_mm": 0.5, "pad_count": 10,
        "pad_geometry_mm": [0.3, 1.45],
        "required_escape_pins": ["9 (SDA)", "10 (SCL)", "4 (AIN0/REF_OUT)", "5 (AIN1/REF_DIV)"],
        "required_escape_nets": ["I2C_SDA", "I2C_SCL", "REF_OUT", "REF_DIV"],
        "local_grid": "EXACT geometry (no grid): hand-authored 0.2mm lane escapes, "
                      "0.3mm stub-to-stub gap >= 0.2mm clearance",
        "global_grid_pitch_mm": 0.46,
        "route_width_mm": 0.2, "clearance_mm": 0.2,
        "transition_points": "breakout pads (D1.0mm) spaced 2.4mm — resolvable by the "
                             "0.46mm global grid; original fine pins removed from the "
                             "router's net lists, stub copper carries connectivity, "
                             "final DRC verifies END-TO-END",
        "escape_mechanics": ["signal pads: L-shaped private lanes (1.2mm lane spacing) "
                             "fanning off the signal end of the row",
                             "plane pads: dogbones to staggered-depth 0.4/0.2 vias",
                             "flroute v5: pre-existing stub wires marked as net-owned "
                             "obstacles (foreign nets blocked, own net passable)"],
        "root_causes_fixed": ["compose.place pad-rotation bug: KiCad pad angles are "
                              "ABSOLUTE — rotated footprints kept 0-degree pads, so "
                              "positions rotated but orientations did not, leaving "
                              "mutually OVERLAPPING fine-pitch pads (the real source of "
                              "the 'residual shorts' on every rotated board)",
                              "grid contention at 0.5mm pitch (the original "
                              "blocked_by_grid_resolution) — bypassed by exact-geometry "
                              "fanout"],
        "expected_difficulty": "dense_escape",
        "result": result,
        "statuses": list(ESCAPE_STATUSES),
    }


def via_in_pad_feasibility():
    return {
        "version": "v1",
        "package_assessed": "TSSOP-10 (ADS1115)",
        "needed": False,
        "status": "via_in_pad_not_needed",
        "reason": "the exact-geometry pre-escape fanout solves the 0.5mm-pitch escape "
                  "WITHOUT via-in-pad; dogbone vias sit outside the pads",
        "if_needed_later": {
            "via_size_mm": [0.4, 0.2], "pad_size_mm": [0.3, 1.45],
            "annular_ring_mm": 0.1,
            "filled_capped_requirement": "filled + capped (IPC-4761 Type VII) for "
                                         "assembly-safe via-in-pad",
            "fab_capability_required": "via-in-pad + filled/capped microvia support",
            "assembly_risk": "solder wicking into unfilled vias -> voids/tombstoning",
            "cost_impact": "higher (fill/cap adds process steps)",
            "inspection_requirement": "X-ray for hidden joints",
            "selected_manufacturer_support": "UNCONFIRMED — no fab capability "
                                             "confirmation exists; do NOT assume",
            "human_review_required": True,
        },
        "rules": ["via-in-pad cannot become order-ready without fab capability confirmation",
                  "via-in-pad always requires human review in this phase",
                  "no fake fab support"],
        "statuses": list(VIP_STATUSES),
    }


def hdi_placeholder():
    return {
        "version": "v1",
        "status": "placeholder — NOT implemented, NOT claimed",
        "microvia_candidate": "future dense BGA/QFN boards only",
        "blind_buried_candidate": "not modeled",
        "via_in_pad_candidate": "see via-in-pad feasibility (not needed today)",
        "hdi_stackup_requirement": "would require fab-quoted HDI stackup",
        "fab_quote_requirement": True,
        "assembly_xray_requirement": True,
        "human_review_requirement": True,
        "honesty": "Compose does NOT support HDI routing, microvias, blind/buried vias, "
                   "or any layer count beyond standard 4-layer. No 24-layer or HDI "
                   "readiness is claimed.",
    }
