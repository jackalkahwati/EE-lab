import pytest

from bringup_station.manifest.compile import ManifestError, compile_manifest
from bringup_station.manifest.schema import (ClockCheck, DesignManifest,
                                             FirmwareSpec, ManifestTestPoint,
                                             PowerInput, PrePowerCheck, Rail)
from bringup_station.sim import make_sim_machine


def make_manifest():
    return DesignManifest(
        name="env-sensor", revision="A",
        testpoints=[
            ManifestTestPoint("FID1", "", 0.0, 0.0),
            ManifestTestPoint("FID2", "", 100.0, 0.0),
            ManifestTestPoint("TP_VIN", "VIN", 5.0, 5.0),
            ManifestTestPoint("TP_3V3", "3V3", 10.0, 5.0),
            ManifestTestPoint("TP_CLK", "MCU_CLK", 15.0, 5.0),
        ],
        prepower=[
            PrePowerCheck(testpoint="TP_VIN", kind="resistance",
                          ref="gnd", min_value=100.0),
            PrePowerCheck(testpoint="TP_3V3", kind="resistance",
                          ref="gnd", min_value=100.0),
        ],
        power_inputs=[
            PowerInput(name="VIN", channel=0, volts=5.0,
                       current_limit_a=0.5, order=0, inrush_max_a=1.0),
        ],
        rails=[Rail(net="3V3", testpoint="TP_3V3",
                    volts_min=3.2, volts_max=3.4)],
        clocks=[ClockCheck(testpoint="TP_CLK", freq_hz=1000.0, tol_pct=5.0)],
        firmware=FirmwareSpec(image="env-sensor-a.hex",
                              expect_target_id="STM32G474"),
        max_board_temp_c=60.0,
    )


def healthy_sim():
    ctx = make_sim_machine()
    ctx.daq.channel_volts = {0: 3.3}      # 3V3 rail good
    # mock scope produces a 1 kHz sine, matching the clock spec
    return ctx


def test_compile_orders_bringup_correctly():
    board, plan = compile_manifest(make_manifest())
    actions = [s.action.value for s in plan.steps]
    assert actions == [
        "measure_resistance", "measure_resistance",   # pre-power gate
        "set_power",                                   # sequenced power
        "program_firmware",
        "measure_voltage",                             # rails
        "measure_frequency",                           # clocks
        "thermal_check",
        "power_off",
    ]
    assert all(s.gate for s in plan.steps[:4])
    assert board.point("TP_3V3").net == "3V3"


def test_healthy_board_passes_full_bringup():
    ctx = healthy_sim()
    board, plan = compile_manifest(make_manifest())
    report = ctx.engine.run(plan, board)
    assert report.passed, report.to_dict()
    assert ctx.programmer.programmed == ["env-sensor-a.hex"]
    assert not ctx.power.any_on  # powered down at the end


def test_short_circuit_gates_before_power():
    ctx = healthy_sim()
    ctx.smu.resistance_script = [3.0]  # VIN shorted to ground
    board, plan = compile_manifest(make_manifest())
    report = ctx.engine.run(plan, board)
    assert report.aborted
    assert ("output", 0, True) not in ctx.power.events  # never powered
    assert ctx.programmer.programmed == []


def test_excessive_inrush_aborts():
    ctx = healthy_sim()
    ctx.power.inrush_peak_a = {0: 2.5}  # over the 1.0 A manifest limit
    board, plan = compile_manifest(make_manifest())
    report = ctx.engine.run(plan, board)
    assert report.aborted
    assert "gate step failed" in report.abort_reason
    assert not ctx.power.any_on  # cleanup turned it back off


def test_wrong_mcu_detected_before_programming():
    ctx = healthy_sim()
    ctx.programmer.target_id = "UNKNOWN-DEVICE"
    board, plan = compile_manifest(make_manifest())
    report = ctx.engine.run(plan, board)
    assert report.aborted
    assert ctx.programmer.programmed == []


def test_dead_clock_fails_its_step():
    ctx = healthy_sim()
    manifest = make_manifest()
    # spec a 2 kHz clock; the (sim) board only produces 1 kHz
    manifest.clocks = [ClockCheck(testpoint="TP_CLK", freq_hz=2000.0,
                                  tol_pct=5.0)]
    board, plan = compile_manifest(manifest)
    report = ctx.engine.run(plan, board)
    assert not report.passed
    assert not report.aborted  # clock check is evidence, not a gate
    failed = [r for r in report.results if not r.ok]
    assert len(failed) == 1
    assert failed[0].value == pytest.approx(1000.0, rel=0.02)


def test_thermal_hotspot_fails_check():
    ctx = healthy_sim()
    ctx.thermal.hotspots = [(60, 80, 95.0)]  # reversed IC cooking at 95 C
    board, plan = compile_manifest(make_manifest())
    report = ctx.engine.run(plan, board)
    assert not report.passed
    failed = [r for r in report.results if not r.ok]
    assert failed[0].value == 95.0


def test_invalid_manifest_rejected():
    manifest = make_manifest()
    manifest.prepower.append(
        PrePowerCheck(testpoint="TP_MISSING", kind="resistance",
                      min_value=1.0))
    with pytest.raises(ManifestError):
        compile_manifest(manifest)
