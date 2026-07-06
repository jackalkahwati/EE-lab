"""FL-1-Directed Compute / RF / Exotic Boards v1 (Phase 12).

Not a generic compute/RF product layer — this is the honest PLANNING + READINESS
layer aimed only at the real FL-1 internal instrument boards. It encodes what
Compose can attempt today, what needs a reference/simulation, and what is flatly
unsupported (FPGA/BGA fanout, DDR, PCIe, MIPI, GSPS-ADC, scope/funcgen/LA-class
performance) — with exact blockers, never a faked capability.

Readiness is derived from Compose's ACTUAL capabilities (MCU + I2C/SPI/UART/CAN/
RS485, relay driver, shift register, current sense, ingested ADS1115 ADC, voltage
regulator, a routed+checked USB diff pair, EEPROM, test points) — nothing else is
claimed.

  from fl1_boards import generate_all
"""
import json
import os

READINESS = ("ready_to_attempt", "buildable_with_review", "partial",
             "needs_reference", "needs_simulation", "needs_external_instrument",
             "needs_specialist_fab", "unsupported")

# ---- Phase 1: FL-1-directed exotic board taxonomy (13 classes) --------------
EXOTIC_TAXONOMY = {
    "hs_adc_capture_starter": {
        "purpose": "capture-board starter around a fast ADC",
        "required_interfaces": ["spi", "parallel_or_lvds"], "required_routing": ["high_speed_diff", "controlled_impedance"],
        "stackup": "4-layer min, controlled impedance", "analog_rules": ["quiet_zone", "reference"],
        "power_rules": ["low-noise analog rail"], "si_rules": ["length match", "return path"],
        "clocking": "low-jitter sample clock", "calibration": "gain/offset", "protection": "input clamp",
        "safety": "none", "manufacturing_complexity": "high", "fl1_hooks": ["capture self-test"],
        "unsupported_risks": ["GSPS ADC + FPGA + memory not supported"], "phase_readiness": "unsupported"},
    "hs_dac_stimulus_starter": {
        "purpose": "stimulus/function-generator-lite starter around a DAC",
        "required_interfaces": ["spi", "i2c"], "required_routing": ["clean analog out"],
        "stackup": "4-layer", "analog_rules": ["reconstruction filter", "output buffer"],
        "power_rules": ["low-noise rail"], "si_rules": ["short output path"], "clocking": "update clock",
        "calibration": "amplitude/offset", "protection": "output clamp", "safety": "none",
        "manufacturing_complexity": "medium", "fl1_hooks": ["output loopback"],
        "unsupported_risks": ["funcgen-class waveform quality not supported"], "phase_readiness": "needs_reference"},
    "logic_capture_starter": {
        "purpose": "protected digital capture front-end",
        "required_interfaces": ["digital_in"], "required_routing": ["normal digital"],
        "stackup": "2/4-layer", "analog_rules": [], "power_rules": ["level-shift rails"],
        "si_rules": ["timing (unsupported v1)"], "clocking": "capture clock", "calibration": "threshold",
        "protection": "input clamp + series R", "safety": "none", "manufacturing_complexity": "medium",
        "fl1_hooks": ["channel self-test"], "unsupported_risks": ["timing capture / LA-class not supported"],
        "phase_readiness": "needs_simulation"},
    "fpga_module_carrier_starter": {
        "purpose": "carrier for an FPGA/controller MODULE (not raw BGA)",
        "required_interfaces": ["module_connector", "jtag_swd"], "required_routing": ["module IO", "hs pairs"],
        "stackup": "4-layer+", "analog_rules": [], "power_rules": ["module rails"],
        "si_rules": ["hs pair length match"], "clocking": "module clock in", "calibration": "none",
        "protection": "none", "safety": "none", "manufacturing_complexity": "high",
        "fl1_hooks": ["module bring-up"],
        "unsupported_risks": ["unsupported_bga_fanout", "unsupported_ddr", "unsupported_pcie",
                              "unsupported_mipi", "unsupported_high_speed_memory"],
        "phase_readiness": "needs_reference"},
    "rf_50ohm_interface": {
        "purpose": "instrument coax/50Ω interface (NOT an RF product)",
        "required_interfaces": ["coax_sma_bnc"], "required_routing": ["50ohm_estimate", "rf_keepout"],
        "stackup": "controlled impedance for real 50Ω", "analog_rules": ["guard"], "power_rules": [],
        "si_rules": ["return path", "via stitching"], "clocking": "none", "calibration": "none",
        "protection": "ESD/clamp", "safety": "none", "manufacturing_complexity": "medium-high",
        "fl1_hooks": ["loopback"], "unsupported_risks": ["RF performance/S-params/tuning NOT claimed"],
        "phase_readiness": "buildable_with_review"},
    "trigger_sync_clock": {
        "purpose": "trigger / sync / clock distribution",
        "required_interfaces": ["digital", "coax_optional"], "required_routing": ["short matched"],
        "stackup": "2/4-layer", "analog_rules": [], "power_rules": [], "si_rules": ["length match"],
        "clocking": "distribution", "calibration": "none", "protection": "clamp", "safety": "none",
        "manufacturing_complexity": "low-medium", "fl1_hooks": ["trigger self-test"],
        "unsupported_risks": ["ps-class skew not guaranteed"], "phase_readiness": "buildable_with_review"},
    "external_instrument_interface": {
        "purpose": "connect FL-1 to external instruments (USB/LXI/trigger/coax)",
        "required_interfaces": ["usb_or_ethernet", "trigger", "coax_optional", "i2c_eeprom"],
        "required_routing": ["usb_diff_pair", "50ohm_estimate"], "stackup": "4-layer",
        "analog_rules": [], "power_rules": ["protected rail"], "si_rules": ["usb pair match"],
        "clocking": "optional", "calibration": "none", "protection": "ESD on IO", "safety": "interlock aware",
        "manufacturing_complexity": "medium", "fl1_hooks": ["interface self-test"],
        "unsupported_risks": ["Ethernet/LXI needs PHY+magnetics (partial)"], "phase_readiness": "buildable_with_review"},
    "programmable_power_current_monitor": {
        "purpose": "programmable rail + current/voltage monitoring",
        "required_interfaces": ["i2c", "spi"], "required_routing": ["kelvin sense", "high current"],
        "stackup": "2/4-layer", "analog_rules": ["kelvin_sense", "shunt"], "power_rules": ["high_current", "hot_loop"],
        "si_rules": [], "clocking": "none", "calibration": "current gain/offset", "protection": "eFuse/OCP",
        "safety": "OVP/OCP", "manufacturing_complexity": "medium", "fl1_hooks": ["current cal loopback"],
        "unsupported_risks": ["fast transient response not modeled"], "phase_readiness": "buildable_with_review"},
    "dmm_lite_measurement": {
        "purpose": "multi-range voltage/current measurement front-end",
        "required_interfaces": ["i2c", "analog"], "required_routing": ["analog quiet"], "stackup": "4-layer",
        "analog_rules": ["quiet_zone", "reference", "guard"], "power_rules": ["low-noise rail"],
        "si_rules": [], "clocking": "none", "calibration": "multi-range gain/offset", "protection": "input clamp",
        "safety": "none", "manufacturing_complexity": "medium", "fl1_hooks": ["reference check", "cal loopback"],
        "unsupported_risks": ["6.5-digit precision not claimed"], "phase_readiness": "buildable_with_review"},
    "calibration_reference": {
        "purpose": "precision reference + divider/ladder + measurement path",
        "required_interfaces": ["i2c", "analog"], "required_routing": ["analog quiet"], "stackup": "4-layer",
        "analog_rules": ["reference", "quiet_zone", "precision_passive"], "power_rules": ["low-noise rail"],
        "si_rules": [], "clocking": "none", "calibration": "traceable reference", "protection": "input clamp",
        "safety": "none", "manufacturing_complexity": "medium", "fl1_hooks": ["reference verify", "loopback"],
        "unsupported_risks": ["metrology-grade traceability needs external cal"], "phase_readiness": "buildable_with_review"},
    "relay_probe_matrix": {
        "purpose": "relay/probe switching matrix",
        "required_interfaces": ["spi", "shift_register"], "required_routing": ["coil drive"], "stackup": "2/4-layer",
        "analog_rules": [], "power_rules": ["coil rail", "flyback"], "si_rules": [], "clocking": "none",
        "calibration": "contact check", "protection": "flyback diode", "safety": "relay isolation",
        "manufacturing_complexity": "medium", "fl1_hooks": ["matrix self-test"],
        "unsupported_risks": ["high-voltage isolation class not certified"], "phase_readiness": "pattern_backed"},
    "controller_backplane_fixture_io": {
        "purpose": "controller / backplane / fixture IO hub",
        "required_interfaces": ["i2c", "spi", "uart", "can", "gpio"], "required_routing": ["normal digital", "power"],
        "stackup": "2/4-layer", "analog_rules": [], "power_rules": ["rail distribution"], "si_rules": [],
        "clocking": "optional", "calibration": "none", "protection": "IO clamp", "safety": "interlock hub",
        "manufacturing_complexity": "low-medium", "fl1_hooks": ["bus scan", "board ID"],
        "unsupported_risks": [], "phase_readiness": "ready_to_attempt"},
    "unsupported_fl1_advanced": {
        "purpose": "any FL-1 board needing capabilities v1 lacks",
        "required_interfaces": [], "required_routing": [], "stackup": "specialist", "analog_rules": [],
        "power_rules": [], "si_rules": [], "clocking": "", "calibration": "", "protection": "", "safety": "",
        "manufacturing_complexity": "specialist", "fl1_hooks": [],
        "unsupported_risks": ["GSPS ADC, FPGA BGA fanout, DDR/PCIe/MIPI, RF tuning, SI/PI signoff"],
        "phase_readiness": "unsupported"},
}

