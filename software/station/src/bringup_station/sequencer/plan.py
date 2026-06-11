"""Test plan model. Plans are plain data — JSON-serializable, no behavior —
so they can be authored by the UI, stored, diffed, and replayed."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional


class Action(Enum):
    SET_POWER = "set_power"          # params: volts, current_limit_a
    POWER_OFF = "power_off"
    MEASURE_VOLTAGE = "measure_voltage"  # target: test point; params: probe(int)
    PROBE_CONTACT = "probe_contact"      # target: test point (contact check only)
    DELAY = "delay"                  # params: seconds


@dataclass(frozen=True)
class Limits:
    lo: float
    hi: float

    def check(self, value: float) -> bool:
        return self.lo <= value <= self.hi


@dataclass(frozen=True)
class Step:
    action: Action
    target: Optional[str] = None         # test point name, if applicable
    params: Dict[str, Any] = field(default_factory=dict)
    limits: Optional[Limits] = None
    label: str = ""

    def describe(self) -> str:
        return self.label or "{} {}".format(self.action.value, self.target or "")


@dataclass
class TestPlan:
    __test__ = False  # not a pytest class, despite the name

    name: str
    board: str
    steps: List[Step] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "board": self.board,
            "steps": [
                {
                    "action": s.action.value,
                    "target": s.target,
                    "params": s.params,
                    "limits": asdict(s.limits) if s.limits else None,
                    "label": s.label,
                }
                for s in self.steps
            ],
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "TestPlan":
        steps = []
        for s in data.get("steps", []):
            limits = Limits(**s["limits"]) if s.get("limits") else None
            steps.append(Step(action=Action(s["action"]), target=s.get("target"),
                              params=s.get("params") or {}, limits=limits,
                              label=s.get("label", "")))
        return cls(name=data["name"], board=data["board"], steps=steps)
