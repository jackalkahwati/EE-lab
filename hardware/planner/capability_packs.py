"""Phase 23.3 — General Benchmark Suite + Capability Packs v1.

A capability pack is a reusable BOARD-SYNTHESIS SKILL (intents + strategies +
subcircuits + connector/power/placement patterns + gates), generated from real
benchmark evidence. Pack state can never exceed its evidence; routed benchmark
evidence is never physical validation.
"""

TAXONOMY = [
    # (category, expected buildability, note)
    ("power_entry", "routed_with_review", "input header + LED + TPs + monitor"),
    ("USB_C_power_entry", "routed_with_review", "5V sink only; PD/data/compliance blocked"),
    ("sensor_board", "routed_with_review", "generic sensor node"),
    ("environmental_sensor", "routed_with_review", "T/H/P, uncalibrated"),
    ("I2C_sensor_breakout", "routed_with_review", "standalone, owned pull-ups"),
    ("SPI_sensor_breakout", "architecture_only", "no supported SPI sensor primitive"),
    ("MCU_carrier", "routed_with_review", "Pico module carrier class"),
    ("debug_programming_adapter", "routed_with_review", "headers must be WIRED"),
    ("simple_data_logger", "routed_with_review", "no low-power claim"),
    ("ADC_data_acquisition", "routed_with_review", "uncalibrated"),
    ("relay_controller", "routed_with_review", "safe-default OE, no safety cert"),
    ("Raspberry_Pi_HAT_style", "routed_with_review", "HAT outline = mechanical note"),
    ("connector_breakout", "routed_with_review", "mostly synthesized"),
    ("lab_instrument_adapter", "routed_with_review", "no instrument-class claims"),
    ("current_voltage_monitor", "routed_with_review", "monitor-only, uncalibrated"),
    ("simple_regulator_board", "blocked", "no validated standalone regulator primitive"),
    ("low_power_logger", "routed_with_review", "architecture ok; NO low-power claim"),
    ("simple_backplane", "routed_with_review", "generic slots, no FL-1 bus"),
    ("architecture_only_RF", "architecture_only", "RF material/impedance/EM unproven"),
    ("architecture_only_high_speed", "architecture_only", "external SI/PI required"),
    ("blocked_motor_control", "blocked", "power-stage/thermal/safety rules missing"),
    ("blocked_high_current", "blocked", "current density/thermal/protection missing"),
    ("blocked_medical_or_implantable", "blocked",
     "biocompatibility/regulatory/clinical evidence missing — never claimed"),
]

PACK_STATES = ("candidate", "generated_in_benchmark", "routed_in_benchmark",
               "manufacturing_package_supported_with_review",
               "physically_validated", "repeatedly_validated", "deprecated",
               "blocked")
PHYSICAL_STATES = {"physically_validated", "repeatedly_validated"}

# packs generated FROM real run evidence (run ids are the evidence links)
PACKS = [
    ("power_entry_pack", ["power-entry-header-v1"], "routed",
     ["power block", "led_indicator", "testpoint_cluster", "voltage_monitor"]),
    ("USB_C_5V_power_entry_pack", ["usbc-power-entry-v1"], "routed",
     ["usbcsink (JIT)", "led_indicator", "power_header", "testpoint_cluster"]),
    ("sensor_board_pack", ["env-sensor-benchmark-v1", "env-sensor-benchmark-v2"],
     "routed", ["mcu", "sourced/JIT I2C sensor", "boardid (generic)",
                "statusled", "gpiobank"]),
    ("environmental_sensor_pack", ["env-sensor-benchmark-v2"], "routed",
     ["bme280 (JIT)", "mcu", "statusled"]),
    ("I2C_interface_pack", ["i2c-breakout-v1", "bme280-sandbox-v1"], "routed",
     ["i2c_header", "pullup x2 (ownership explicit)", "testpoint_cluster"]),
    ("SPI_interface_pack", [], "candidate",
     ["spi_header (synthesizable; NO supported SPI sensor primitive yet)"]),
    ("debug_programming_pack", ["debug-prog-adapter-v1"], "routed",
     ["uart_header", "debug_header", "led_indicator", "testpoint_cluster"]),
    ("connector_interface_pack", ["connector-breakout-v1"], "routed",
     ["gpio_header x2", "testpoint_cluster", "silk labels"]),
    ("testpoint_inspection_pack", ["power-entry-header-v1", "i2c-breakout-v1",
                                   "debug-prog-adapter-v1"], "routed",
     ["testpoint_cluster", "universal TP row"]),
    ("simple_measurement_pack", ["adc-logger-v1"], "routed",
     ["calref chain (uncalibrated)", "uart_header"]),
    ("ADC_data_logger_pack", ["adc-logger-v1"], "routed",
     ["mcu", "calref", "uart_header", "led_indicator"]),
    ("current_voltage_monitor_pack", ["cv-monitor-nonfl1-v1", "fl1-pcm1-v1"],
     "routed", ["dutmonitor (shunt+divider+protected ADC)", "led_indicator"]),
    ("relay_control_pack", ["pihat-relay-v1", "fl1-core-relay-v21"], "routed",
     ["relaymatrix (safe-default OE)", "gpiobank"]),
    ("Raspberry_Pi_HAT_style_pack", ["pihat-relay-v1"], "routed",
     ["relay_control_pack + HAT outline mechanical note"]),
    ("lab_instrument_adapter_pack", ["lab-adapter-v1", "fl1-eii1-v1"], "routed",
     ["uartbridge", "gpiobank", "led_indicator"]),
    ("simple_regulator_pack", [], "blocked",
     ["NO validated standalone regulator primitive (AMS1117 placed only on "
      "GATE-FAILED stress boards — not evidence)"]),
    ("low_power_logger_pack", ["env-sensor-benchmark-v2"], "generated",
     ["battery-input architecture; NO low-power performance claim without "
      "measurement"]),
    ("simple_backplane_pack", ["generic-backplane-v1", "fl1-backplane-v1"],
     "routed", ["gpio_header slots (generic)", "pullup ownership",
                "FL-1 bus variant marked FL-1-SPECIFIC"]),
]


