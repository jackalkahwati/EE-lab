"""Instrument capability model + adapter layer (Phase 14 P1-5).

One common command layer so an FL-1 validation workflow can `measure_voltage`,
`set_power`, `route_channel`, `flash_firmware`, ... regardless of whether the
instrument behind it is a MOCK (development/regression), an external COTS instrument
(Keysight/Tek/Keithley/...), or a future internal FL-1 board.

Hard rails:
  - a MOCK adapter produces SIMULATED evidence only — never physical.
  - a board Phase 13 marks do_not_build/unsupported is exposed as future_internal_board
    or mock_only, NEVER as a physically-available internal adapter.
  - nothing here performs or claims a real measurement.
"""
import json

# ---- Phase 1: instrument capability model ----------------------------------
ADAPTERS = ("mock", "cots_scpi", "cots_usb", "cots_serial", "cots_lxi",
            "fl1_internal_board", "manual", "unsupported")


def _cap(name, action, inputs, out, units=None, rng=None, **kw):
    return {
        "capability": name, "command": name, "action_type": action,
        "required_inputs": inputs, "output_schema": out, "units": units, "ranges": rng,
        "resolution": kw.get("resolution"), "accuracy": kw.get("accuracy"),
        "timing": kw.get("timing"), "calibration_requirements": kw.get("calibration", "none"),
        "safety_requirements": kw.get("safety", []),
        "supported_adapters": kw.get("adapters", ["mock", "cots_scpi", "fl1_internal_board"]),
        "simulated_support": kw.get("sim", True),
        "internal_fl1_support": kw.get("internal", "future"),   # future|mock_only|available|unsupported
        "external_cots_support": kw.get("cots", True),
        "unsupported": kw.get("unsupported", False),
        "evidence_requirement": kw.get("evidence", "physical_or_cots"),
    }


CAPABILITIES = [
    # measurement
    _cap("measure_voltage", "measure", ["target_node"], {"value": "float"}, "V", [-60, 60],
         resolution="adapter-dependent", accuracy="adapter/calibration-dependent"),
    _cap("measure_current", "measure", ["target_node"], {"value": "float"}, "A", [-10, 10]),
    _cap("measure_resistance", "measure", ["target_node"], {"value": "float"}, "ohm", [0, 1e7]),
    _cap("measure_continuity", "measure", ["from", "to"], {"continuous": "bool"}, "bool"),
    _cap("capture_waveform", "measure", ["channel"], {"samples": "array", "t0": "float", "dt": "float"},
         "V", accuracy="scope-dependent", cots=True, internal="unsupported",
         calibration="scope calibration", evidence="external_tool_or_cots"),
    _cap("capture_logic", "measure", ["channels"], {"transitions": "array"}, "bool",
         internal="mock_only", evidence="external_tool_or_cots"),
    _cap("read_digital", "measure", ["target_node"], {"level": "int"}, "logic"),
    _cap("read_bus", "measure", ["bus", "address"], {"data": "bytes"}, "bytes"),
    _cap("measure_frequency", "measure", ["channel"], {"value": "float"}, "Hz", [0, 1e8]),
    _cap("measure_duty_cycle", "measure", ["channel"], {"value": "float"}, "%", [0, 100]),
    # stimulus
    _cap("set_power", "stimulus", ["rail", "voltage"], {"applied": "bool"}, "V", [0, 60],
         safety=["max_voltage", "max_current"], calibration="supply calibration"),
    _cap("disable_power", "stimulus", ["rail"], {"applied": "bool"}, "bool", safety=["safe_ramp_down"]),
    _cap("set_voltage_limit", "stimulus", ["rail", "voltage"], {"set": "bool"}, "V"),
    _cap("set_current_limit", "stimulus", ["rail", "current"], {"set": "bool"}, "A"),
    _cap("generate_signal", "stimulus", ["channel", "waveform", "frequency", "amplitude"],
         {"active": "bool"}, "V", internal="mock_only", cots=True,
         evidence="advisory_unless_measured"),
    _cap("write_digital", "stimulus", ["target_node", "level"], {"set": "bool"}, "logic"),
    _cap("drive_gpio", "stimulus", ["pin", "level"], {"set": "bool"}, "logic"),
    _cap("run_bus_test", "stimulus", ["bus"], {"ok": "bool", "devices": "array"}, "bool"),
    # routing
    _cap("route_channel", "routing", ["from", "to"], {"routed": "bool"}, "bool",
         adapters=["mock", "fl1_internal_board", "cots_scpi"], cots=True,
         safety=["safe_disconnect_after"]),
    _cap("disconnect_channel", "routing", ["from", "to"], {"disconnected": "bool"}, "bool"),
    _cap("select_probe", "routing", ["probe"], {"selected": "bool"}, "bool"),
    _cap("connect_fixture_node", "routing", ["node"], {"connected": "bool"}, "bool"),
    _cap("isolate_node", "routing", ["node"], {"isolated": "bool"}, "bool"),
    # firmware / bring-up
    _cap("flash_firmware", "firmware", ["image", "target"], {"flashed": "bool"}, "bool",
         adapters=["mock", "cots_usb", "cots_serial"], cots=True, internal="future"),
    _cap("reset_target", "firmware", ["target"], {"reset": "bool"}, "bool"),
    _cap("read_boot_log", "firmware", ["target"], {"log": "string"}, "text"),
    _cap("open_serial_console", "firmware", ["port"], {"opened": "bool"}, "bool",
         adapters=["mock", "cots_serial"]),
    _cap("run_self_test", "firmware", ["target"], {"passed": "bool"}, "bool"),
    # calibration / evidence
    _cap("calibrate_channel", "calibration", ["channel", "reference"], {"calibrated": "bool"}, "bool",
         calibration="traceable reference required", evidence="physical_or_cots"),
    _cap("read_calibration_state", "calibration", ["channel"], {"state": "string"}, "text"),
    _cap("verify_reference", "calibration", ["reference_node", "expected"], {"ok": "bool"}, "bool"),
    _cap("record_measurement", "evidence", ["record"], {"stored": "bool"}, "bool"),
    _cap("attach_evidence", "evidence", ["uri"], {"attached": "bool"}, "bool"),
    _cap("generate_validation_report", "evidence", ["run_id"], {"report_uri": "string"}, "text"),
]


