"""FL-1 validation workflows, evidence, and the build->validation readiness bridge
(Phase 14 P6-11).

Sequences instrument commands into board-bring-up workflows, defines the evidence
model, and bridges Phase 13 build-readiness to validation-readiness. The hard rail:
a do_not_build board can only be validation_ready_with_mock (SIMULATED) — never
physically validation-ready, never via an internal-board adapter.
"""
import instruments as ins


def run_workflow(wf, adapter=None, run_id="run-mock"):
    """Execute a workflow's command sequence through an adapter (default: mock).
    Produces an evidence run. A MOCK adapter yields simulated_only — NEVER a
    physical pass. A do_not_build board (physical_ready=False) is physical-blocked."""
    adapter = adapter or ins.MockAdapter()
    log, records, warnings, errors = [], [], [], []
    for s in wf["command_sequence"]:
        prim = s["primitive"]
        if prim in ("assert_adapter_available", "assert_calibrated", "assert_safety_interlock",
                    "wait", "compare_threshold", "record_evidence", "safe_shutdown") and "command" not in s:
            log.append({"primitive": prim, "status": "ok", "note": s.get("note", "")})
            continue
        cmd = ins.command_envelope(s.get("command", prim),
                                   target_node=s.get("target_node"), channel=s.get("channel"),
                                   parameters=s.get("parameters", {}),
                                   expected_range=s.get("expected_range"),
                                   safety_limits=s.get("safety_limits", {}))
        res = adapter.execute(cmd)
        log.append({"primitive": prim, "command": cmd["command_name"], "status": res["status"],
                    "value": res["value"], "pass_fail": res["pass_fail_result"],
                    "evidence_status": res["evidence_status"]})
        if res["status"] == "ok" and res["value"] is not None:
            records.append({"node": s.get("target_node"), "value": res["value"],
                            "evidence_status": res["evidence_status"]})
        warnings += res["warnings"]
        errors += res["errors"]
    is_mock = getattr(adapter, "adapter_type", "mock") == "mock"
    ev_status = "simulated_evidence" if is_mock else "physical_evidence"
    fails = [x for x in log if x.get("pass_fail") == "fail"]
    # verdict: a mock run can only be simulated_pass/simulated_fail — never physical
    if is_mock:
        verdict = "simulated_fail" if fails else "simulated_pass"
    else:
        verdict = "fail" if fails else "pass"
    if not wf.get("physical_ready", True):
        physical = "physical_blocked (build status do_not_build/unsupported)"
    elif is_mock:
        physical = "not_attempted (mock run — physical evidence requires COTS/internal)"
    else:
        physical = verdict
    return {"run_id": run_id, "board_id": wf["target_board"], "board_revision": wf["target_revision"],
            "workflow_name": wf["workflow_name"], "adapter_list": [getattr(adapter, "adapter_id", "mock")],
            "command_log": log, "measurement_records": records, "warnings": list(dict.fromkeys(warnings)),
            "errors": errors, "calibration_state": "simulated" if is_mock else "unknown",
            "evidence_status": ev_status, "final_verdict": verdict,
            "physical_validation": physical}

# ---- Phase 6: workflow model -----------------------------------------------
PRIMITIVES = ["assert_adapter_available", "assert_calibrated", "assert_safety_interlock",
              "set_power", "wait", "measure_voltage", "measure_current", "read_digital",
              "write_digital", "route_channel", "flash_firmware", "open_serial_console",
              "run_bus_test", "capture_waveform", "generate_signal", "compare_threshold",
              "record_evidence", "safe_shutdown"]

EVIDENCE_STATUSES = ("physical_evidence", "simulated_evidence", "manual_evidence",
                     "external_tool_evidence", "missing_evidence", "invalid_evidence")

VALIDATION_STATUSES = ("validation_ready_with_mock", "validation_ready_with_cots",
                       "validation_ready_with_internal_board", "validation_ready_with_review",
                       "needs_adapter", "needs_calibration", "do_not_validate_physical",
                       "unsupported")


def _step(prim, **kw):
    kw["primitive"] = prim
    return kw


