"""Simulated bench: full mock implementations of every HAL interface.

The mocks model just enough physics for the application logic to be tested
honestly: probe force rises as the Z axis descends past the simulated contact
plane, the PSU reports its programmed values, and the DAQ reads voltages from
a settable per-channel table (a test's "virtual DUT").
"""

from __future__ import annotations

import math
from typing import Dict, List, Sequence, Tuple

from . import interfaces as hal


class MockMotionController(hal.MotionController):
    def __init__(self) -> None:
        self._pos = (0.0, 0.0, 0.0)
        self._homed = False

    def home(self) -> None:
        self._pos = (0.0, 0.0, 0.0)
        self._homed = True

    def move_to(self, x: float, y: float, z: float, feed_mm_s: float) -> None:
        if not self._homed:
            raise RuntimeError("motion commanded before homing")
        self._pos = (x, y, z)

    def position(self) -> Tuple[float, float, float]:
        return self._pos

    def stop(self) -> None:
        pass

    @property
    def homed(self) -> bool:
        return self._homed


class MockForceSensor(hal.ForceSensor):
    """Force ramps linearly with descent past the contact plane, modeling
    pogo-pin spring compression (~1 N/mm combined rate by default)."""

    def __init__(self, motion: MockMotionController,
                 contact_z_mm: float = 60.0,
                 spring_n_per_mm: float = 1.0) -> None:
        self._motion = motion
        self.contact_z_mm = contact_z_mm
        self.spring_n_per_mm = spring_n_per_mm

    def read_n(self) -> float:
        z = self._motion.position()[2]
        compression = z - self.contact_z_mm
        return max(0.0, compression * self.spring_n_per_mm)


class MockPowerSupply(hal.PowerSupply):
    def __init__(self) -> None:
        self._volts = 0.0
        self._ilim = 0.0
        self._on = False

    def configure(self, volts: float, current_limit_a: float) -> None:
        self._volts = volts
        self._ilim = current_limit_a

    def set_output(self, enabled: bool) -> None:
        self._on = enabled

    def measure(self) -> hal.PowerReading:
        return hal.PowerReading(volts=self._volts if self._on else 0.0,
                                amps=0.05 if self._on else 0.0)

    @property
    def output_enabled(self) -> bool:
        return self._on


class MockElectronicLoad(hal.ElectronicLoad):
    def __init__(self) -> None:
        self._amps = 0.0
        self._on = False

    def configure_cc(self, amps: float) -> None:
        self._amps = amps

    def set_input(self, enabled: bool) -> None:
        self._on = enabled

    def measure(self) -> hal.PowerReading:
        return hal.PowerReading(volts=0.0, amps=self._amps if self._on else 0.0)


class MockDaq(hal.Daq):
    """Channel readings come from a settable table — the virtual DUT."""

    def __init__(self) -> None:
        self.channel_volts: Dict[int, float] = {}

    def read_voltage(self, channel: int) -> float:
        return self.channel_volts.get(channel, 0.0)


class MockOscilloscope(hal.Oscilloscope):
    def capture(self, channel: int, duration_s: float,
                sample_rate_hz: float) -> hal.Waveform:
        n = max(1, int(duration_s * sample_rate_hz))
        samples = [math.sin(2 * math.pi * 1000 * i / sample_rate_hz)
                   for i in range(n)]
        return hal.Waveform(sample_rate_hz=sample_rate_hz, samples=samples)


