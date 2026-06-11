"""Test plan execution.

Runs a TestPlan against a Board: transforms each test point through the board
registration, probes with force guarding, routes the matrix, measures,
evaluates limits, and produces a RunReport. Always cleans up — DUT power off,
matrix open, probe retracted — on completion, failure, or safety abort.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from ..boardio.testpoints import Board
from ..hal.interfaces import Daq, PowerSupply
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


class Engine:
    def __init__(self, gantry: Gantry, router: MatrixRouter, psu: PowerSupply,
                 daq: Daq, safety: SafetyController) -> None:
        self._gantry = gantry
        self._router = router
        self._psu = psu
        self._daq = daq
        self._safety = safety

    def run(self, plan: TestPlan, board: Board,
            transform: Optional[Transform2D] = None) -> RunReport:
        report = RunReport(plan=plan.name, board=board.name)
        try:
            if not self._gantry.homed:
                self._gantry.home()
            for step in plan.steps:
                self._safety.require_ok()
                result = self._execute(step, board, transform)
                report.results.append(result)
                if not result.ok:
                    # measurement failures continue (collect all results);
                    # only safety/motion exceptions abort the run
                    continue
        except SafetyError as exc:
            report.aborted = True
            report.abort_reason = str(exc)
        except Exception as exc:  # motion faults, routing errors, contact faults
            report.aborted = True
            report.abort_reason = "{}: {}".format(type(exc).__name__, exc)
        finally:
            self._cleanup()
            report.finished = time.time()
        return report

    # -- step execution ------------------------------------------------------

    def _machine_xy(self, board: Board, name: str,
                    transform: Optional[Transform2D]):
        tp = board.point(name)
        if transform is None:
            return tp.x_mm, tp.y_mm
        return transform.apply((tp.x_mm, tp.y_mm))

    def _execute(self, step: Step, board: Board,
                 transform: Optional[Transform2D]) -> StepResult:
        if step.action is Action.SET_POWER:
            self._psu.configure(step.params["volts"],
                                step.params["current_limit_a"])
            self._psu.set_output(True)
            self._router.lock_sources()
            return StepResult(step=step.describe(), ok=True)

        if step.action is Action.POWER_OFF:
            self._psu.set_output(False)
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
            probe = int(step.params.get("probe", 0))
            channel = int(step.params.get("channel", probe))
            x, y = self._machine_xy(board, step.target, transform)
            self._gantry.probe_point(x, y)
            self._router.connect(probe, "daq")
            try:
                volts = self._daq.read_voltage(channel)
            finally:
                self._router.disconnect(probe)
            ok = step.limits.check(volts) if step.limits else True
            detail = "" if ok else "limits [{}, {}]".format(
                step.limits.lo, step.limits.hi)
            return StepResult(step=step.describe(), ok=ok, value=volts,
                              detail=detail)

        raise ValueError("unhandled action {!r}".format(step.action))

    def _cleanup(self) -> None:
        try:
            self._psu.set_output(False)
        finally:
            self._router.open_all()
            try:
                self._gantry.retract()
            except Exception:
                pass  # safety tripped: hardware chain owns the stop
