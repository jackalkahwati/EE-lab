"""Gantry: safe high-level motion on top of the raw MotionController.

Adds soft limits, safety gating, retract-before-XY policy, and force-guarded
probe descent (EVT proof #2: repeatable contact that does not damage the PCB).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Tuple

from ..config import MachineConfig
from ..hal.interfaces import ForceSensor, MotionController
from ..safety.interlocks import SafetyController


class SoftLimitError(ValueError):
    pass


class ProbeContactError(RuntimeError):
    """Raised when descent ends without acceptable contact (no contact within
    overtravel, or force exceeded the abort threshold)."""


@dataclass(frozen=True)
class ContactResult:
    z_mm: float
    force_n: float


class Gantry:
    def __init__(self, config: MachineConfig, motion: MotionController,
                 force: ForceSensor, safety: SafetyController) -> None:
        self.config = config
        self._motion = motion
        self._force = force
        self._safety = safety

    # -- basics ------------------------------------------------------------

    @property
    def position(self) -> Tuple[float, float, float]:
        return self._motion.position()

    @property
    def homed(self) -> bool:
        return self._motion.homed

    def home(self) -> None:
        self._safety.require_ok()
        self._motion.home()

    def _check_limits(self, x: float, y: float, z: float) -> None:
        cfg = self.config
        if not cfg.x.contains(x):
            raise SoftLimitError("x={} outside [{}, {}]".format(x, cfg.x.min_mm, cfg.x.max_mm))
        if not cfg.y.contains(y):
            raise SoftLimitError("y={} outside [{}, {}]".format(y, cfg.y.min_mm, cfg.y.max_mm))
        if not cfg.z.contains(z):
            raise SoftLimitError("z={} outside [{}, {}]".format(z, cfg.z.min_mm, cfg.z.max_mm))

    def retract(self) -> None:
        x, y, _ = self.position
        self._move(x, y, self.config.safe_z_mm, self.config.z_feed_mm_s)

    def move_xy(self, x: float, y: float) -> None:
        """Move in XY with the probe retracted to safe Z first."""
        self.retract()
        self._move(x, y, self.config.safe_z_mm, self.config.xy_feed_mm_s)

    def _move(self, x: float, y: float, z: float, feed: float) -> None:
        self._safety.require_ok()
        self._check_limits(x, y, z)
        self._motion.move_to(x, y, z, feed)

    # -- force-guarded probing ----------------------------------------------

    def probe_point(self, x: float, y: float,
                    expected_contact_z: Optional[float] = None) -> ContactResult:
        """Probe a point: retract, move over it, fast-approach, then descend
        in force-watched steps until target contact force is reached.

        Faults (and retracts) if force exceeds the abort limit or contact is
        not found within the overtravel window past the expected contact Z.
        """
        pc = self.config.probe
        contact_z = (expected_contact_z if expected_contact_z is not None
                     else self.config.nominal_contact_z_mm)

        self.move_xy(x, y)
        fast_z = contact_z - pc.fast_approach_margin_mm
        if fast_z > self.config.safe_z_mm:
            self._move(x, y, fast_z, self.config.z_feed_mm_s)

        max_z = contact_z + pc.overtravel_limit_mm
        try:
            z = self.position[2]
            while z < max_z:
                force = self._force.read_n()
                if force > pc.max_force_n:
                    raise ProbeContactError(
                        "force {:.2f} N exceeded abort limit at z={:.3f}".format(force, z))
                if force >= pc.target_force_n:
                    return ContactResult(z_mm=z, force_n=force)
                z = min(z + pc.approach_step_mm, max_z)
                self._move(x, y, z, self.config.z_feed_mm_s)
            raise ProbeContactError(
                "no contact within {:.2f} mm overtravel past z={:.2f}".format(
                    pc.overtravel_limit_mm, contact_z))
        except Exception:
            self.retract()
            raise
