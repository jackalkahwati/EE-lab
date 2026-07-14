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


def estimate_rail_current(final_design, has_mcu=True):
    """Estimate the 3.3V rail current from the real resolved parts (+ the MCU,
    which lives outside final_design)."""
    ma = 50.0 if has_mcu else 0.0  # the MCU
    for s in final_design or []:
        cat = (s.get("category") or "").lower()
        ma += next((v for k, v in _CURRENT_MA.items() if cat.startswith(k) and k != "mcu"), 3.0)
    return round(ma, 1)


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


_SRC_V = {"usb": 5.0, "usb_c": 5.0, "usb-c": 5.0, "vin": 5.0,
          "battery": 3.7, "lipo": 3.7, "li-ion": 3.7, "coin": 3.0}


def design_power_from_intent(intent, final_design):
    src = ((intent or {}).get("power") or {}).get("source") or "usb"
    source_v = _SRC_V.get(src, 5.0)
    current_ma = estimate_rail_current(final_design, has_mcu=bool((intent or {}).get("mcu", {}).get("family")))
    return design_power(source_v, 3.3, current_ma)


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
