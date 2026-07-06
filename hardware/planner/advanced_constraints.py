"""Advanced Embedded Routing v1 (Phases 1, 4, 5, 6, 7, 8, 9).

The constraint + detection + planning + reporting layer that makes Compose aware
of board electrical geometry: fine-pitch escape, keepouts, differential pairs,
controlled impedance + stackup, USB/Ethernet, analog and power layout.

HONESTY — the hard boundary of v1:
  * flroute is a single-width autorouter. It does NOT route true differential
    pairs and does NOT guarantee controlled impedance. So this module DETECTS,
    PLANS, and REPORTS these constraints, and marks the ones the router cannot
    enforce as `unsupported_by_router` / `advisory`. A design that REQUIRES an
    unenforceable constraint (USB high-speed, Ethernet) fails HONESTLY.
  * Impedance geometry is an ESTIMATE (IPC-2141 microstrip). Final impedance
    always "requires a board-house controlled-impedance stackup + quote" — never
    claimed as guaranteed.

  from advanced_constraints import build_model
"""
import math
import re

# ---- default 4-layer stackup (Sig / GND / PWR / Sig), 1.6mm FR4 ------------
DEFAULT_STACKUP = {
    "layers": 4, "thickness_mm": 1.6, "material": "FR4",
    "dielectric_constant": 4.3, "copper_weight_oz": 1.0, "copper_thickness_mm": 0.035,
    "signal_to_plane_mm": 0.2,     # top signal to inner GND (thin prepuff)
    "note": "assumed default — final impedance requires a board-house "
            "controlled-impedance stackup + quote",
}

# adaptation / enforcement
ENFORCED, ADVISORY, UNSUPPORTED = "enforced", "advisory", "unsupported_by_router"


def microstrip_width_mm(z0, stk=DEFAULT_STACKUP):
    """IPC-2141 microstrip: approximate trace width (mm) for a target single-ended
    impedance. An ESTIMATE — real impedance needs the fab's stackup."""
    er, h, t = stk["dielectric_constant"], stk["signal_to_plane_mm"], stk["copper_thickness_mm"]
    k = math.exp(z0 * math.sqrt(er + 1.41) / 87.0)
    w = (5.98 * h / k - t) / 0.8
    return round(max(w, 0.1), 3)


# ---- differential pair detection (Phase 4) ---------------------------------
# (base, pos_suffix, neg_suffix, class, target_diff_ohm, high_speed)
_PAIR_PATTERNS = [
    (r"USB.?D", "P", "M", "usb", 90, True),            # USB_DP / USB_DM
    (r"USB.?D", "\\+", "-", "usb", 90, True),           # USB_D+ / USB_D-
    (r"ETH.*TX|_TX", "P", "N", "ethernet", 100, True),  # ETH_TXP / ETH_TXN
    (r"ETH.*RX|_RX", "P", "N", "ethernet", 100, True),
    (r"MDI", "P", "N", "ethernet", 100, True),
    (r"CAN", "H", "L", "can", 120, False),              # CANH/CANL: controlled, NOT high-speed
    (r"RS485|^", "A", "B", "rs485", 120, False),        # RS485_A/B: controlled pair
]