def capability_model():
    return {"version": "v1", "adapter_types": list(ADAPTERS),
            "capability_count": len(CAPABILITIES), "capabilities": CAPABILITIES}


def get_cap(name):
    return next((c for c in CAPABILITIES if c["capability"] == name), None)


# ---- Phase 2: adapter interface (envelopes) --------------------------------
def command_envelope(command, **kw):
    return {"command_id": kw.get("command_id", command + "-1"), "command_name": command,
            "target_node": kw.get("target_node"), "channel": kw.get("channel"),
            "parameters": kw.get("parameters", {}), "expected_range": kw.get("expected_range"),
            "timeout": kw.get("timeout", 5.0), "safety_limits": kw.get("safety_limits", {}),
            "required_calibration": kw.get("required_calibration", "none"),
            "evidence_policy": kw.get("evidence_policy", "physical_or_cots")}


def result_envelope(cmd, status, value=None, **kw):
    return {"command_id": cmd["command_id"], "command_name": cmd["command_name"],
            "status": status, "value": value, "units": kw.get("units"),
            "timestamp": kw.get("timestamp", "<stamped-at-run>"),
            "adapter_id": kw.get("adapter_id"), "calibration_state": kw.get("calibration_state", "uncalibrated"),
            "raw_response": kw.get("raw_response"), "evidence_uri": kw.get("evidence_uri"),
            "evidence_status": kw.get("evidence_status", "missing_evidence"),
            "warnings": kw.get("warnings", []), "errors": kw.get("errors", []),
            "pass_fail_result": kw.get("pass_fail_result")}


def adapter_interface():
    return {
        "version": "v1", "adapter_types": list(ADAPTERS),
        "required_adapter_fields": ["adapter_id", "adapter_type", "instrument_name",
                                    "vendor_model", "transport", "supported_capabilities",
                                    "unsupported_capabilities", "connection_settings",
                                    "safety_limits", "calibration_state", "health",
                                    "command_mapping", "evidence_output", "error_handling"],
        "command_envelope_fields": list(command_envelope("x").keys()),
        "result_envelope_fields": list(result_envelope(command_envelope("x"), "ok").keys()),
        "transports": ["mock", "SCPI", "USBTMC", "serial", "Ethernet_LXI", "internal_bus"],
    }


