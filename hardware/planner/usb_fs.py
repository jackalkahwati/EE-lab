"""C4 — USB 2.0 Full-Speed Data Path v1.

Cautious FS-only data support. Scope walls: no USB-HS, no USB3, no USB-C
PD, no compliance claim, no controlled-impedance claim (no stackup data),
no physical USB function claim without a board test. The contract can be
GENERATED only when every required primitive exists; anything missing
blocks with the exact gap. D+/D- is treated as a pair with geometry
REQUIREMENTS reported; impedance rides the M3B hooks (refused without a
sourced stackup).
"""
import external_eda as ee
import highspeed_rules as hs

# connector candidates whose footprints are library-verified today.
# USB4125 is the PROVEN power-only part (usbc-power-entry boards); its
# USB2 D+/D- pins make it the FS candidate as well.
CONNECTOR_CANDIDATES = {
    "USB4125": {"type": "USB-C receptacle (USB 2.0)",
                "d_pins": True, "state": "footprint_verified (proven on "
                "usbc-power-entry boards)"},
    "USB_B_MICRO_GENERIC": {"type": "micro-B", "d_pins": True,
                            "state": "candidate_only — footprint "
                                     "verification required"},
}

REQUIRED_PRIMITIVES = (
    "connector_verified", "esd_protection_device", "dp_dm_pair_routing",
    "vbus_handling", "pullup_strategy_evidence")

VALIDATION_PLAN = [
    "visual inspection", "continuity (VBUS, GND, D+, D-, shield)",
    "VBUS voltage check (power off/on)", "D+/D- short/continuity check",
    "ESD device orientation check",
    "FUTURE: enumeration test on real hardware (firmware) — until then no "
    "USB function claim", "no compliance claim at any point"]

BLOCKED_ALWAYS = [
    "USB_compliance", "USB_certification", "usb_high_speed", "usb3",
    "usb_c_power_delivery", "controlled_impedance_claim",
    "physical_usb_function (requires board test)"]


def usb_fs_contract(mcu="RP2040", connector="USB4125",
                    esd_device=None, series_resistor_evidence=False,
                    router_pair_support=False, stackup=None):
    """Build the FS contract or block with exact missing primitives."""
    missing = []
    conn = CONNECTOR_CANDIDATES.get(connector)
    if not conn:
        missing.append("connector_verified: %s is not a supported "
                       "candidate" % connector)
    elif "candidate_only" in conn["state"]:
        missing.append("connector_verified: %s footprint unverified"
                       % connector)
    if not esd_device:
        missing.append("esd_protection_device: none selected/verified — "
                       "ESD at the connector is mandatory for a data path")
    if not router_pair_support:
        missing.append("dp_dm_pair_routing: the router must prove the "
                       "D+/D- pair on this board class (advanced-routing "
                       "report); v1 refuses RP_USB_D on some boards")
    imp = ee.impedance_report(stackup)
    contract = {
        "bus_type": "usb_fs",
        "speed": "12 Mbps full-speed ONLY",
        "mcu": mcu, "connector": connector,
        "connector_state": conn["state"] if conn else "unsupported",
        "required_nets": ["VBUS", "GND", "USB_DP", "USB_DM"],
        "optional_nets": ["USB_SHIELD", "VBUS_SENSE"],
        "esd": {"device": esd_device,
                "placement": "at the connector (C1 rule esd_near_connector)"},
        "series_resistors": ("per MCU reference design (evidence present)"
                             if series_resistor_evidence else
                             "NOT added — no evidence; RP2040-class PHYs "
                             "integrate termination (candidate fact, "
                             "review-required)"),
        "pair_metadata": {
            "pair": ["USB_DP", "USB_DM"],
            "geometry_requirements": {
                "route_together": True, "max_skew_mm": 1.25,
                "max_length_mm": 60, "min_spacing_to_other_nets": "3x trace",
                "note": "FS is forgiving; these are review targets, not "
                        "correctness claims"},
        },
        "impedance": imp,
        "vbus": {"sense": "divider to ADC/GPIO if MCU requires (evidence-"
                          "gated)", "protection": "fuse/polyfuse candidate "
                 "(C5 power-tree)"},
        "validation_plan": VALIDATION_PLAN,
        "blocked_claims": list(BLOCKED_ALWAYS),
        "firmware_metadata": {"stack": "TinyUSB-class device stack "
                              "(scaffold only; no function claim)"},
    }
    if missing:
        return {"state": "blocked", "missing_primitives": missing,
                "contract_draft": contract,
                "honesty": "generation refused until every primitive "
                           "exists — nothing is faked or substituted"}
    return {"state": "generatable_review_required", "contract": contract,
            "honesty": "generatable is not functional: physical USB "
                       "function requires a board test; compliance is "
                       "never claimed"}


def usb_request_gate(text):
    """Route USB requests: FS -> this module; HS/USB3 -> M11R gates."""
    g = hs.hs_gate(text)
    if g.get("verdict") == "architecture_only" and any(
            k in g.get("classes", []) for k in ("USB2_HS", "USB3")):
        return {"path": "blocked_by_m11r", "gate": g}
    return {"path": "usb_fs_candidate",
            "note": "FS-only; proceed via usb_fs_contract primitive gates"}