def detect_diff_pairs(nets):
    pairs = []
    used = set()
    ns = set(nets)
    for base, pp, pn, cls, zdiff, hs in _PAIR_PATTERNS:
        for n in nets:
            if n in used:
                continue
            m = re.search(base, n, re.I)
            if not m:
                continue
            # try to find the partner: n has pos suffix, partner has neg suffix
            for a, b, role in ((pp, pn, "pos"), (pn, pp, "neg")):
                if re.search(a + r"$", n) or n.endswith(a.replace("\\", "")):
                    partner = re.sub(a + r"$", b, n) if re.search(a + r"$", n) else None
                    if partner and partner != n and partner in ns and partner not in used:
                        posn, negn = (n, partner) if role == "pos" else (partner, n)
                        w = microstrip_width_mm(zdiff / 2.0)
                        pairs.append({
                            "pair": re.sub(r"[+-]?[PN]$|[HL]$|[AB]$", "", posn) or posn,
                            "positive": posn, "negative": negn, "class": cls,
                            "target_impedance_ohm": zdiff, "high_speed": hs,
                            "est_width_mm": w, "est_spacing_mm": round(w * 0.6, 3),
                            "max_skew_mm": 0.5 if hs else 2.0,
                            "length_tolerance_mm": 0.5 if hs else 5.0,
                            "preferred_layer": "top", "reference_plane": "GND (layer 2)",
                            "termination": ("90R series/parallel per USB spec" if cls == "usb"
                                            else "100R + Bob-Smith per Ethernet magnetics"
                                            if cls == "ethernet" else "120R at the far end"),
                            "provenance": "net-name detection", "confidence": 0.7,
                            # the honesty gate: high-speed pairs cannot be enforced by v1
                            "enforcement": UNSUPPORTED if hs else ADVISORY,
                            "unsupported_means_fail": hs,
                        })
                        used.add(n)
                        used.add(partner)
                        break
    return pairs


# ---- analog layout rules (Phase 8) -----------------------------------------
_ANALOG_ROLES = ("adc", "precision", "voltage_reference", "reference", "current_sense",
                 "op_amp", "opamp", "mux", "dac",
                 # common analog part-name prefixes so a raw MPN is caught too
                 "ads", "ina", "adr", "ref30", "ref31", "mcp47", "mcp6", "tmux", "adg")


def analog_rules(devices):
    rules = []
    analog_ics = [d for d in devices if any(r in ((d.get("type") or "") + " " +
                  (d.get("name") or "")).lower() for r in _ANALOG_ROLES)]
    for d in analog_ics:
        ref = d.get("ref")
        rules.append({"rule": "quiet_zone", "component": ref,
                      "detail": "keep %s inputs away from switching/digital nets" % ref,
                      "enforcement": ADVISORY, "provenance": "analog_layout_v1", "confidence": 0.6})
        if any(r in (d.get("name") or "").lower() for r in ("current_sense", "ina", "shunt")):
            rules.append({"rule": "kelvin_sense", "component": ref,
                          "detail": "route sense lines Kelvin (4-wire) to the shunt pads",
                          "enforcement": ADVISORY, "provenance": "analog_layout_v1", "confidence": 0.6})
        if any(r in (d.get("name") or "").lower() for r in ("ref", "adr", "ads")):
            rules.append({"rule": "reference_rc_filter", "component": ref,
                          "detail": "add an RC filter + local bypass at the reference/ADC supply",
                          "enforcement": ADVISORY, "provenance": "analog_layout_v1", "confidence": 0.5})
    return rules


# ---- power layout rules (Phase 9) ------------------------------------------
def power_rules(devices, nets, net_classes=None):
    rules = []
    net_classes = net_classes or {}
    has_hi = any(c in ("power_input", "motor_output") for c in net_classes)
    if has_hi or any(n in ("+5V", "VIN", "VMOTOR") for n in nets):
        rules.append({"rule": "high_current_trace", "nets": [n for n in nets
                      if n in ("+5V", "VIN", "VMOTOR")],
                      "detail": "size power traces for current + stitch vias to the plane",
                      "enforcement": ADVISORY, "provenance": "power_layout_v1", "confidence": 0.6})
    regs = [d for d in devices if "regulator" in ((d.get("type") or "") + (d.get("name") or "")).lower()
            or any(r in (d.get("name") or "").lower() for r in ("tps", "ap2112", "mcp16", "lm"))]
    for d in regs:
        rules.append({"rule": "regulator_hot_loop", "component": d.get("ref"),
                      "detail": "minimize the switch-node hot loop; input/output caps adjacent",
                      "enforcement": ADVISORY, "provenance": "power_layout_v1", "confidence": 0.6})
    for d in devices:
        if any(r in (d.get("name") or "").lower() for r in ("efuse", "tps22", "load_switch")):
            rules.append({"rule": "efuse_thermal", "component": d.get("ref"),
                          "detail": "thermal relief + copper pour for the load-switch/eFuse path",
                          "enforcement": ADVISORY, "provenance": "power_layout_v1", "confidence": 0.5})
    return rules