# ---- Phase 3: mock adapter -------------------------------------------------
class MockAdapter:
    """Simulated instrument. Values are FAKE and marked simulated_evidence — they can
    validate WORKFLOW LOGIC only, never physical build validation."""
    adapter_id = "mock-0"
    adapter_type = "mock"
    instrument_name = "FirstLight mock instrument"
    SUPPORTED = {"measure_voltage", "measure_current", "read_digital", "write_digital",
                 "set_power", "disable_power", "route_channel", "disconnect_channel",
                 "flash_firmware", "read_boot_log", "generate_signal", "capture_waveform",
                 "capture_logic", "read_bus", "run_bus_test", "verify_reference",
                 "reset_target", "run_self_test", "record_measurement"}

    # fake but plausible values keyed by node, so demos are deterministic
    _NODE_V = {"DUT_3V3": 3.30, "+3V3": 3.30, "+5V": 5.00, "REF_OUT": 2.500, "REF_DIV": 1.250,
               "DUT_OUT": 5.00, "VIN": 12.0, "OUT_LOOPBACK": 1.00}

    def execute(self, cmd):
        name = cmd["command_name"]
        if name not in self.SUPPORTED:
            return result_envelope(cmd, "unsupported", None, adapter_id=self.adapter_id,
                                   errors=["mock does not implement %s" % name],
                                   evidence_status="invalid_evidence")
        val, warns = None, ["SIMULATED — not physical evidence"]
        if name == "measure_voltage":
            val = self._NODE_V.get(cmd.get("target_node"), 0.0)
        elif name == "measure_current":
            val = 0.012
        elif name in ("read_digital",):
            val = 1
        elif name in ("set_power", "disable_power", "route_channel", "disconnect_channel",
                      "write_digital", "flash_firmware", "reset_target", "run_self_test",
                      "run_bus_test", "generate_signal", "record_measurement"):
            val = True
        elif name == "read_boot_log":
            val = "[mock] boot ok"
        elif name == "verify_reference":
            exp = (cmd.get("parameters") or {}).get("expected", 2.5)
            val = abs(self._NODE_V.get(cmd.get("target_node"), 0.0) - exp) < 0.05
        elif name == "capture_waveform":
            val = {"samples": [0.0, 1.0, 0.0, -1.0, 0.0], "t0": 0.0, "dt": 1e-6, "note": "sample waveform"}
        elif name == "capture_logic":
            val = {"transitions": [[0, 0], [1e-6, 1]]}
        # pass/fail (workflow logic only). A bool result (verify_reference, route,
        # etc.) passes on True; a numeric result is range-checked. Note bool is a
        # subclass of int in Python, so exclude it from the numeric branch.
        pf = None
        er = cmd.get("expected_range")
        if isinstance(val, bool):
            pf = "pass" if val else "fail"
        elif er and isinstance(val, (int, float)):
            pf = "pass" if er[0] <= val <= er[1] else "fail"
        return result_envelope(cmd, "ok", val, adapter_id=self.adapter_id,
                               calibration_state="simulated", warnings=warns,
                               evidence_status="simulated_evidence", pass_fail_result=pf)


def mock_adapter_descriptor():
    return {"adapter_id": MockAdapter.adapter_id, "adapter_type": "mock",
            "instrument_name": MockAdapter.instrument_name, "vendor_model": "n/a",
            "transport": "mock", "supported_capabilities": sorted(MockAdapter.SUPPORTED),
            "unsupported_capabilities": sorted(c["capability"] for c in CAPABILITIES
                                               if c["capability"] not in MockAdapter.SUPPORTED),
            "calibration_state": "simulated", "health": "ok",
            "evidence_output": "simulated_evidence (NEVER physical)",
            "note": "mock values are fake; use for workflow-logic validation only"}


