"""Hardware abstraction layer interfaces.

One interface per device in the locked BOM. Application code depends only on
these; mocks (hal/mocks.py) and real drivers (hal/drivers/) implement them.
Real backends planned: Galil gclib, PicoScope picosdk, Saleae automation API,
MCC uldaq, LabJack ljm, Siglent SCPI via pyvisa, custom PCBA serial protocol.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple


class MotionController(abc.ABC):
    """Low-level 3-axis motion (Galil DMC-4133)."""

    @abc.abstractmethod
    def home(self) -> None:
        """Home all axes; blocks until complete."""

    @abc.abstractmethod
    def move_to(self, x: float, y: float, z: float, feed_mm_s: float) -> None:
        """Absolute coordinated move; blocks until complete."""

    @abc.abstractmethod
    def position(self) -> Tuple[float, float, float]:
        """Current (x, y, z) in mm."""

    @abc.abstractmethod
    def stop(self) -> None:
        """Immediate controlled stop."""

    @property
    @abc.abstractmethod
    def homed(self) -> bool: ...


class ForceSensor(abc.ABC):
    """Probe-head load cell (via cartridge PCBA AFE)."""

    @abc.abstractmethod
    def read_n(self) -> float:
        """Current force in newtons (positive = compression)."""


@dataclass(frozen=True)
class PowerReading:
    volts: float
    amps: float


class PowerSupply(abc.ABC):
    """DUT power (Siglent SPD1305X in v1; custom board in v2)."""

    @abc.abstractmethod
    def configure(self, volts: float, current_limit_a: float) -> None: ...

    @abc.abstractmethod
    def set_output(self, enabled: bool) -> None: ...

    @abc.abstractmethod
    def measure(self) -> PowerReading: ...

    @property
    @abc.abstractmethod
    def output_enabled(self) -> bool: ...


class ElectronicLoad(abc.ABC):
    """DUT load (Siglent SDL1030X in v1; custom board in v2)."""

    @abc.abstractmethod
    def configure_cc(self, amps: float) -> None: ...

    @abc.abstractmethod
    def set_input(self, enabled: bool) -> None: ...

    @abc.abstractmethod
    def measure(self) -> PowerReading: ...


class Daq(abc.ABC):
    """Precision DC measurement, DMM role (MCC USB-2416)."""

    @abc.abstractmethod
    def read_voltage(self, channel: int) -> float: ...


@dataclass(frozen=True)
class Waveform:
    sample_rate_hz: float
    samples: Sequence[float]


class Oscilloscope(abc.ABC):
    """PicoScope 5444D MSO."""

    @abc.abstractmethod
    def capture(self, channel: int, duration_s: float,
                sample_rate_hz: float) -> Waveform: ...


class LogicAnalyzer(abc.ABC):
    """Saleae Logic Pro 16."""

    @abc.abstractmethod
    def capture_digital(self, channels: Sequence[int],
                        duration_s: float) -> List[Sequence[int]]: ...


class RelayMatrix(abc.ABC):
    """Custom relay/probe matrix PCBA. Connects instrument resources to
    probes. Routing policy lives in switching/matrix.py; this is raw relay
    actuation only."""

    @abc.abstractmethod
    def set_relay(self, relay_id: int, closed: bool) -> None: ...

    @abc.abstractmethod
    def open_all(self) -> None: ...


class Camera(abc.ABC):
    """Overhead or probe-head camera."""

    @abc.abstractmethod
    def grab(self):
        """Return an image as an ndarray (H, W[, C])."""


class SafetyIO(abc.ABC):
    """Read-only view of the hardwired safety chain (Omron G9SE, e-stop,
    door interlock). Software observes; it never overrides."""

    @property
    @abc.abstractmethod
    def estop_active(self) -> bool: ...

    @property
    @abc.abstractmethod
    def door_closed(self) -> bool: ...