def workflow(name, board, steps, **kw):
    return {
        "workflow_name": name, "target_board": board, "target_revision": kw.get("rev", "A"),
        "required_adapters": kw.get("adapters", ["mock"]),
        "required_capabilities": sorted({s.get("command", s["primitive"]) for s in steps
                                         if s["primitive"] not in ("wait", "compare_threshold",
                                         "record_evidence", "assert_adapter_available",
                                         "assert_calibrated", "assert_safety_interlock", "safe_shutdown")}),
        "preconditions": kw.get("preconditions", ["adapter available"]),
        "safety_gates": kw.get("safety", ["safety interlock", "safe shutdown on exit"]),
        "command_sequence": steps,
        "pass_fail_thresholds": kw.get("thresholds", {}),
        "evidence_requirements": kw.get("evidence", "physical_or_cots for a physical verdict; "
                                        "simulated evidence is workflow-logic only"),
        "failure_diagnosis_mapping": kw.get("failure_map", {}),
        "cleanup_actions": kw.get("cleanup", ["disable_power", "safe_disconnect"]),
        "physical_ready": kw.get("physical_ready", True),
    }


# ---- Phase 7: FL-1 board-class workflow templates --------------------------
def fl1_workflow_templates(build_readiness=None):
    br = {b["board"]: b["recommendation"] for b in (build_readiness or {}).get("boards", [])}

    def phys_ok(board):
        return br.get(board) not in ("do_not_build", "unsupported")

    wf = []
    wf.append(workflow("digital_bringup_bringup", "digital_bringup", [
        _step("assert_adapter_available"), _step("set_power", command="set_power", rail="DUT_3V3",
              voltage=3.3, current_limit=0.1, safety_limits={"max_voltage": 3.6, "max_current": 0.15}),
        _step("measure_voltage", command="measure_voltage", target_node="+3V3", expected_range=[3.2, 3.4]),
        _step("read_bus", command="read_bus", bus="I2C", address="0x50", note="board ID EEPROM"),
        _step("write_digital", command="write_digital", target_node="GPIO0", level=1),
        _step("read_digital", command="read_digital", target_node="GPIO_LOOP", expected_range=[1, 1]),
        _step("run_bus_test", command="run_bus_test", bus="UART"),
        _step("run_bus_test", command="run_bus_test", bus="SPI"),
        _step("safe_shutdown", command="disable_power")],
        adapters=["mock", "cots_scpi"], physical_ready=phys_ok("digital_bringup")))

    wf.append(workflow("controller_backplane_bringup", "controller_backplane", [
        _step("assert_safety_interlock"),
        _step("measure_voltage", command="measure_voltage", target_node="VIN", expected_range=[11.5, 24.5]),
        _step("read_bus", command="read_bus", bus="I2C", address="0x50"),
        _step("measure_continuity", command="measure_continuity", **{"from": "FIXTURE_A", "to": "FIXTURE_A_RET"}),
        _step("read_digital", command="read_digital", target_node="TRIG"),
        _step("read_digital", command="read_digital", target_node="FAULT"),
        _step("safe_shutdown")], adapters=["mock", "cots_scpi"]))

    wf.append(workflow("relay_probe_matrix_bringup", "relay_probe_matrix", [
        _step("assert_safety_interlock"),
        _step("route_channel", command="route_channel", **{"from": "DMM_HI", "to": "CH0"}),
        _step("measure_continuity", command="measure_continuity", **{"from": "DMM_HI", "to": "CH0"}),
        _step("disconnect_channel", command="disconnect_channel", **{"from": "DMM_HI", "to": "CH0"}),
        _step("safe_shutdown", command="disconnect_channel")],
        adapters=["mock", "fl1_internal_board", "cots_scpi"], physical_ready=phys_ok("relay_probe_matrix")))

    wf.append(workflow("power_current_monitor_bringup", "power_current_monitor", [
        _step("set_power", command="set_power", rail="DUT_OUT", voltage=5.0, current_limit=0.5,
              safety_limits={"max_voltage": 5.5, "max_current": 0.6}),
        _step("measure_voltage", command="measure_voltage", target_node="DUT_OUT", expected_range=[4.9, 5.1]),
        _step("measure_current", command="measure_current", target_node="SHUNT"),
        _step("safe_shutdown", command="disable_power")],
        adapters=["mock", "cots_scpi"], physical_ready=phys_ok("power_current_monitor")))

    # calibration/reference — physical BLOCKED if Phase 13 do_not_build
    cal_phys = phys_ok("calibration_reference")
    wf.append(workflow("calibration_reference_verify", "calibration_reference", [
        _step("read_bus", command="read_bus", bus="I2C", address="0x50", note="board ID"),
        _step("verify_reference", command="verify_reference", target_node="REF_OUT",
              parameters={"expected": 2.5}, expected_range=[2.495, 2.505]),
        _step("measure_voltage", command="measure_voltage", target_node="REF_OUT", expected_range=[2.495, 2.505]),
        _step("measure_voltage", command="measure_voltage", target_node="REF_DIV", expected_range=[1.245, 1.255]),
        _step("compare_threshold", note="REF_DIV/REF_OUT ~ 0.5 divider ratio"),
        _step("record_evidence")],
        adapters=["mock", "cots_scpi"], physical_ready=cal_phys,
        evidence=("do_not_build (blocked_by_grid_resolution): mock/simulated ONLY; "
                  "no physical validation until the board is buildable" if not cal_phys
                  else "physical_or_cots")))

    wf.append(workflow("dmm_lite_bringup", "dmm_lite", [
        _step("measure_voltage", command="measure_voltage", target_node="VIN", expected_range=[-30, 30]),
        _step("verify_reference", command="verify_reference", target_node="REF_OUT", parameters={"expected": 2.5}),
        _step("record_evidence")], adapters=["mock", "cots_scpi"],
        thresholds={"accuracy_class": "unknown unless calibrated"}, physical_ready=phys_ok("dmm_lite")))

    wf.append(workflow("external_instrument_interface_bringup", "external_instrument_interface", [
        _step("open_serial_console", command="open_serial_console", port="USB0"),
        _step("read_digital", command="read_digital", target_node="TRIG_IN"),
        _step("write_digital", command="write_digital", target_node="TRIG_OUT", level=1),
        _step("measure_continuity", command="measure_continuity", **{"from": "SMA", "to": "SMA_RET"}),
        _step("record_evidence")], adapters=["mock", "cots_serial"]))

    wf.append(workflow("stimulus_funcgen_lite_bringup", "stimulus_funcgen_lite", [
        _step("generate_signal", command="generate_signal", channel="OUT", waveform="sine",
              frequency=1000, amplitude=1.0),
        _step("measure_voltage", command="measure_voltage", target_node="OUT_LOOPBACK"),
        _step("record_evidence")], adapters=["mock", "cots_scpi"],
        thresholds={"frequency_amplitude": "advisory unless measured/calibrated"},
        physical_ready=phys_ok("stimulus_funcgen_lite"),
        evidence="NO function-generator-class claim; amplitude/frequency advisory unless measured"))

    wf.append(workflow("logic_capture_bringup", "logic_capture", [
        _step("read_digital", command="read_digital", target_node="CH0"),
        _step("capture_logic", command="capture_logic", channels=["CH0", "CH1"]),
        _step("record_evidence")], adapters=["mock", "cots_usb"],
        thresholds={"timing_class": "NO logic-analyzer-class timing claim"},
        physical_ready=phys_ok("logic_capture"),
        evidence="capture is simulated or external_tool_required; no analyzer-class timing"))

    wf.append(workflow("scope_lite_bringup", "scope_lite", [
        _step("capture_waveform", command="capture_waveform", channel="CH0"),
        _step("record_evidence")], adapters=["mock", "cots_scpi"], physical_ready=False,
        evidence="scope-lite is unsupported/future; an EXTERNAL oscilloscope adapter may "
                 "validate signals. NO oscilloscope-class claim"))

    return {"version": "v1", "workflow_count": len(wf), "primitives": PRIMITIVES, "workflows": wf}


