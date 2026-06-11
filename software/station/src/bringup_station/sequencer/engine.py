"""Test plan execution.

Runs a TestPlan against a Board: transforms each test point through the board
registration, probes with force guarding, routes the matrix, measures,
evaluates limits, and produces a RunReport.

Gate steps (pre-power safety checks, power application, programming) abort
the run on failure — a board that fails its resistance-to-ground check never
receives power. Non-gate measurement failures are collected so one bad rail
doesn't hide the rest of the evidence.

Always cleans up — DUT power off, matrix open, probe retracted — on
completion, failure, or safety abort.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from ..boardio.testpoints import Board
from ..hal.interfaces import (Daq, Oscilloscope, PowerSystem, Programmer,
                              Smu, ThermalCamera)
from ..measure.waveforms import estimate_frequency, peak
from ..motion.gantry import Gantry
from ..safety.interlocks import SafetyController, SafetyError
from ..switching.matrix import MatrixRouter
from ..vision.registration import Transform2D
from .plan import Action, Step, TestPlan


@dataclass
class StepResult:
    step: str
    ok: bool
    value: Optional[float] = None
    detail: str = ""
    gate: bool = False


@dataclass
class RunReport:
    plan: str
    board: str
    started: float = field(default_factory=time.time)
    finished: Optional[float] = None
    results: List[StepResult] = field(default_factory=list)
    aborted: bool = False
    abort_reason: str = ""

    @property
    def passed(self) -> bool:
        return not self.aborted and all(r.ok for r in self.results)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "plan": self.plan,
            "board": self.board,
            "started": self.started,
            "finished": self.finished,
            "passed": self.passed,
            "aborted": self.aborted,
            "abort_reason": self.abort_reason,
            "results": [vars(r) for r in self.results],
        }


class GateFailure(RuntimeError):
    pass


class Engine:
    def __init__(self, gantry: Gantry, router: MatrixRouter,
                 power: PowerSystem, daq: Daq, safety: SafetyController,
                 smu: Optional[Smu] = None,
                 scope: Optional[Oscilloscope] = None,
                 programmer: Optional[Programmer] = None,
                 thermal: Optional[ThermalCamera] = None) -> None:
        self._gantry = gantry
        self._router = router
        self._power = power
        self._daq = daq
        self._safety = safety
        self._smu = smu
        self._scope = scope
        self._programmer = programmer
        self._thermal = thermal

    def run(self, plan: TestPlan, board: Board,
            transform: Optional[Transform2D] = None) -> RunReport:
        report = RunReport(plan=plan.name, board=board.name)
        try:
            if not self._gantry.homed:
                self._gantry.home()
            for step in plan.steps:
                self._safety.require_ok()
                result = self._execute(step, board, transform)
                result.gate = step.gate
                report.results.append(result)
                if not result.ok and step.gate:
                    raise GateFailure("gate step failed: {} ({})".format(
                        result.step, result.detail or result.value))
        except SafetyError as exc:
            report.aborted = True
            report.abort_reason = str(exc)
        except GateFailure as exc:
            report.aborted = True
            report.abort_reason = str(exc)
        except Exception as exc:  # motion faults, routing errors, contact faults
            report.aborted = True
            report.abort_reason = "{}: {}".format(type(exc).__name__, exc)
        finally:
            self._cleanup()
            report.finished = time.time()
        return report

    # -- helpers ---------------------------------------------------------

    def _machine_xy(self, board: Board, name: str,
                    transform: Optional[Transform2D]):
        tp = board.point(name)
        if transform is None:
            return tp.x_mm, tp.y_mm
        return transform.apply((tp.x_mm, tp.y_mm))

    def _probe_and_route(self, step: Step, board: Board,
                         transform: Optional[Transform2D],
                         resource: str) -> int:
        probe = int(step.params.get("probe", 0))
        x, y = self._machine_xy(board, step.target, transform)
        self._gantry.probe_point(x, y)
        self._router.connect(probe, resource)
        return probe

    def _need(self, device, name: str):
        if device is None:
            raise RuntimeError("plan requires {} but none is fitted".format(name))
        return device

    @staticmethod
    def _checked(step: Step, value: float, unit: str) -> StepResult:
        ok = step.limits.check(value) if step.limits else True
        detail = "" if ok else "outside [{}, {}] {}".format(
            step.limits.lo, step.limits.hi, unit)
        return StepResult(step=step.describe(), ok=ok, value=value,
                          detail=detail)

    # -- step execution ----------------------------------------------------

    def _execute(self, step: Step, board: Board,
                 transform: Optional[Transform2D]) -> StepResult:
        if step.action is Action.SET_POWER:
            channel = int(step.params.get("channel", 0))
            self._power.configure(channel, step.params["volts"],
                                  step.params["current_limit_a"])
            self._power.set_output(channel, True)
            self._router.lock_sources()
            inrush_max = step.params.get("inrush_max_a")
            if inrush_max is not None:
                wf = self._power.capture_inrush(channel, 0.01)
                inrush_peak = peak(wf)
                ok = inrush_peak <= float(inrush_max)
                detail = "" if ok else "inrush {:.3f} A over {} A".format(
                    inrush_peak, inrush_max)
                return StepResult(step=step.describe(), ok=ok,
                                  value=inrush_peak, detail=detail)
            return StepResult(step=step.describe(), ok=True)

        if step.action is Action.POWER_OFF:
            channel = step.params.get("channel")
            if channel is None:
                self._power.all_off()
            else:
                self._power.set_output(int(channel), False)
            if not self._power.any_on:
                self._router.unlock_sources()
            return StepResult(step=step.describe(), ok=True)

        if step.action is Action.DELAY:
            time.sleep(float(step.params.get("seconds", 0)))
            return StepResult(step=step.describe(), ok=True)

        if step.action is Action.PROBE_CONTACT:
            x, y = self._machine_xy(board, step.target, transform)
            contact = self._gantry.probe_point(x, y)
            ok = step.limits.check(contact.force_n) if step.limits else True
            return StepResult(step=step.describe(), ok=ok, value=contact.force_n,
                              detail="contact z={:.3f} mm".format(contact.z_mm))

        if step.action is Action.MEASURE_VOLTAGE:
            channel = int(step.params.get("channel",
                                          step.params.get("probe", 0)))
            probe = self._probe_and_route(step, board, transform, "daq")
            try:
                volts = self._daq.read_voltage(channel)
            finally:
                self._router.disconnect(probe)
            return self._checked(step, volts, "V")

        if step.action is Action.MEASURE_RESISTANCE:
            smu = self._need(self._smu, "an SMU/DMM")
            ref = step.params.get("ref", "gnd")
            probe = self._probe_and_route(step, board, transform, "smu")
            try:
                ohms = smu.measure_resistance(ref)
            finally:
                smu.off()
                self._router.disconnect(probe)
            return self._checked(step, ohms, "ohm")

        if step.action is Action.MEASURE_DIODE:
            smu = self._need(self._smu, "an SMU/DMM")
            ref = step.params.get("ref", "gnd")
            probe = self._probe_and_route(step, board, transform, "smu")
            try:
                volts = smu.measure_diode_drop(ref)
            finally:
                smu.off()
                self._router.disconnect(probe)
            return self._checked(step, volts, "V")

        if step.action is Action.MEASURE_FREQUENCY:
            scope = self._need(self._scope, "an oscilloscope")
            sample_rate = float(step.params.get("sample_rate_hz", 1e6))
            duration = float(step.params.get("duration_s", 0.005))
            probe = self._probe_and_route(step, board, transform, "scope_ch1")
            try:
                wf = scope.capture(channel=1, duration_s=duration,
                                   sample_rate_hz=sample_rate)
            finally:
                self._router.disconnect(probe)
            return self._checked(step, estimate_frequency(wf), "Hz")

        if step.action is Action.PROGRAM_FIRMWARE:
            programmer = self._need(self._programmer, "a programmer")
            expect_id = step.params.get("expect_id")
            if expect_id:
                found = programmer.read_target_id()
                if found != expect_id:
                    return StepResult(step=step.describe(), ok=False,
                                      detail="target id {!r}, expected {!r}".format(
                                          found, expect_id))
            try:
                programmer.program(step.params["image"])
            except Exception as exc:
                return StepResult(step=step.describe(), ok=False,
                                  detail="programming failed: {}".format(exc))
            return StepResult(step=step.describe(), ok=True)

        if step.action is Action.THERMAL_CHECK:
            thermal = self._need(self._thermal, "a thermal camera")
            frame = thermal.grab_temperatures()
            max_temp = float(frame.max())
            ok = max_temp <= float(step.params["max_temp_c"])
            detail = "" if ok else "hotspot {:.1f} C over {} C".format(
                max_temp, step.params["max_temp_c"])
            return StepResult(step=step.describe(), ok=ok, value=max_temp,
                              detail=detail)

        raise ValueError("unhandled action {!r}".format(step.action))

    def _cleanup(self) -> None:
        try:
            self._power.all_off()
        finally:
            self._router.open_all()
            try:
                self._gantry.retract()
            except Exception:
                pass  # safety tripped: hardware chain owns the stop