def pack_state(evidence_runs, kind):
    if kind == "blocked":
        return "blocked"
    if not evidence_runs:
        return "candidate"
    if kind == "generated":
        return "generated_in_benchmark"
    return "manufacturing_package_supported_with_review"  # routed + package artifacts


def promote_pack(current, target, evidence_kind, evidence_ids, status="pass"):
    """Promotion cites evidence; physical states need physical evidence;
    failures demote/narrow."""
    if status == "fail":
        return ("candidate" if current not in PHYSICAL_STATES else "deprecated",
                "failed benchmark demotes (evidence: %s)" % evidence_ids)
    if target in PHYSICAL_STATES and evidence_kind != "physical":
        return current, ("REFUSED: %s requires PHYSICAL evidence, got %s "
                         "(evidence: %s)" % (target, evidence_kind, evidence_ids))
    if not evidence_ids:
        return current, "REFUSED: promotion without evidence IDs"
    return target, "promoted (%s: %s)" % (evidence_kind, evidence_ids)


def registry():
    rows = []
    for name, runs, kind, contents in PACKS:
        st = pack_state(runs, kind)
        rows.append({
            "pack": name, "version": "v1",
            "contents": contents, "evidence_state": st,
            "evidence_links": runs,
            "benchmarks_passed": len(runs),
            "fl1_specific_evidence_marked": [r for r in runs if r.startswith("fl1-")],
            "blocked_claims": ["physically_validated", "production_ready"] +
            (["USB_certified", "PD", "data", "charger"] if "USB" in name else []) +
            (["low_power_validated"] if "low_power" in name else []) +
            (["calibrated", "precision"] if "monitor" in name or "measurement"
             in name or "ADC" in name else []) +
            (["safety_certified"] if "relay" in name else []),
            "known_limits": "review-required in every use; state never exceeds "
                            "evidence",
            "next": "physical first article" if st ==
                    "manufacturing_package_supported_with_review" else
                    ("unblock prerequisite" if st in ("blocked", "candidate")
                     else "route a benchmark"),
        })
    return rows


def pattern_recommendations():
    return [
        {"structure": "led_indicator", "form": "synthesized",
         "usage": "7 routed benchmarks", "recommendation": "promote_to_pattern",
         "reason": "used across 5+ board families, zero failures",
         "next_test": "physical first article"},
        {"structure": "testpoint_cluster", "form": "synthesized",
         "usage": "8 routed benchmarks", "recommendation": "promote_to_pattern",
         "reason": "universal, zero failures", "next_test": "physical article"},
        {"structure": "voltage_monitor (divider)", "form": "synthesized",
         "usage": "1 routed benchmark", "recommendation": "require_more_benchmarks",
         "reason": "single use; ratio-selection rules unreviewed",
         "next_test": "2+ more benchmarks with explicit ratio constraints"},
        {"structure": "generated headers (i2c/uart/spi/gpio/debug/power)",
         "form": "synthesized", "usage": "10+ uses",
         "recommendation": "keep_generated",
         "reason": "reusable and proven WIRED (post-bugfix) but parameterization "
                   "is the value — a fixed block would lose it",
         "next_test": "continue benchmark accumulation"},
        {"structure": "usbcsink", "form": "JIT",
         "usage": "1 routed benchmark", "recommendation": "require_more_benchmarks",
         "reason": "routed once; claims held by construction",
         "next_test": "physical power-entry article"},
        {"structure": "power-stage/motor structures", "form": "none",
         "recommendation": "block_or_deprecate",
         "reason": "high-risk domain, no rules exist — stays blocked",
         "next_test": "dedicated power-stage capability phase"},
    ]


def next_capability(coverage):
    """Recommend the next systemic capability from benchmark results."""
    return {
        "recommendation": "automated_2layer_flow",
        "reason": "%d of %d routed benchmarks are SIMPLE boards overbuilt on "
                  "the 4-layer automated flow — 2-layer would halve fab cost "
                  "for the breadth class the suite just proved; complexity is "
                  "low (stackup emission + router layer restriction) and it "
                  "de-risks nothing safety-critical" %
                  (coverage.get("simple_boards_overbuilt", 8),
                   coverage.get("routed", 12)),
        "runners_up": [
            {"capability": "QFN-56 quadrant escape",
             "why": "strategic (bare MCU, cost-down) but complexity 4/5"},
            {"capability": "standalone regulator primitive",
             "why": "unblocks simple_regulator_pack; needs thermal honesty"},
            {"capability": "free-form placement solving",
             "why": "no benchmark FAILED placement yet — not the bottleneck"}],
        "explicitly_not_now": ["power-stage pack (safety rules first)",
                               "RF/high-speed packs (external tools first)"],
    }
