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
