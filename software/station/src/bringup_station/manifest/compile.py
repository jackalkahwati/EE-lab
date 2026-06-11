"""Compile a DesignManifest into an executable (Board, TestPlan) pair.

Bring-up order is fixed and safety-driven:

1. Pre-power gate (resistance/diode checks) — any failure aborts before power
2. Power inputs in declared sequence order, with inrush limits
3. Firmware programming (board must be powered)
4. Rail checks
5. Clock checks
6. Thermal check
7. Power off
"""

from __future__ import annotations

from typing import List, Tuple

from ..boardio.testpoints import Board, TestPoint
from ..sequencer.plan import Action, Limits, Step, TestPlan
from .schema import DesignManifest

#: stand-in for "no upper bound" that stays plain-JSON serializable
BIG = 1e12


class ManifestError(ValueError):
    pass


def compile_manifest(manifest: DesignManifest) -> Tuple[Board, TestPlan]:
    problems = manifest.validate()
    if problems:
        raise ManifestError("; ".join(problems))

    board = Board(name="{} rev {}".format(manifest.name, manifest.revision))
    for tp in manifest.testpoints:
        board.testpoints[tp.name] = TestPoint(name=tp.name, net=tp.net,
                                              x_mm=tp.x_mm, y_mm=tp.y_mm)

    steps: List[Step] = []

    # 1. pre-power safety gate
    for pc in manifest.prepower:
        limits = Limits(lo=pc.min_value if pc.min_value is not None else -BIG,
                        hi=pc.max_value if pc.max_value is not None else BIG)
        action = (Action.MEASURE_RESISTANCE if pc.kind == "resistance"
                  else Action.MEASURE_DIODE)
        steps.append(Step(action=action, target=pc.testpoint,
                          params={"probe": 0, "ref": pc.ref}, limits=limits,
                          gate=True,
                          label="pre-power {} {} vs {}".format(
                              pc.kind, pc.testpoint, pc.ref)))

    # 2. sequenced power-up
    for pi in sorted(manifest.power_inputs, key=lambda p: p.order):
        params = {"channel": pi.channel, "volts": pi.volts,
                  "current_limit_a": pi.current_limit_a}
        limits = None
        if pi.inrush_max_a is not None:
            params["inrush_max_a"] = pi.inrush_max_a
            limits = Limits(lo=0.0, hi=pi.inrush_max_a)
        steps.append(Step(action=Action.SET_POWER, params=params,
                          limits=limits, gate=True,
                          label="power {} ({} V on ch{})".format(
                              pi.name, pi.volts, pi.channel)))

    # 3. firmware
    if manifest.firmware:
        params = {"image": manifest.firmware.image}
        if manifest.firmware.expect_target_id:
            params["expect_id"] = manifest.firmware.expect_target_id
        steps.append(Step(action=Action.PROGRAM_FIRMWARE, params=params,
                          gate=True, label="program firmware"))

    # 4. rails
    for rail in manifest.rails:
        steps.append(Step(action=Action.MEASURE_VOLTAGE, target=rail.testpoint,
                          params={"probe": 0},
                          limits=Limits(lo=rail.volts_min, hi=rail.volts_max),
                          label="rail {} at {}".format(rail.net, rail.testpoint)))

    # 5. clocks
    for clk in manifest.clocks:
        tol = clk.freq_hz * clk.tol_pct / 100.0
        sample_rate = max(1e6, clk.freq_hz * 20.0)
        duration = max(0.001, 10.0 / clk.freq_hz)
        steps.append(Step(action=Action.MEASURE_FREQUENCY, target=clk.testpoint,
                          params={"probe": 0, "sample_rate_hz": sample_rate,
                                  "duration_s": duration},
                          limits=Limits(lo=clk.freq_hz - tol,
                                        hi=clk.freq_hz + tol),
                          label="clock at {}".format(clk.testpoint)))

    # 6. thermal
    if manifest.max_board_temp_c is not None:
        steps.append(Step(action=Action.THERMAL_CHECK,
                          params={"max_temp_c": manifest.max_board_temp_c},
                          limits=Limits(lo=-BIG, hi=manifest.max_board_temp_c),
                          label="thermal check"))

    # 7. power down
    steps.append(Step(action=Action.POWER_OFF, label="power off"))

    plan = TestPlan(name="bring-up {}".format(board.name), board=board.name,
                    steps=steps)
    return board, plan
