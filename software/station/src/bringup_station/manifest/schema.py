"""Design manifest v0 — the machine-readable contract between the design
(human or AI) and the machine.

This is the product's core insight: every board arrives with a manifest that
connects schematic net -> PCB coordinate -> expected behavior -> instrument
configuration -> diagnostic meaning. With it the machine is an automated
bring-up system; without it, an automated probe station.

Enterprise mode compiles a manifest from existing EDA exports (KiCad/Altium
netlist + centroid + test spec); AI-native mode receives it from the design
tool directly. Either way it lands here, and `compile.py` turns it into an
executable TestPlan.

v0 scope: fiducials/test points, pre-power safety checks, sequenced power
inputs with inrush limits, firmware programming, rail checks, clock checks,
thermal limit. Later revisions add buses, waveform signatures, and the
diagnostic decision tree.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional


@dataclass(frozen=True)
class ManifestTestPoint:
    name: str
    net: str
    x_mm: float
    y_mm: float


@dataclass(frozen=True)
class PrePowerCheck:
    """Safety gate measurement before any power is applied."""

    testpoint: str
    kind: str                       # "resistance" | "diode"
    ref: str = "gnd"                # low terminal, routed via interface panel
    min_value: Optional[float] = None   # ohms or volts
    max_value: Optional[float] = None


@dataclass(frozen=True)
class PowerInput:
    """One DUT power input, applied in `order` with limits."""

    name: str
    channel: int
    volts: float
    current_limit_a: float
    order: int = 0
    inrush_max_a: Optional[float] = None


@dataclass(frozen=True)
class Rail:
    """Expected supply/regulator output measured at a test point."""

    net: str
    testpoint: str
    volts_min: float
    volts_max: float


@dataclass(frozen=True)
class ClockCheck:
    testpoint: str
    freq_hz: float
    tol_pct: float = 5.0


@dataclass(frozen=True)
class FirmwareSpec:
    image: str
    expect_target_id: Optional[str] = None


@dataclass
class DesignManifest:
    name: str
    revision: str
    testpoints: List[ManifestTestPoint] = field(default_factory=list)
    prepower: List[PrePowerCheck] = field(default_factory=list)
    power_inputs: List[PowerInput] = field(default_factory=list)
    rails: List[Rail] = field(default_factory=list)
    clocks: List[ClockCheck] = field(default_factory=list)
    firmware: Optional[FirmwareSpec] = None
    max_board_temp_c: Optional[float] = None
    notes: str = ""

    # -- serialization -------------------------------------------------------

    def to_dict(self) -> Dict[str, Any]:
        data = asdict(self)
        return data

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "DesignManifest":
        fw = data.get("firmware")
        return cls(
            name=data["name"],
            revision=data["revision"],
            testpoints=[ManifestTestPoint(**tp) for tp in data.get("testpoints", [])],
            prepower=[PrePowerCheck(**pc) for pc in data.get("prepower", [])],
            power_inputs=[PowerInput(**pi) for pi in data.get("power_inputs", [])],
            rails=[Rail(**r) for r in data.get("rails", [])],
            clocks=[ClockCheck(**c) for c in data.get("clocks", [])],
            firmware=FirmwareSpec(**fw) if fw else None,
            max_board_temp_c=data.get("max_board_temp_c"),
            notes=data.get("notes", ""),
        )

    @classmethod
    def load(cls, path: "str | Path") -> "DesignManifest":
        return cls.from_dict(json.loads(Path(path).read_text()))

    def save(self, path: "str | Path") -> None:
        Path(path).write_text(json.dumps(self.to_dict(), indent=2))

    # -- validation ----------------------------------------------------------

    def validate(self) -> List[str]:
        """Return a list of problems (empty = valid)."""
        problems: List[str] = []
        tp_names = {tp.name for tp in self.testpoints}
        for pc in self.prepower:
            if pc.testpoint not in tp_names:
                problems.append("prepower check references unknown test point "
                                "{!r}".format(pc.testpoint))
            if pc.kind not in ("resistance", "diode"):
                problems.append("prepower kind {!r} unknown".format(pc.kind))
            if pc.min_value is None and pc.max_value is None:
                problems.append("prepower check on {!r} has no limits".format(
                    pc.testpoint))
        for rail in self.rails:
            if rail.testpoint not in tp_names:
                problems.append("rail {!r} references unknown test point "
                                "{!r}".format(rail.net, rail.testpoint))
        for clk in self.clocks:
            if clk.testpoint not in tp_names:
                problems.append("clock check references unknown test point "
                                "{!r}".format(clk.testpoint))
        seen_channels = set()
        for pi in self.power_inputs:
            if pi.channel in seen_channels:
                problems.append("power channel {} used twice".format(pi.channel))
            seen_channels.add(pi.channel)
        fids = [tp for tp in self.testpoints
                if tp.name.upper().startswith("FID")]
        if len(fids) < 2:
            problems.append("manifest needs at least 2 fiducials (FID*)")
        return problems