# ---- Phase 2: FL-1 board family architecture map (10 target boards) ---------
BOARD_FAMILY = [
    ("controller_backplane_fixture_io", "Controller / backplane / fixture IO board", "ready_to_attempt",
     ["MCU", "I2C/SPI/UART/CAN", "GPIO expanders", "connectors"], []),
    ("relay_probe_matrix", "Relay / probe matrix board", "pattern_backed",
     ["relay driver (ULN2803)", "shift register (74HC595)", "relays", "flyback"], []),
    ("programmable_power_current_monitor", "Programmable power / current monitor board", "buildable_with_review",
     ["INA228 current sense", "regulator", "eFuse", "MCU"], ["fast transient loop not modeled"]),
    ("controller_backplane_fixture_io", "Digital bring-up board", "ready_to_attempt",
     ["MCU", "SWD/JTAG header", "UART/I2C/SPI", "test points"], []),
    ("calibration_reference", "Calibration / reference board", "buildable_with_review",
     ["precision voltage reference", "resistor divider/ladder", "ADS1115 ADC", "board-ID EEPROM"],
     ["reference part needs ingestion", "metrology traceability external"]),
    ("dmm_lite_measurement", "DMM-lite measurement board", "buildable_with_review",
     ["ADS1115/INA228", "voltage reference", "analog mux", "input protection"],
     ["6.5-digit precision not claimed", "analog mux needs ingestion"]),
    ("hs_dac_stimulus_starter", "Stimulus / function-generator-lite board", "needs_reference",
     ["DAC", "reference", "output op-amp", "reconstruction filter"],
     ["DAC footprint/ingestion incomplete", "funcgen-class quality unsupported"]),
    ("logic_capture_starter", "Logic capture board", "needs_simulation",
     ["level shifters", "protected inputs", "capture controller", "trigger"],
     ["timing capture / LA-class unsupported", "needs capture controller"]),
    ("hs_adc_capture_starter", "Scope-lite board", "unsupported",
     ["fast ADC", "FPGA/module", "sample memory", "analog front-end", "low-jitter clock"],
     ["GSPS ADC unsupported", "FPGA BGA fanout unsupported", "sample memory unsupported",
      "scope-class bandwidth/ENOB/sample-rate NOT claimed"]),
    ("external_instrument_interface", "External instrument interface board", "buildable_with_review",
     ["MCU", "USB (routed diff pair)", "trigger IO", "SMA/BNC", "board-ID EEPROM", "protected IO"],
     ["Ethernet/LXI needs PHY+magnetics (partial)", "50Ω is advisory estimate"]),
]

