"""MCU Selector (Phase 3).

Given design requirements (which interfaces + counts + wireless / USB / CAN /
low-power the board needs), choose the best MCU from the seed library and EXPLAIN
the choice: why it was picked, which candidates were rejected and why, and — if
nothing fits — exactly which capability is missing.

Rules (honesty):
- A requested MCU is honoured only if it actually meets the hard requirements;
  otherwise it becomes a blocker for the recovery loop, never silently accepted.
- An MCU is never selected if it lacks a REQUIRED peripheral (wireless / CAN /
  USB / a needed bus / enough GPIO-ADC-PWM pads).
- "supported" MCUs outrank "partial" ones when both qualify.

  from mcu_selector import requirements_from_design, select_mcu
"""
from mcu_specs import MCU_SEEDS


def _active_interfaces(spec):
    """Interfaces wired in this design, excluding advertised alternatives."""
    active = []
    for iface in spec.get("interfaces") or []:
        if isinstance(iface, str):
            active.append({"type": iface})
        elif isinstance(iface, dict) and iface.get("role") != "alt":
            active.append(iface)
    return active


def _as_list(value):
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, (list, tuple, set)):
        return list(value)
    return [value]


def _intent_buses(intent):
    raw = intent.get("buses") or []
    if isinstance(raw, dict):
        raw = [name for name, enabled in raw.items() if enabled]
    else:
        raw = _as_list(raw)
    return {str(name).lower() for name in raw}


def requirements_from_design(intent, specs):
    """Derive hard MCU requirements from the design intent + the resolved UCS
    component specs. `specs` is the list of component UCS dicts."""
    intent = intent or {}
    ifaces = set()
    i2c_devices = spi_devices = uart_ports = adc_ch = pwm_ch = 0
    for s in specs or []:
        for it in _active_interfaces(s):
            t = it.get("type")
            if not t:
                continue
            t = t.lower()
            ifaces.add(t)
            if t in ("i2c", "i2c_device"):
                i2c_devices += 1
            elif t in ("spi", "spi_device", "spi_write_only"):
                spi_devices += 1
            elif t == "uart":
                uart_ports += 1
            elif t in ("analog", "adc"):
                adc_ch += 1
            elif t in ("pwm", "motor_output"):
                pwm_ch += 1
    # normalise interface names to the capability vocabulary
    buses = _intent_buses(intent)
    need_i2c = any(x.startswith("i2c") for x in ifaces)
    need_spi = any(x.startswith("spi") for x in ifaces)
    need_i2c = need_i2c or "i2c" in buses
    need_spi = need_spi or "spi" in buses
    need_uart = "uart" in ifaces or "uart" in buses
    need_can = "can" in ifaces or "can" in buses
    # intent-level flags
    cap_items = _as_list(intent.get("required_capabilities"))
    cap_items += _as_list(intent.get("capabilities"))  # legacy callers
    caps = " ".join(str(c) for c in cap_items + [intent.get("product_goal", "")]).lower()
    wireless = []
    if "wifi" in caps or "wi-fi" in caps:
        wireless.append("wifi")
    if "ble" in caps or "bluetooth" in caps:
        wireless.append("ble")
    battery = intent.get("battery") or {}
    battery_required = (bool(battery.get("required")) if isinstance(battery, dict)
                        else bool(battery))
    low_power = ("low power" in caps or "low-power" in caps or "battery" in caps
                 or "coin cell" in caps or battery_required)
    # USB-C as a power source does not imply that the MCU must expose USB data.
    # Require USB only when a wired component, bus, or explicit data capability
    # asks for it.
    usb_caps = {"usb", "usb_data", "usb_device", "usb_host", "usb_fs", "usb_hs"}
    need_usb = ("usb" in ifaces or "usb" in buses
                or bool(usb_caps.intersection(str(c).lower() for c in cap_items))
                or "usb data" in caps or "usb device" in caps or "usb host" in caps)

    return {
        "interfaces": [x for x in ("i2c", "spi", "uart", "can") if
                       (x == "i2c" and need_i2c) or (x == "spi" and need_spi)
                       or (x == "uart" and need_uart) or (x == "can" and need_can)],
        "i2c_buses": 1 if need_i2c else 0,
        "spi_devices": spi_devices,
        "uart_ports": max(uart_ports, 1 if need_uart else 0),
        "adc_channels": adc_ch,
        "pwm_channels": pwm_ch,
        "gpio_needed": i2c_devices + spi_devices + uart_ports + adc_ch + pwm_ch,
        "wireless": wireless,
        "low_power": low_power,
        "usb": need_usb,
        "can": need_can,
        "requested_mcu": ((intent.get("mcu") or {}).get("family")
                          if isinstance(intent.get("mcu"), dict)
                          else intent.get("mcu")),
    }


