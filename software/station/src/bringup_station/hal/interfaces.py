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


class PowerSystem(abc.ABC):
    """Multi-channel sequenced DUT power (Rigol DP832 in v1; custom protected
    power board in v2). Distinguishes dead board vs leakage vs sequencing vs
    firmware-dependent draw — single-supply PowerSupply is auxiliary only."""

    @property
    @abc.abstractmethod
    def num_channels(self) -> int: ...

    @abc.abstractmethod
    def configure(self, channel: int, volts: float,
                  current_limit_a: float) -> None: ...

    @abc.abstractmethod
    def set_output(self, channel: int, enabled: bool) -> None: ...

    @abc.abstractmethod
    def measure(self, channel: int) -> PowerReading: ...

    @abc.abstractmethod
    def capture_inrush(self, channel: int, duration_s: float) -> Waveform:
        """Current waveform around output enable (Joulescope JS220 path)."""

    @property
    @abc.abstractmethod
    def any_on(self) -> bool: ...

    @abc.abstractmethod
    def all_off(self) -> None: ...


class Smu(abc.ABC):
    """Precision pre-power measurements (Keithley DMM6500 + protection board
    Kelvin path). The probe is the high terminal; `ref_net` names the low
    terminal routed through the DUT interface panel (e.g. "gnd", a connector
    rail). Source-measure sweeps land here in a later revision."""

    @abc.abstractmethod
    def measure_resistance(self, ref_net: str) -> float:
        """Ohms from the probed point to ref_net (current-limited, safe)."""

    @abc.abstractmethod
    def measure_diode_drop(self, ref_net: str) -> float:
        """Diode-mode forward voltage from probed point to ref_net."""

    @abc.abstractmethod
    def off(self) -> None: ...


class Programmer(abc.ABC):
    """Firmware programming/debug (Segger J-Link via Tag-Connect; SPI flash
    programmer for off-MCU boot parts)."""

    @abc.abstractmethod
    def read_target_id(self) -> str:
        """Identify the connected target (empty string if none found)."""

    @abc.abstractmethod
    def program(self, image: str) -> None:
        """Flash and verify an image; raises on any failure."""

    @abc.abstractmethod
    def reset_target(self) -> None: ...


class DutLink(abc.ABC):
    """Byte-level link to the DUT (UART/USB via FT4232H + interface board)
    for firmware self-tests and bus exercising."""

    @abc.abstractmethod
    def write(self, data: bytes) -> None: ...

    @abc.abstractmethod
    def read(self, timeout_s: float) -> bytes: ...


class ThermalCamera(abc.ABC):
    """IR camera over the fixture (FLIR Lepton 3.5). Finds shorts, overloaded
    regulators, reversed ICs, unexpected current paths."""

    @abc.abstractmethod
    def grab_temperatures(self):
        """Return a 2D ndarray of temperatures in deg C."""


class InterfacePanel(abc.ABC):
    """Connector-level DUT interaction (custom DUT interface board):
    relay-isolated USB/Ethernet/CAN/UART/I2C/SPI/GPIO channels."""

    @abc.abstractmethod
    def interfaces(self) -> Sequence[str]: ...

    @abc.abstractmethod
    def set_connected(self, name: str, connected: bool) -> None: ...

    @abc.abstractmethod
    def connected(self) -> Sequence[str]: ...