# ---- Phase 8: evidence model -----------------------------------------------
def evidence_model():
    return {
        "version": "v1", "evidence_statuses": list(EVIDENCE_STATUSES),
        "run_fields": ["run_id", "board_id", "board_revision", "workflow_name", "adapter_list",
                       "command_log", "measurement_records", "raw_adapter_responses",
                       "pass_fail_results", "warnings", "errors", "calibration_state",
                       "manual_steps", "timestamps", "artifact_links", "final_verdict"],
        "rules": ["simulated_evidence CANNOT satisfy physical build validation",
                  "manual_evidence must be marked manual",
                  "external COTS evidence must include adapter/instrument identity",
                  "internal board evidence must include board identity + calibration state"],
    }


# ---- Phase 9: build-readiness -> validation-readiness bridge ---------------
def validation_readiness(build_readiness, workflow_templates=None, available_adapters=None):
    """The bridge. A do_not_build board is validation_ready_with_mock ONLY."""
    wfs = {w["target_board"]: w for w in (workflow_templates
           or fl1_workflow_templates(build_readiness))["workflows"]}
    avail = set(available_adapters or ["mock"])   # mock always available for dev
    out = []
    for b in build_readiness.get("boards", []):
        name = b["board"]
        rec = b["recommendation"]
        wf = wfs.get(name)
        req = set(wf["required_adapters"]) if wf else set()
        has_cots = any(a.startswith("cots") for a in avail)
        if rec == "unsupported":
            status = "unsupported"
        elif rec == "do_not_build":
            # mock only — physical validation is blocked, internal-board adapter forbidden
            status = "validation_ready_with_mock"
        elif rec in ("ready_to_build", "ready_to_build_with_review"):
            status = ("validation_ready_with_cots" if has_cots and "cots_scpi" in req
                      else "validation_ready_with_review")
        elif rec in ("needs_ingestion", "needs_reference"):
            status = "validation_ready_with_mock"     # design/logic only until parts exist
        elif rec == "needs_external_tool":
            status = "validation_ready_with_review"
        else:
            status = "needs_adapter"
        out.append({
            "board": name, "board_class": b.get("board_class"),
            "build_recommendation": rec,
            "workflow_available": wf is not None,
            "required_adapters": sorted(req),
            "available_adapters": sorted(avail & req) or (["mock"] if "mock" in avail else []),
            "mock_only_adapters": ["mock"],
            "external_cots_alternatives": sorted(a for a in req if a.startswith("cots")),
            "internal_board_future_adapter": (rec not in ("do_not_build", "unsupported")),
            "missing_capabilities": [] if wf else ["no workflow template"],
            "physical_validation_blocked": rec in ("do_not_build", "unsupported"),
            "validation_readiness_status": status,
            "exact_blockers": b.get("exact_blockers", [])[:2],
        })
    return {"version": "v1", "board_count": len(out), "boards": out}


