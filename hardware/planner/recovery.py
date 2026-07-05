"""Capability-aware Design Recovery Loop (Phase 9).

When a requested part / feature / interface is unsupported, Compose does NOT
immediately fail. It identifies the functional intent behind the blocked item and
tries to rebuild using a supported alternative that preserves as much of that
intent as possible — then reports EXACTLY what was preserved and what was lost.

Nothing is silent. Every substitution returns a record with the original request,
the blocker, the proposal, the capabilities preserved and lost, whether human
approval is required (because product meaning changed), and a confidence.

Fallback types: component_substitution, interface_substitution,
architecture_substitution, feature_degradation, human_approval_required.
"""
from resolver import part_capabilities, resolve_capability

# unsupported interface -> ordered acceptable fallbacks (Phase 9 interface subs).
# Ethernet needs a PHY + differential routing Compose does not support yet, so it
# degrades to a simpler supported network interface.
INTERFACE_FALLBACKS = {
    "ethernet": ["can", "rs485", "uart", "usb"],
    "usb_highspeed": ["usb", "uart"],
}


def recover(blocked, intended_caps, lib):
    """Find a supported alternative for a blocked resolution. `intended_caps` are
    the functional capabilities the blocked item was meant to provide."""
    intended = set(intended_caps)

    # score every SUPPORTED library part by how much intent it covers
    scored = []
    for mpn, spec in lib.items():
        if spec.get("support_status") != "supported":
            continue
        provides = set(part_capabilities(spec))
        covered = provides & intended
        if covered:
            scored.append((len(covered), mpn, spec, covered))
    # fall back to the capability map for any single intended capability
    if not scored:
        for cap in intended:
            res = resolve_capability(cap, lib)
            if res["status"] == "supported" and res["spec"]:
                scored.append((1, res["mpn"], res["spec"], {cap}))

    if not scored:
        return {
            "original_request": blocked["request"],
            "blocker": "; ".join(blocked["reasons"]) or "unsupported",
            "substitution_type": "none",
            "recovered": False,
            "proposed": None,
            "capabilities_preserved": [],
            "capabilities_lost": sorted(intended),
            "requires_approval": True,
            "confidence": 0.0,
            "note": "no supported alternative preserves any of the requested intent",
        }

    scored.sort(key=lambda x: -x[0])
    _n, mpn, spec, covered = scored[0]
    preserved = sorted(covered)
    lost = sorted(intended - covered)
    return {
        "original_request": blocked["request"],
        "blocker": "; ".join(blocked["reasons"]) or "unsupported",
        "substitution_type": "feature_degradation" if lost else "component_substitution",
        "recovered": True,
        "proposed": mpn,
        "proposed_spec": spec,
        "capabilities_preserved": preserved,
        # a lost capability changes what the product DOES → needs sign-off
        "capabilities_lost": lost,
        "requires_approval": bool(lost),
        "confidence": round(len(covered) / max(1, len(intended)), 2),
        "note": ("substituted %s; dropped %s" % (mpn, ", ".join(lost))) if lost
                else "substituted %s, full intent preserved" % mpn,
    }


def recover_interface(iface, intended, lib):
    """Recover an unsupported INTERFACE (e.g. Ethernet) to a supported one,
    preserving the 'network/comms' intent at reduced capability."""
    fallbacks = INTERFACE_FALLBACKS.get(iface, [])
    for fb in fallbacks:
        res = resolve_capability(fb if fb in ("rs485",) else fb + "", lib)
        # rs485 has a part; can/uart/usb are transport intents we can honestly
        # mark as supported-by-architecture only if a part backs them
        if res["status"] == "supported":
            return {
                "original_request": iface,
                "blocker": "%s requires an unsupported PHY + differential routing" % iface,
                "substitution_type": "interface_substitution",
                "recovered": True,
                "proposed": fb,
                "capabilities_preserved": ["networking (reduced)"],
                "capabilities_lost": ["%s speed/topology" % iface],
                "requires_approval": True,
                "confidence": 0.5,
                "note": "networking preserved via %s; %s-specific capability lost" % (fb, iface),
            }
    return {
        "original_request": iface,
        "blocker": "%s unsupported and no acceptable fallback available" % iface,
        "substitution_type": "none", "recovered": False, "proposed": None,
        "capabilities_preserved": [], "capabilities_lost": [iface],
        "requires_approval": True, "confidence": 0.0,
    }