# ---- Phase 3: shared FL-1 instrument bus v1 (architecture, not final) --------
INSTRUMENT_BUS = {
    "version": "v1-architecture (NOT final)",
    "power_rails": ["+12V (main)", "+5V", "+3V3"],
    "protected_rails": ["+5V_PROT (eFuse)", "+3V3_ANALOG (filtered)"],
    "ground_strategy": "single-point AGND<->DGND star at the reference/ADC region",
    "safety_interlock": "INTERLOCK (active-low, daisy-chained)",
    "fault_line": "FAULT (open-drain, wired-OR)",
    "trigger_line": "TRIG (5V-tolerant)", "sync_clock_line": "SYNC_CLK",
    "reset_line": "nRESET", "board_id": "I2C EEPROM (24AAxx) at a per-slot address",
    "firmware_update": "SWD header + optional UART/USB bootloader",
    "control_bus_options": ["I2C (primary)", "SPI", "UART", "CAN", "USB", "Ethernet (partial)"],
    "calibration_loopback": "CAL_LOOP+/CAL_LOOP- pair",
    "fixture_probe_lines": "MATRIX[0..n] via shift-register expanders",
    "expansion_connector": "2x20 0.1in header (v1) — high-speed via dedicated coax/pairs",
    "external_instrument_connector": "USB-C (data via routed pair) + SMA trigger",
    "note": "v1 architecture for planning; pinout + connector finalize in FL-1 Instrument Core v1",
}


