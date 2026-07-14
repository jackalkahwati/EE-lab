"""Per-subsystem design with a REAL candidate search (Stage 2, for-real).

This is the difference between *labeling* a subsystem and *designing* one. Each
function here takes a subsystem's requirement, enumerates the real candidate
topologies/parts, scores them on actual engineering tradeoffs, and returns the
chosen option WITH the candidates it evaluated and why — a genuine design-of-N,
not a post-hoc grouping. `design_power` is the sharpest case (LDO vs buck vs
direct is a real current/thermal decision); compute already gets this from
`mcu_selector` (it scores + rejects MCU candidates). The convergence loop
re-invokes these when a downstream check fails.
"""

# rough per-part 3V3-rail current draw (typical, mA) by UCS category — enough to
# make the LDO-vs-buck decision real; refined numbers come from the datasheet DB.
_CURRENT_MA = {
    "mcu": 50.0, "sensor.environmental": 1.0, "sensor.current": 1.0,
    "sensor.accelerometer": 0.5, "memory.spi_flash": 15.0, "display.oled": 20.0,
    "led.addressable": 20.0, "interface.rs485": 2.0, "timer.rtc": 0.1,
}
_LDO_DROPOUT_V = 0.3      # AP2112-class headroom
_BUCK_EFF = 0.90


def current_breakdown(final_design, mcu_family=None):
    """The 3.3V-rail current budget, itemized — this is the constraint the OTHER
    subsystems (compute/sensing/hmi/storage) impose on the power subsystem. Making
    it a real sum from real parts is what makes the decomposition top-down rather
    than each subsystem designed in isolation."""
    items = []
    if mcu_family:
        items.append((mcu_family + " (MCU)", _CURRENT_MA["mcu"]))
    for s in final_design or []:
        cat = (s.get("category") or "").lower()
        ma = next((v for k, v in _CURRENT_MA.items() if cat.startswith(k) and k != "mcu"), 3.0)
        items.append((s.get("mpn", cat), ma))
    total = round(sum(ma for _n, ma in items), 1)
    return {"total_ma": total, "items": items}


def estimate_rail_current(final_design, has_mcu=True):
    """Total 3.3V rail current from the real resolved parts (+ the MCU)."""
    return current_breakdown(final_design, "mcu" if has_mcu else None)["total_ma"]


def design_power(source_v, rail_v, current_ma):
    """Design-of-N over power topologies. Returns the chosen topology + every
    candidate it evaluated with a real, defensible reason."""
    cands = []

    # 1) direct — only if the source already IS the rail (within tolerance)
    if abs(source_v - rail_v) <= 0.25:
        cands.append({"name": "direct", "part": None, "feasible": True, "score": 100.0,
                      "why": "source ≈ rail, no regulator needed — fewest parts"})
    else:
        cands.append({"name": "direct", "part": None, "feasible": False, "score": -1,
                      "why": "source %.1fV ≠ rail %.1fV — would over/under-volt the parts" % (source_v, rail_v)})

    # 2) LDO — linear: simple/cheap/quiet, but burns (Vin-Vout)*I as heat
    if source_v >= rail_v + _LDO_DROPOUT_V:
        loss_mw = (source_v - rail_v) * current_ma
        thermal_penalty = max(0.0, (loss_mw - 150.0) / 10.0)  # penalise dissipation > ~150 mW
        cands.append({"name": "LDO", "part": "AP2112K-3.3", "feasible": True,
                      "loss_mw": round(loss_mw), "score": round(90.0 - thermal_penalty, 1),
                      "why": "linear %.1f→%.1fV, %d mW dropout loss @ %d mA — 1 IC, cheap, low-noise"
                      % (source_v, rail_v, round(loss_mw), current_ma)})
    else:
        cands.append({"name": "LDO", "part": "AP2112K-3.3", "feasible": False, "score": -1,
                      "why": "insufficient headroom (%.1fV in, need ≥ %.1fV)" % (source_v, rail_v + _LDO_DROPOUT_V)})

    # 3) buck — switcher: efficient (esp. at load), but +inductor/caps, EMI, cost
    if source_v > rail_v:
        in_mw = rail_v * current_ma / _BUCK_EFF
        efficiency_win = max(0.0, (current_ma - 100.0) / 5.0)  # the win grows with load
        cands.append({"name": "buck", "part": "TPS62162", "feasible": True,
                      "in_mw": round(in_mw), "score": round(65.0 + efficiency_win, 1),
                      "why": "switching %d%% eff, %d mW draw @ %d mA — efficient at load but +L/C, EMI, cost"
                      % (_BUCK_EFF * 100, round(in_mw), current_ma)})

    feasible = [c for c in cands if c.get("feasible")]
    chosen = max(feasible, key=lambda c: c["score"]) if feasible else None
    return {
        "subsystem": "power",
        "requirement": "%.1fV source → %.1fV rail @ ~%d mA" % (source_v, rail_v, current_ma),
        "chosen": chosen["name"] + (" (%s)" % chosen["part"] if chosen and chosen["part"] else "") if chosen else None,
        "candidates": cands,
        "rationale": chosen["why"] if chosen else "no feasible power topology for this source/rail",
    }