# ---- Phase 4: external COTS instrument specs -------------------------------
COTS_SPECS = [
    {"instrument": "programmable_power_supply", "adapter_type": "cots_scpi",
     "transports": ["SCPI over LXI", "SCPI over USBTMC"],
     "capabilities": ["set_power", "disable_power", "set_voltage_limit", "set_current_limit",
                      "measure_voltage", "measure_current"],
     "expected_evidence": "cots (instrument identity + reading)", "calibration": "vendor cal cert",
     "safety": ["OVP", "OCP"], "unsupported": [], "future_driver_work": "SCPI driver + LXI discovery"},
    {"instrument": "dmm", "adapter_type": "cots_scpi", "transports": ["SCPI over LXI", "USBTMC"],
     "capabilities": ["measure_voltage", "measure_current", "measure_resistance",
                      "measure_continuity", "measure_frequency"],
     "expected_evidence": "cots", "calibration": "traceable cal cert", "safety": [],
     "unsupported": [], "future_driver_work": "SCPI driver"},
    {"instrument": "oscilloscope", "adapter_type": "cots_scpi", "transports": ["SCPI over LXI", "USBTMC"],
     "capabilities": ["capture_waveform", "measure_frequency", "measure_duty_cycle"],
     "expected_evidence": "cots (waveform)", "calibration": "scope self-cal", "safety": [],
     "unsupported": [], "future_driver_work": "SCPI waveform transfer"},
    {"instrument": "function_generator", "adapter_type": "cots_scpi", "transports": ["SCPI over LXI"],
     "capabilities": ["generate_signal"], "expected_evidence": "cots", "calibration": "vendor cal",
     "safety": ["output limit"], "unsupported": [], "future_driver_work": "SCPI driver"},
    {"instrument": "logic_analyzer", "adapter_type": "cots_usb", "transports": ["USB", "vendor CLI"],
     "capabilities": ["capture_logic"], "expected_evidence": "cots (timing)", "calibration": "n/a",
     "safety": [], "unsupported": [], "future_driver_work": "vendor SDK integration"},
    {"instrument": "electronic_load", "adapter_type": "cots_scpi", "transports": ["SCPI over LXI"],
     "capabilities": ["set_current_limit", "measure_current", "measure_voltage"],
     "expected_evidence": "cots", "calibration": "vendor cal", "safety": ["OPP", "OCP"],
     "unsupported": [], "future_driver_work": "SCPI driver"},
    {"instrument": "relay_probe_matrix", "adapter_type": "cots_scpi", "transports": ["SCPI over LXI"],
     "capabilities": ["route_channel", "disconnect_channel", "select_probe", "isolate_node"],
     "expected_evidence": "cots", "calibration": "n/a", "safety": ["safe_disconnect"],
     "unsupported": [], "future_driver_work": "SCPI switch driver"},
    {"instrument": "programmer_swd_jtag_uart", "adapter_type": "cots_usb",
     "transports": ["USB", "vendor CLI"],
     "capabilities": ["flash_firmware", "reset_target", "run_self_test"],
     "expected_evidence": "cots (programmer log)", "calibration": "n/a", "safety": [],
     "unsupported": [], "future_driver_work": "OpenOCD/pyOCD wrapper"},
    {"instrument": "serial_console", "adapter_type": "cots_serial", "transports": ["serial"],
     "capabilities": ["open_serial_console", "read_boot_log"], "expected_evidence": "cots (log)",
     "calibration": "n/a", "safety": [], "unsupported": [], "future_driver_work": "pyserial wrapper"},
    {"instrument": "vna_or_spectrum_analyzer", "adapter_type": "unsupported",
     "transports": ["SCPI over LXI"], "capabilities": [],
     "expected_evidence": "external_tool_evidence", "calibration": "VNA cal kit",
     "safety": [], "unsupported": ["all RF characterization"],
     "future_driver_work": "external_tool_required — RF characterization is out of scope; no RF guarantee"},
]


def cots_spec():
    return {"version": "v1", "instrument_count": len(COTS_SPECS), "instruments": COTS_SPECS}


# ---- Phase 5: internal FL-1 board adapter specs (consume Phase 13) ---------
def internal_board_spec(build_readiness=None):
    """Future internal-board adapters. A board Phase 13 marks do_not_build/unsupported is
    exposed as future_internal_board or mock_only — NEVER physically available."""
    br = {b["board"]: b for b in (build_readiness or {}).get("boards", [])} if build_readiness else {}
    BOARD_CAPS = {
        "calibration_reference": ["verify_reference", "measure_voltage", "read_bus"],
        "dmm_lite": ["measure_voltage", "measure_current", "measure_resistance", "measure_continuity"],
        "power_current_monitor": ["set_power", "disable_power", "set_current_limit",
                                  "measure_voltage", "measure_current"],
        "relay_probe_matrix": ["route_channel", "disconnect_channel", "isolate_node", "select_probe"],
        "digital_bringup": ["read_digital", "write_digital", "drive_gpio", "run_bus_test",
                            "flash_firmware", "reset_target"],
        "external_instrument_interface": ["open_serial_console", "route_channel"],
        "stimulus_funcgen_lite": ["generate_signal"],
        "logic_capture": ["capture_logic", "read_digital"],
        "scope_lite": ["capture_waveform"],
    }
    boards = []
    for name, caps in BOARD_CAPS.items():
        rec = br.get(name, {}).get("recommendation", "unknown")
        if rec in ("do_not_build", "unsupported"):
            avail = "unsupported" if rec == "unsupported" else "mock_only"
        elif rec in ("ready_to_build", "ready_to_build_with_review"):
            avail = "future_internal_board"     # designed, not fabricated yet
        else:
            avail = "future_internal_board"
        boards.append({
            "board": name, "board_capabilities": caps,
            "instrument_commands": caps, "required_firmware": "FL-1 instrument fw (future)",
            "required_bus": "FL-1 instrument bus v1", "required_calibration_data": "traceable cal (future)",
            "required_safety_interlocks": ["power interlock", "safe disconnect"],
            "required_self_test": True, "required_evidence": "internal-board identity + calibration state",
            "phase13_build_readiness": rec, "adapter_availability": avail,
            "physically_available": False,
            "note": ("do_not_build -> mock_only, not physically available"
                     if rec == "do_not_build" else
                     "unsupported board -> no adapter" if rec == "unsupported" else
                     "designed; physical adapter exists only after fabrication"),
        })
    return {"version": "v1", "board_count": len(boards), "boards": boards}


if __name__ == "__main__":
    print(json.dumps(capability_model(), indent=1))