# ---- Phases 4-8: honest starter readiness reports ---------------------------
def rf_50ohm_report():
    return {"interface": "FL-1 RF / 50Ω / coax", "connectors": ["SMA", "BNC"],
            "trace_50ohm_mm": 0.335, "trace_50ohm_basis": "IPC-2141 microstrip estimate",
            "features": ["RF keepout", "ground via stitching hint", "return-path warning",
                         "shield/guard note", "termination (50Ω/AC-DC coupling)",
                         "trigger in/out", "external scope/funcgen connection"],
            "honesty": {"impedance": "50Ω is an ESTIMATE — real 50Ω needs a board-house "
                                     "controlled-impedance stackup",
                        "rf_performance": "NOT guaranteed", "s_parameters": "NOT claimed",
                        "antenna_tuning": "NOT claimed",
                        "validation": "VNA/spectrum validation is future/external"},
            "status": "buildable_with_review"}


def scope_lite_report():
    return {"board": "scope-lite / high-speed ADC capture starter",
            "supported_now": ["ADC component class (planning)", "input protection placeholder",
                              "voltage reference", "single/diff input classification",
                              "calibration loopback", "input connector options", "FL-1 hooks"],
            "placeholders_not_implemented": ["attenuator/divider", "analog front-end",
                                             "anti-alias filter", "capture controller path"],
            "unsupported_blockers": ["GSPS ADC not supported", "FPGA/module + sample memory not supported",
                                     "low-jitter clock chain not designed"],
            "honesty": {"performance": "NO oscilloscope-class bandwidth / ENOB / sample-rate / "
                                       "timing-accuracy claimed — none of the supporting design "
                                       "(fast ADC, clocking, memory, FPGA, layout) is implemented"},
            "status": "unsupported"}


def stimulus_report():
    return {"board": "function-generator-lite / stimulus starter",
            "supported_now": ["DAC component class (planning)", "reference voltage",
                              "output protection placeholder", "calibration loopback",
                              "waveform update interface (I2C/SPI)", "output connector", "FL-1 hooks"],
            "placeholders_not_implemented": ["output amplifier", "reconstruction/anti-image filter"],
            "unsupported_blockers": ["funcgen-class waveform quality not supported",
                                     "DAC footprint/ingestion incomplete", "op-amp pattern needs reference"],
            "honesty": {"performance": "NO frequency-range / distortion / amplitude-accuracy / "
                                       "waveform-quality claimed unless the DAC + op-amp + clocking + "
                                       "layout support it (they do not yet)"},
            "status": "needs_reference"}


def logic_capture_report():
    return {"board": "logic capture starter",
            "supported_now": ["protected digital inputs", "series-R + clamp", "level-shift rails",
                              "configurable thresholds (comparator, planning)", "channel grouping",
                              "trigger input", "connector options", "FL-1 hooks"],
            "placeholders_not_implemented": ["timestamp/capture controller", "capture memory"],
            "unsupported_blockers": ["timing capture / logic-analyzer-class not implemented",
                                     "capture controller + memory + timing constraints unsupported"],
            "honesty": {"performance": "NO logic-analyzer-class sample-rate / timing-resolution claimed"},
            "status": "needs_simulation"}


def fpga_module_carrier_report():
    return {"board": "FPGA / module carrier starter (FL-1 instruments only)",
            "supported_now": ["module connector planning", "JTAG/SWD/debug header",
                              "power rails", "clock input", "GPIO banks",
                              "high-speed pair detection", "FL-1 hooks"],
            "unsupported": {"unsupported_bga_fanout": True, "unsupported_ddr": True,
                            "unsupported_pcie": True, "unsupported_mipi": True,
                            "unsupported_high_speed_memory": True},
            "honesty": {"scope": "module-based ONLY — raw dense-BGA FPGA fanout, DDR, PCIe, and "
                                 "MIPI are explicitly UNSUPPORTED, not faked"},
            "status": "needs_reference"}