# ---- Phase 10: instrument command DSL --------------------------------------
def command_dsl():
    return {
        "version": "v1",
        "examples": {
            "measure_voltage": {"command": "measure_voltage", "target_node": "REF_OUT",
                                "expected_range": [2.495, 2.505], "units": "V",
                                "adapter": "dmm_or_internal", "evidence_required": "physical_or_cots"},
            "set_power": {"command": "set_power", "rail": "DUT_3V3", "voltage": 3.3,
                          "current_limit": 0.1, "adapter": "programmable_supply",
                          "safety_limits": {"max_voltage": 3.6, "max_current": 0.15}},
            "route_channel": {"command": "route_channel", "from": "DMM_HI", "to": "TP_REF_OUT",
                              "adapter": "relay_matrix_or_internal", "safe_disconnect_after": True},
        },
        "schema": {"required": ["command"], "optional": ["target_node", "channel", "parameters",
                   "expected_range", "units", "adapter", "safety_limits", "evidence_required"]},
    }


# ---- Phase 11: validation package v2 ---------------------------------------
def validation_package_v2(board, build_readiness, workflow_templates=None):
    wfs = {w["target_board"]: w for w in (workflow_templates
           or fl1_workflow_templates(build_readiness))["workflows"]}
    wf = wfs.get(board)
    vr = {v["board"]: v for v in validation_readiness(build_readiness, workflow_templates).get("boards", [])}
    v = vr.get(board, {})
    return {
        "version": "v2", "board": board, "workflow": wf,
        "required_capabilities": wf["required_capabilities"] if wf else [],
        "compatible_adapters": wf["required_adapters"] if wf else [],
        "mock_workflow_option": True,
        "cots_workflow_option": any(a.startswith("cots") for a in (wf["required_adapters"] if wf else [])),
        "internal_board_future_option": v.get("internal_board_future_adapter", False),
        "command_sequence": wf["command_sequence"] if wf else [],
        "expected_measurement_thresholds": wf["pass_fail_thresholds"] if wf else {},
        "evidence_requirements": wf["evidence_requirements"] if wf else "n/a",
        "safe_shutdown_sequence": wf["cleanup_actions"] if wf else [],
        "final_validation_verdict_rules": {
            "physical_pass_requires": "physical_or_cots evidence + all thresholds pass",
            "simulated_runs_yield": "simulated_only (never a physical pass)",
            "physical_blocked": v.get("physical_validation_blocked", False),
        },
    }