def propose_substitute(decision):
    """When a requested MCU cannot meet the design, propose the best QUALIFYING
    MCU as a substitute and report preserved / lost capabilities honestly.
    Returns None if nothing qualifies (a true dead-end for the recovery loop)."""
    req = dict(decision["requirements"])
    req["requested_mcu"] = None
    d2 = select_mcu(req)
    if not d2.get("selected"):
        return None
    sub = MCU_SEEDS[d2["selected"]]
    reqd = MCU_SEEDS.get(decision.get("requested"), {})
    preserved = ["every required interface", "board bring-up + programming"]
    if req.get("wireless"):
        preserved.append("+".join(req["wireless"]).upper() + " radio")
    lost = []
    for feat, key in (("USB", "has_usb"), ("CAN", "has_can"), ("low-power", "low_power")):
        if reqd.get(key) and not sub.get(key):
            lost.append(feat + " (present on the requested part, not the substitute)")
    if reqd and reqd.get("family") != sub.get("family"):
        lost.append("firmware target changes: %s -> %s"
                    % (reqd.get("firmware_target", "?"), sub.get("firmware_target")))
    return {
        "requested_mcu": decision.get("requested"),
        "blocker": decision["blocker"],
        "substituted_mcu": d2["selected"],
        "substituted_mpn": sub["mpn"],
        "preserved": preserved,
        "lost": lost or ["nothing material — the substitute is a superset for this design"],
        "requires_approval": True,
        "approval_note": "MCU changed from the requested part; review firmware target + footprint before production",
        "status": d2["status"],
    }


def _capable_count(spec, cap):
    return len(spec.get("capable", {}).get(cap, []))


def _shortfall(spec, req):
    """Return a list of reasons this MCU fails the HARD requirements (empty =
    it qualifies)."""
    reasons = []
    for w in req.get("wireless", []):
        if not spec.get("wireless") or w not in spec["wireless"]:
            reasons.append("no %s radio" % w.upper())
    if req.get("can") and not spec.get("has_can"):
        reasons.append("no CAN controller")
    if req.get("usb") and not spec.get("has_usb"):
        reasons.append("no USB")
    for it in req.get("interfaces", []):
        if it == "i2c" and not (_capable_count(spec, "i2c_sda") and _capable_count(spec, "i2c_scl")):
            reasons.append("no I2C pins")
        if it == "spi" and not _capable_count(spec, "spi_sck"):
            reasons.append("no SPI pins")
        if it == "uart" and not _capable_count(spec, "uart_tx"):
            reasons.append("no UART pins")
        if it == "can" and not spec.get("has_can"):
            reasons.append("no CAN")
    # enough distinct SPI chip-selects for the SPI devices
    if req.get("spi_devices", 0) > 0:
        cs = _capable_count(spec, "spi_cs") + _capable_count(spec, "gpio")
        if cs < req["spi_devices"]:
            reasons.append("not enough GPIO for %d SPI chip-selects" % req["spi_devices"])
    if req.get("adc_channels", 0) > _capable_count(spec, "adc"):
        reasons.append("only %d ADC pins, need %d" % (_capable_count(spec, "adc"), req["adc_channels"]))
    if req.get("pwm_channels", 0) > _capable_count(spec, "pwm"):
        reasons.append("only %d PWM pins, need %d" % (_capable_count(spec, "pwm"), req["pwm_channels"]))
    if req.get("gpio_needed", 0) > _capable_count(spec, "gpio"):
        reasons.append("only %d GPIO, need ~%d" % (_capable_count(spec, "gpio"), req["gpio_needed"]))
    return reasons


