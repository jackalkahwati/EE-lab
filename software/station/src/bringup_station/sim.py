"""Fully wired simulated machine — the development bench.

`make_sim_machine()` returns a MachineContext identical in shape to the real
machine, with every device mocked. The API server, sequencer, and tests all
run against this with zero hardware.
"""

from __future__ import annotations

from dataclasses import dataclass

from .config import MachineConfig
from .hal import mocks
from .motion.gantry import Gantry
from .safety.interlocks import SafetyController
from .sequencer.engine import Engine
from .switching.matrix import MatrixRouter


@dataclass
class MachineContext:
    config: MachineConfig
    gantry: Gantry
    router: MatrixRouter
    psu: object
    eload: object
    daq: object
    scope: object
    logic: object
    safety: SafetyController
    safety_io: object
    engine: Engine


def make_sim_machine(config: "MachineConfig | None" = None) -> MachineContext:
    config = config or MachineConfig()
    motion = mocks.MockMotionController()
    force = mocks.MockForceSensor(motion,
                                  contact_z_mm=config.nominal_contact_z_mm)
    safety_io = mocks.MockSafetyIO()
    safety = SafetyController(safety_io)
    gantry = Gantry(config, motion, force, safety)
    router = MatrixRouter(mocks.MockRelayMatrix())
    psu = mocks.MockPowerSupply()
    eload = mocks.MockElectronicLoad()
    daq = mocks.MockDaq()
    scope = mocks.MockOscilloscope()
    logic = mocks.MockLogicAnalyzer()
    engine = Engine(gantry, router, psu, daq, safety)
    return MachineContext(config=config, gantry=gantry, router=router, psu=psu,
                          eload=eload, daq=daq, scope=scope, logic=logic,
                          safety=safety, safety_io=safety_io, engine=engine)