class MockLogicAnalyzer(hal.LogicAnalyzer):
    def capture_digital(self, channels: Sequence[int],
                        duration_s: float) -> List[Sequence[int]]:
        n = max(1, int(duration_s * 1_000_000))
        n = min(n, 4096)
        return [[(i // 2) % 2 for i in range(n)] for _ in channels]


class MockRelayMatrix(hal.RelayMatrix):
    def __init__(self) -> None:
        self.closed: set = set()

    def set_relay(self, relay_id: int, closed: bool) -> None:
        if closed:
            self.closed.add(relay_id)
        else:
            self.closed.discard(relay_id)

    def open_all(self) -> None:
        self.closed.clear()


class MockCamera(hal.Camera):
    def grab(self):
        import numpy as np
        return np.zeros((480, 640), dtype="uint8")


class MockPowerSystem(hal.PowerSystem):
    """3-channel sequenced supply. Records every output event so tests can
    assert ordering (e.g. "power never went on after a failed pre-power
    gate"). Inrush peak per channel is settable."""

    def __init__(self, channels: int = 3) -> None:
        self._n = channels
        self._cfg: Dict[int, Tuple[float, float]] = {}
        self._on: Dict[int, bool] = {ch: False for ch in range(channels)}
        self.inrush_peak_a: Dict[int, float] = {}
        self.events: List[Tuple[str, int, bool]] = []

    @property
    def num_channels(self) -> int:
        return self._n

    def _check(self, channel: int) -> None:
        if not 0 <= channel < self._n:
            raise ValueError("channel {} out of range".format(channel))

    def configure(self, channel: int, volts: float,
                  current_limit_a: float) -> None:
        self._check(channel)
        self._cfg[channel] = (volts, current_limit_a)

    def set_output(self, channel: int, enabled: bool) -> None:
        self._check(channel)
        self._on[channel] = enabled
        self.events.append(("output", channel, enabled))

    def measure(self, channel: int) -> hal.PowerReading:
        self._check(channel)
        volts, _ = self._cfg.get(channel, (0.0, 0.0))
        on = self._on[channel]
        return hal.PowerReading(volts=volts if on else 0.0,
                                amps=0.05 if on else 0.0)

    def capture_inrush(self, channel: int, duration_s: float) -> hal.Waveform:
        self._check(channel)
        peak = self.inrush_peak_a.get(channel, 0.2)
        rate = 1_000_000.0
        n = max(2, int(duration_s * rate))
        tau = duration_s / 5.0
        samples = [peak * math.exp(-(i / rate) / tau) for i in range(n)]
        return hal.Waveform(sample_rate_hz=rate, samples=samples)

    @property
    def any_on(self) -> bool:
        return any(self._on.values())

    def all_off(self) -> None:
        for ch in range(self._n):
            if self._on[ch]:
                self.set_output(ch, False)


class MockSmu(hal.Smu):
    """Scripted readings (FIFO) with healthy defaults: open circuit for
    resistance, nominal silicon drop for diode mode."""

    def __init__(self) -> None:
        self.resistance_script: List[float] = []
        self.diode_script: List[float] = []
        self.default_resistance_ohms = 1e9
        self.default_diode_v = 0.6

    def measure_resistance(self, ref_net: str) -> float:
        if self.resistance_script:
            return self.resistance_script.pop(0)
        return self.default_resistance_ohms

    def measure_diode_drop(self, ref_net: str) -> float:
        if self.diode_script:
            return self.diode_script.pop(0)
        return self.default_diode_v

    def off(self) -> None:
        pass


class MockProgrammer(hal.Programmer):
    def __init__(self, target_id: str = "STM32G474") -> None:
        self.target_id = target_id
        self.fail_program = False
        self.programmed: List[str] = []

    def read_target_id(self) -> str:
        return self.target_id

    def program(self, image: str) -> None:
        if self.fail_program:
            raise RuntimeError("verify failed for {}".format(image))
        self.programmed.append(image)

    def reset_target(self) -> None:
        pass


class MockDutLink(hal.DutLink):
    """Echoes scripted responses keyed by exact request bytes."""

    def __init__(self) -> None:
        self.responses: Dict[bytes, bytes] = {}
        self._pending = b""

    def write(self, data: bytes) -> None:
        self._pending = self.responses.get(data, b"")

    def read(self, timeout_s: float) -> bytes:
        out, self._pending = self._pending, b""
        return out


class MockThermalCamera(hal.ThermalCamera):
    """Uniform ambient frame with settable hotspots."""

    def __init__(self, ambient_c: float = 25.0,
                 shape: Tuple[int, int] = (120, 160)) -> None:
        self.ambient_c = ambient_c
        self.shape = shape
        self.hotspots: List[Tuple[int, int, float]] = []  # (row, col, temp)

    def grab_temperatures(self):
        import numpy as np
        frame = np.full(self.shape, self.ambient_c, dtype=float)
        for row, col, temp in self.hotspots:
            frame[row, col] = temp
        return frame


class MockInterfacePanel(hal.InterfacePanel):
    INTERFACES = ("usb", "ethernet", "can", "uart", "i2c", "spi", "gpio",
                  "program")

    def __init__(self) -> None:
        self._connected: set = set()

    def interfaces(self) -> Sequence[str]:
        return self.INTERFACES

    def set_connected(self, name: str, connected: bool) -> None:
        if name not in self.INTERFACES:
            raise ValueError("unknown interface {!r}".format(name))
        if connected:
            self._connected.add(name)
        else:
            self._connected.discard(name)

    def connected(self) -> Sequence[str]:
        return sorted(self._connected)


class MockSafetyIO(hal.SafetyIO):
    """Settable safety inputs for fault-injection tests."""

    def __init__(self) -> None:
        self.set_estop(False)
        self.set_door_closed(True)

    def set_estop(self, active: bool) -> None:
        self._estop = active

    def set_door_closed(self, closed: bool) -> None:
        self._door = closed

    @property
    def estop_active(self) -> bool:
        return self._estop

    @property
    def door_closed(self) -> bool:
        return self._door