def _score(spec, req):
    """Soft ranking for MCUs that already qualify (higher = better)."""
    s = 0.0
    s += 100 if spec.get("status") == "supported" else 0
    s += 20 * spec.get("confidence", 0)
    if req.get("low_power") and spec.get("low_power"):
        s += 15
    # prefer a simpler/cheaper part when it still fits
    s -= spec.get("sourcing", {}).get("typical_cost_usd", 3.0)
    # prefer not to over-spec (fewer GPIO is fine as long as it qualified)
    return s


def select_mcu(req):
    """Pick the best MCU. Returns a full, explainable decision record."""
    rejected = []
    qualifying = []
    for key, spec in MCU_SEEDS.items():
        short = _shortfall(spec, req)
        if short:
            rejected.append({"mcu": key, "reasons": short})
        else:
            qualifying.append((key, spec, _score(spec, req)))

    requested = req.get("requested_mcu")
    requested_key = None
    if requested:
        # Match how users name a family ("STM32", "ESP32", "nRF52") against the
        # seed's more specific key/family ("STM32F103"/"STM32F1", "ESP32-S3",
        # "nRF52840"). Exact first, then prefix either direction — so a generic
        # family request is honoured instead of silently falling back to the
        # soft-score winner (which is why an STM32 ask used to build an RP2040).
        def _norm(x):
            return (x or "").upper().replace("-", "").replace("_", "")
        rq = _norm(requested)
        best = None
        for key in MCU_SEEDS:
            kk, fam = _norm(key), _norm(MCU_SEEDS[key]["family"])
            if kk == rq or fam == rq:
                best = key; break  # exact wins outright
            if best is None and (kk.startswith(rq) or fam.startswith(rq) or rq.startswith(fam)):
                best = key  # first prefix match; keep scanning for an exact one
        requested_key = best

    # honour a requested MCU only if it qualifies
    if requested_key:
        q = next((x for x in qualifying if x[0] == requested_key), None)
        if q:
            chosen = q
            why = "requested MCU %s and it meets every hard requirement" % requested_key
        else:
            short = next((r["reasons"] for r in rejected if r["mcu"] == requested_key),
                         ["not in seed library"])
            return {
                "selected": None, "requested": requested_key,
                "blocker": "requested MCU %s cannot meet the design: %s"
                           % (requested_key, "; ".join(short)),
                "qualifying": [k for k, _s, _sc in sorted(qualifying, key=lambda x: -x[2])],
                "rejected": rejected, "needs_recovery": True, "requirements": req,
            }
    elif qualifying:
        chosen = max(qualifying, key=lambda x: x[2])
        why = "best fit for the requirements (%s), status=%s, confidence=%.2f" % (
            ", ".join(req.get("interfaces", []) + req.get("wireless", [])) or "basic I/O",
            chosen[1]["status"], chosen[1]["confidence"])
    else:
        # nothing fits — name the capability that killed every candidate
        allreasons = sorted({r for rj in rejected for r in rj["reasons"]})
        return {
            "selected": None, "requested": requested,
            "blocker": "no seed MCU meets the design; missing: " + "; ".join(allreasons),
            "rejected": rejected, "needs_recovery": True, "requirements": req,
        }

    key, spec, _sc = chosen
    return {
        "selected": key,
        "mpn": spec["mpn"], "family": spec["family"], "package": spec["package"],
        "status": spec["status"], "confidence": spec["confidence"],
        "why": why,
        "rejected": rejected,
        "requested": requested_key,
        "needs_recovery": False,
        "requirements": req,
        "partial_warning": (spec.get("notes") if spec["status"] == "partial" else None),
    }
