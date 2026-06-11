"""Machine configuration: geometry, speeds, and probe limits.

Values mirror the CAD master model (fixture centered at origin, X travel
500 mm, Y travel 400 mm, Z travel 100 mm). Z is in axis coordinates where
0 mm is full up and +Z descends toward the board.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class AxisLimits:
    min_mm: float
    max_mm: float

    def contains(self, value: float) -> bool:
        return self.min_mm <= value <= self.max_mm


@dataclass(frozen=True)
class ProbeConfig:
    """Force-guarded probing parameters."""

    max_force_n: float = 1.5          # abort descent above this
    target_force_n: float = 0.6       # nominal contact preload
    approach_step_mm: float = 0.05    # descent increment while force-watching
    fast_approach_margin_mm: float = 2.0  # fast move stops this far above expected contact
    overtravel_limit_mm: float = 1.0  # max descent past expected contact before fault


@dataclass(frozen=True)
class MachineConfig:
    x: AxisLimits = field(default_factory=lambda: AxisLimits(-250.0, 250.0))
    y: AxisLimits = field(default_factory=lambda: AxisLimits(-200.0, 200.0))
    z: AxisLimits = field(default_factory=lambda: AxisLimits(0.0, 100.0))
    safe_z_mm: float = 5.0            # retract height for all XY moves
    xy_feed_mm_s: float = 200.0
    z_feed_mm_s: float = 25.0
    probe: ProbeConfig = field(default_factory=ProbeConfig)
    # Nominal Z where probe tips meet the PCB top surface. Replaced by the
    # touch-off calibration on a real machine; the mock bench uses it too.
    nominal_contact_z_mm: float = 60.0