_SENSE_CAPS = {"temperature", "humidity", "pressure", "environmental", "gas", "voc",
               "air_quality", "accelerometer", "motion", "gyroscope", "magnetometer",
               "light_sensor", "proximity", "distance", "hall", "current_sense", "power_monitor"}


def derive_requirements(intent, final_design):
    """TOP-DOWN: derive each subsystem's requirement from the product intent AND
    the cross-subsystem constraints. The power requirement carries the current
    budget PROPAGATED from the parts the other subsystems pulled in — the design
    flows top-down, not each subsystem solved in a vacuum."""
    intent = intent or {}
    caps = intent.get("required_capabilities", []) or []
    buses = intent.get("buses", []) or []
    power = intent.get("power", {}) or {}
    mcu = (intent.get("mcu") or {}).get("family")
    cb = current_breakdown(final_design, mcu)
    sense = [c for c in caps if c in _SENSE_CAPS]
    return {
        "power": "make %s from %s @ ~%d mA (budget: %s)" % (
            "/".join(power.get("rails", ["+3V3"])), power.get("source", "usb"),
            cb["total_ma"], " + ".join("%s %.0f" % (n.split()[0], ma) for n, ma in cb["items"][:5])),
        "compute": "run firmware + drive %d peripheral(s) over %s" % (
            len(final_design or []), ", ".join(buses) or "GPIO/basic I/O"),
        "sensing": "measure %s" % (", ".join(sense) if sense else "the requested quantities"),
        "storage": "retain logs/data across power cycles",
        "hmi": "present readings + take user input",
        "connectivity": "move data over %s" % (", ".join(buses) if buses else "the requested links"),
        "actuation": "drive the physical outputs",
    }


_SRC_V = {"usb": 5.0, "usb_c": 5.0, "usb-c": 5.0, "vin": 5.0,
          "battery": 3.7, "lipo": 3.7, "li-ion": 3.7, "coin": 3.0}


def design_power_from_intent(intent, final_design):
    src = ((intent or {}).get("power") or {}).get("source") or "usb"
    source_v = _SRC_V.get(src, 5.0)
    current_ma = estimate_rail_current(final_design, has_mcu=bool((intent or {}).get("mcu", {}).get("family")))
    return design_power(source_v, 3.3, current_ma)


# --- storage design-of-N -----------------------------------------------------
# The Winbond W25Q family is PIN-COMPATIBLE (same SOIC-8, same SPI pinout) across
# capacities — so choosing among them is a REAL design decision (capacity vs cost
# vs board area), not a manufactured one: pick the SMALLEST part that meets the
# storage the product actually needs. Real MPNs, real capacities, real ~unit cost
# (USD, qty-100 ballpark) — the choice is defensible from a datasheet.
FLASH_FAMILY = [
    {"mpn": "W25Q16JVSSIQ", "mbit": 16, "cost": 0.16, "footprint": "SOIC-8"},
    {"mpn": "W25Q32JVSSIQ", "mbit": 32, "cost": 0.20, "footprint": "SOIC-8"},
    {"mpn": "W25Q64JVSSIQ", "mbit": 64, "cost": 0.30, "footprint": "SOIC-8"},
    {"mpn": "W25Q128JVSIQ", "mbit": 128, "cost": 0.45, "footprint": "SOIC-8"},
]


