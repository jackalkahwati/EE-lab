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
    power: object          # PowerSystem (DP832-class, sequenced channels)
    psu_aux: object        # auxiliary single supply (SPD1305X role)
    eload: object
    daq: object
    smu: object            # precision DMM/SMU (DMM6500 role)
    scope: object
    logic: object
    programmer: object     # SWD/JTAG (J-Link role)
    dut_link: object       # UART/USB link to the DUT
    thermal: object        # IR camera (Lepton role)
    panel: object          # DUT interface panel (USB/Eth/CAN/...)
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
    power = mocks.MockPowerSystem()
    psu_aux = mocks.MockPowerSupply()
    eload = mocks.MockElectronicLoad()
    daq = mocks.MockDaq()
    smu = mocks.MockSmu()
    scope = mocks.MockOscilloscope()
    logic = mocks.MockLogicAnalyzer()
    programmer = mocks.MockProgrammer()
    dut_link = mocks.MockDutLink()
    thermal = mocks.MockThermalCamera()
    panel = mocks.MockInterfacePanel()
    engine = Engine(gantry, router, power, daq, safety,
                    smu=smu, scope=scope, programmer=programmer,
                    thermal=thermal)
    return MachineContext(config=config, gantry=gantry, router=router,
                          power=power, psu_aux=psu_aux, eload=eload, daq=daq,
                          smu=smu, scope=scope, logic=logic,
                          programmer=programmer, dut_link=dut_link,
                          thermal=thermal, panel=panel,
                          safety=safety, safety_io=safety_io, engine=engine)