# ---- Phase 9: manufacturing capability match --------------------------------
_MFG = {
    "controller_backplane_fixture_io": "standard_4_layer_possible",
    "relay_probe_matrix": "standard_4_layer_possible",
    "programmable_power_current_monitor": "standard_4_layer_possible",
    "calibration_reference": "standard_4_layer_possible",
    "dmm_lite_measurement": "controlled_impedance_quote_required",
    "external_instrument_interface": "controlled_impedance_quote_required",
    "trigger_sync_clock": "standard_4_layer_possible",
    "rf_50ohm_interface": "RF_specialist_fab_required",
    "hs_dac_stimulus_starter": "controlled_impedance_quote_required",
    "logic_capture_starter": "advanced_assembly_required",
    "fpga_module_carrier_starter": "HDI_quote_required",
    "hs_adc_capture_starter": "specialist_instrument_board_required",
    "unsupported_fl1_advanced": "not_manufacturable_with_current_constraints",
}


def manufacturing_capability():
    out = []
    for cls, tax in EXOTIC_TAXONOMY.items():
        out.append({"class": cls, "capability": _MFG.get(cls, "not_manufacturable_with_current_constraints"),
                    "controlled_impedance_needed": "controlled" in tax.get("stackup", ""),
                    "complexity": tax["manufacturing_complexity"]})
    return {"boards": out,
            "honesty": "capability is a planning classification, not a fab commitment — "
                       "controlled-impedance / RF / HDI / specialist boards need a real quote"}


# ---- Phase 10: reference-pattern readiness map ------------------------------
_PATTERN_MAP = {
    "precision_voltage_reference": "needs_reference_design", "resistor_divider_ladder": "available_internal",
    "current_sense": "pattern_backed", "precision_adc": "pattern_backed", "analog_mux": "reference_only",
    "dac_output": "needs_reference_design", "output_amplifier": "needs_reference_design",
    "protected_input": "available_internal", "relay_matrix": "pattern_backed",
    "efuse_protected_rail": "needs_reference_design", "programmable_rail": "needs_reference_design",
    "swd_jtag_uart_bringup": "pattern_backed", "usb_diff_pair": "available_internal",
    "ethernet_lxi": "needs_reference_design", "rf_sma_bnc_50ohm": "reference_only",
    "trigger_sync_io": "available_internal", "clock_distribution": "needs_reference_design",
    "calibration_loopback": "needs_reference_design", "board_id_eeprom": "available_internal",
    "fpga_module_carrier": "needs_reference_design",
}


def pattern_readiness():
    return {"patterns": [{"pattern": k, "status": v} for k, v in _PATTERN_MAP.items()],
            "summary": {s: sum(1 for v in _PATTERN_MAP.values() if v == s)
                        for s in set(_PATTERN_MAP.values())}}


def board_family_map():
    return {"version": "v1", "boards": [
        {"class": cls, "name": name, "readiness": rd, "candidate_components": comps,
         "blockers": blockers, "manufacturing": _MFG.get(cls),
         "taxonomy": {k: EXOTIC_TAXONOMY[cls][k] for k in
                      ("purpose", "required_interfaces", "fl1_hooks", "unsupported_risks")}}
        for cls, name, rd, comps, blockers in BOARD_FAMILY]}


def _md(title, obj):
    return "# %s\n\n```json\n%s\n```\n" % (title, json.dumps(obj, indent=1))


def generate_all(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    reports = {
        "fl1-exotic-board-taxonomy": {"version": 1, "classes": EXOTIC_TAXONOMY},
        "fl1-board-family-architecture": board_family_map(),
        "fl1-instrument-bus-v1": INSTRUMENT_BUS,
        "fl1-rf-50ohm-interface-report": rf_50ohm_report(),
        "fl1-scope-lite-starter-report": scope_lite_report(),
        "fl1-stimulus-starter-report": stimulus_report(),
        "fl1-logic-capture-starter-report": logic_capture_report(),
        "fl1-fpga-module-carrier-report": fpga_module_carrier_report(),
        "fl1-manufacturing-capability-report": manufacturing_capability(),
        "fl1-reference-pattern-readiness": pattern_readiness(),
    }
    for name, obj in reports.items():
        json.dump(obj, open(os.path.join(out_dir, name + ".json"), "w"), indent=1)
        open(os.path.join(out_dir, name + ".md"), "w").write(_md(name, obj))
    return list(reports.keys())


if __name__ == "__main__":
    import sys
    names = generate_all(sys.argv[1] if len(sys.argv) > 1 else ".")
    print("FL1_REPORTS " + " ".join(names))