# ---- keepouts (Phase 3) -----------------------------------------------------
_ANTENNA_FP = re.compile(r"WROOM|MDBT50Q|ANT|RF_Module", re.I)


def keepouts(devices):
    kos = []
    for d in devices:
        fp = d.get("footprint") or d.get("name") or ""
        if _ANTENNA_FP.search(fp):
            kos.append({"type": "antenna_keepout", "component": d.get("ref"),
                        "detail": "no copper/parts under the module antenna; prefer board edge",
                        "enforcement": ENFORCED, "provenance": "footprint", "confidence": 0.9,
                        "placement_hint": {"prefer_edge": True}})
    return kos


# ---- USB / Ethernet interface awareness (Phases 6, 7) ----------------------
def interface_status(nets, pairs, intent):
    caps = " ".join(intent.get("capabilities", []) + [intent.get("product_goal", "")]).lower()
    out = []
    usb_data = [p for p in pairs if p["class"] == "usb"]
    eth = [p for p in pairs if p["class"] == "ethernet"]
    if usb_data or "usb" in caps and any("D+" in n or "USB_D" in n for n in nets):
        out.append({"interface": "USB 2.0 data", "pairs": [p["pair"] for p in usb_data],
                    "supported": False,
                    "reason": "USB data is a 90R differential pair needing controlled "
                              "impedance + length match — v1 detects + plans it but the "
                              "router cannot enforce it; route + verify at the fab",
                    "fallback": "USB-C power-only (supported) or a supported bus (UART/CAN/RS485)"})
    if eth:
        out.append({"interface": "Ethernet", "pairs": [p["pair"] for p in eth],
                    "supported": False,
                    "reason": "Ethernet needs 100R pairs + magnetics + PHY + controlled "
                              "impedance — unsupported by the v1 router",
                    "fallback": "a supported bus if the network allows"})
    return out


def build_model(nets, devices, intent, net_classes=None, board_meta=None):
    """Assemble the advanced-routing model + honest support verdict."""
    pairs = detect_diff_pairs(nets)
    kos = keepouts(devices)
    an = analog_rules(devices)
    pw = power_rules(devices, nets, net_classes)
    ifaces = interface_status(nets, pairs, intent)

    # impedance plan (estimates + honest caveat)
    imp = {"stackup": DEFAULT_STACKUP, "single_ended_50ohm_width_mm": microstrip_width_mm(50),
           "pairs": [{"pair": p["pair"], "target_impedance_ohm": p["target_impedance_ohm"],
                      "est_width_mm": p["est_width_mm"], "est_spacing_mm": p["est_spacing_mm"],
                      "enforcement": p["enforcement"]} for p in pairs],
           "controlled_impedance_quote_required": any(p["high_speed"] for p in pairs),
           "guarantee": "NONE — geometry is an IPC-2141 estimate; final impedance "
                        "requires a board-house controlled-impedance stackup"}

    # honest verdict: any REQUIRED-but-unenforceable constraint => the design needs
    # a capability v1 lacks. The pipeline should fail such a run honestly.
    blockers = [p for p in pairs if p.get("unsupported_means_fail")]
    return {
        "version": 1, "generator": "advanced-routing v1",
        "differential_pairs": pairs,
        "keepouts": kos,
        "analog_rules": an,
        "power_rules": pw,
        "impedance_plan": imp,
        "interfaces": ifaces,
        "unsupported_constraints": [
            {"constraint": "controlled_impedance_diff_pair", "pair": p["pair"],
             "class": p["class"], "why": "v1 router cannot route/verify a %d-ohm pair"
             % p["target_impedance_ohm"]} for p in blockers],
        "summary": {
            "diff_pairs": len(pairs),
            "high_speed_pairs": sum(1 for p in pairs if p["high_speed"]),
            "keepouts": len(kos), "analog_rules": len(an), "power_rules": len(pw),
            "controlled_impedance_required": imp["controlled_impedance_quote_required"],
            # a run with a high-speed pair is honestly NOT fully routable by v1
            "advanced_routable": len(blockers) == 0,
            "blockers": [b["pair"] for b in blockers],
        },
    }
