"""Software safety layer.

The hardwired chain (Omron G9SE, e-stop, door interlock) is authoritative and
drops motor/DUT power on its own. This layer is the observing second line:
every motion or power action calls require_ok() first, and the sequencer
polls state between steps to abort runs cleanly.
"""

from __future__ import annotations

from enum import Enum

from ..hal.interfaces import SafetyIO


class SafetyState(Enum):
    OK = "ok"
    ESTOP = "estop"
    DOOR_OPEN = "door_open"


class SafetyError(RuntimeError):
    def __init__(self, state: SafetyState) -> None:
        super().__init__("safety interlock: {}".format(state.value))
        self.state = state


class SafetyController:
    def __init__(self, io: SafetyIO) -> None:
        self._io = io

    @property
    def state(self) -> SafetyState:
        if self._io.estop_active:
            return SafetyState.ESTOP
        if not self._io.door_closed:
            return SafetyState.DOOR_OPEN
        return SafetyState.OK

    def ok(self) -> bool:
        return self.state is SafetyState.OK

    def require_ok(self) -> None:
        state = self.state
        if state is not SafetyState.OK:
            raise SafetyError(state)