def design_storage(required_mbit):
    """Design-of-N over the pin-compatible flash family. Returns the chosen part
    (smallest capacity that meets the need — lowest cost/area) + every candidate
    it scored with a real, defensible reason."""
    cands = []
    for f in FLASH_FAMILY:
        if f["mbit"] >= required_mbit:
            # feasible: score rewards the TIGHTEST fit (least over-provision) and
            # lower cost — don't pay board area/$ for capacity you won't use.
            headroom = f["mbit"] / max(required_mbit, 1)
            score = round(100.0 - (headroom - 1.0) * 12.0 - f["cost"] * 20.0, 1)
            cands.append({"name": f["mpn"], "part": f["mpn"], "feasible": True, "mbit": f["mbit"],
                          "score": score,
                          "why": "%d Mbit ≥ %d Mbit needed, SOIC-8, ~$%.2f — %.1f× headroom"
                          % (f["mbit"], required_mbit, f["cost"], headroom)})
        else:
            cands.append({"name": f["mpn"], "part": f["mpn"], "feasible": False, "mbit": f["mbit"],
                          "score": -1, "why": "%d Mbit < %d Mbit needed — too small" % (f["mbit"], required_mbit)})
    feasible = [c for c in cands if c["feasible"]]
    chosen = max(feasible, key=lambda c: c["score"]) if feasible else None
    return {
        "subsystem": "storage",
        "requirement": "retain ≥ %d Mbit across power cycles" % required_mbit,
        "chosen": chosen["name"] if chosen else None,
        "candidates": cands,
        "rationale": chosen["why"] if chosen else "need > 128 Mbit — beyond the seeded SPI-NOR family (use an SD card / eMMC)",
    }


# rough bytes/sample by sensor category — enough to size a log realistically
_SAMPLE_BYTES = 4


def derive_storage_requirement(intent, final_design):
    """Estimate the storage the product needs (Mbit), from what it does. A data
    logger sizing = channels × rate × retention; a config-only product needs a
    small floor. The ASSUMPTION is returned so it can be reported, never hidden."""
    intent = intent or {}
    caps = intent.get("required_capabilities", []) or []
    goal = (intent.get("product_goal") or "").lower()
    sense_channels = sum(1 for c in caps if c in _SENSE_CAPS) or 1
    logging = any(k in goal for k in ("log", "logger", "logging", "record", "datalogger", "data logger")) \
        or "storage" in caps or "flash" in caps or "spi_flash" in caps
    if logging:
        # assume 1 sample/sec/channel retained for 7 days (a defensible default)
        rate_hz, days = 1.0, 7
        samples = sense_channels * rate_hz * days * 86400
        need_mbit = max(4, round(samples * _SAMPLE_BYTES * 8 / 1e6))
        assumption = "%d channel(s) × 1 Hz × 7 days × %dB → ~%d Mbit" % (sense_channels, _SAMPLE_BYTES, need_mbit)
    else:
        need_mbit, assumption = 4, "config/firmware storage only (no logging) → 4 Mbit floor"
    return {"required_mbit": need_mbit, "assumption": assumption}


def design_storage_from_intent(intent, final_design):
    req = derive_storage_requirement(intent, final_design)
    out = design_storage(req["required_mbit"])
    out["assumption"] = req["assumption"]
    return out


if __name__ == "__main__":
    import json
    # low-current sensor puck -> LDO should win; high-current motor board -> buck
    print("low current (60 mA):",
          json.dumps(design_power(5.0, 3.3, 60), indent=1))
    print("\nhigh current (600 mA):")
    r = design_power(5.0, 3.3, 600)
    print("  chosen:", r["chosen"])
    for c in r["candidates"]:
        print("   -", c["name"], "score", c["score"], "::", c["why"])
