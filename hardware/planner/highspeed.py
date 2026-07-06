"""True High-Speed Routing v1 (Phase 1, 4) — the route object model + planner.

Turns detected differential pairs + the impedance plan into first-class HIGH-SPEED
ROUTE specs the diff-pair router (scripts/route_diff_pairs.py) actually routes and
checks. Honesty is preserved end-to-end:
  * impedance geometry comes from the estimate — final impedance still needs a
    board-house controlled-impedance stackup (advisory, never guaranteed);
  * a REQUIRED constraint that cannot be enforced fails the design honestly;
  * CAN/RS485 stay controlled/advisory unless explicitly requested as strict diff.

  from highspeed import plan_routes
"""
import advanced_constraints as ac

# v1 interface profiles: (target_diff_ohm, length_tol_mm, max_skew_mm, required)
PROFILES = {
    "usb_fs": {"impedance": 90, "length_tol_mm": 3.0, "max_skew_mm": 2.0, "required": False,
               "note": "USB 2.0 full-speed — looser tolerances, routable in v1"},
    "usb_hs": {"impedance": 90, "length_tol_mm": 0.15, "max_skew_mm": 0.15, "required": True,
               "note": "USB 2.0 high-speed — 90ohm, tight skew, controlled impedance"},
    "eth_phy_mag": {"impedance": 100, "length_tol_mm": 0.5, "max_skew_mm": 0.5, "required": True,
                    "note": "10/100 Ethernet PHY<->magnetics 100ohm pair"},
    "eth_mag_rj45": {"impedance": 100, "length_tol_mm": 0.5, "max_skew_mm": 0.5, "required": True,
                     "note": "Ethernet magnetics<->RJ45 pair"},
    "lvds": {"impedance": 100, "length_tol_mm": 0.5, "max_skew_mm": 0.3, "required": True,
             "note": "generic LVDS-like differential pair"},
    "clock": {"impedance": 100, "length_tol_mm": 0.3, "max_skew_mm": 0.2, "required": True,
              "note": "explicit clock/strobe pair"},
}

# map a detected pair class -> a v1 profile (usb defaults to high-speed unless the
# intent says full-speed; ethernet -> PHY<->magnetics segment)
def _profile_for(pair, intent):
    caps = " ".join(intent.get("capabilities", []) + [intent.get("product_goal", "")]).lower()
    if pair["class"] == "usb":
        return "usb_fs" if "full-speed" in caps or "full speed" in caps or "1.1" in caps else "usb_hs"
    if pair["class"] == "ethernet":
        return "eth_phy_mag"
    if pair["class"] in ("can", "rs485"):
        return None                       # controlled/advisory unless explicit
    return "lvds"


def plan_routes(nets, intent, stackup=None):
    """Return a list of high-speed route specs for the strict differential pairs
    on this board. Uses the impedance estimate for geometry."""
    stk = stackup or ac.DEFAULT_STACKUP
    pairs = ac.detect_diff_pairs(nets)
    routes = []
    for p in pairs:
        prof_key = _profile_for(p, intent)
        if not prof_key:
            continue                      # CAN/RS485: stays advisory in advanced_constraints
        prof = PROFILES[prof_key]
        w = ac.microstrip_width_mm(prof["impedance"] / 2.0, stk)
        routes.append({
            "group": p["pair"], "interface": prof_key,
            "positive": p["positive"], "negative": p["negative"],
            "clock_nets": [],
            "target_impedance_ohm": prof["impedance"],
            "target_width_mm": w, "target_spacing_mm": round(w * 0.6, 3),
            "length_tolerance_mm": prof["length_tol_mm"], "max_skew_mm": prof["max_skew_mm"],
            "preferred_layers": ["F.Cu"], "reference_plane": "GND (layer 2)",
            "allowed_vias": 0, "via_transition_rule": "none in v1 (single-layer pair)",
            "termination": p.get("termination"),
            "esd_required": p["class"] in ("usb", "ethernet"),
            "required": prof["required"], "profile_note": prof["note"],
            "provenance": "net-name detection + impedance estimate",
            # the router sets the real status; this is the planned intent
            "enforcement_status": "planned_not_routed",
            "impedance_guarantee": "advisory — requires a board-house controlled-"
                                   "impedance stackup + quote",
        })
    return {"stackup": stk, "routes": routes,
            "controlled_impedance_quote_required": any(r["required"] for r in routes)}
