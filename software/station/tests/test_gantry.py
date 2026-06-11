import pytest

from bringup_station.config import MachineConfig
from bringup_station.motion.gantry import ProbeContactError, SoftLimitError
from bringup_station.safety.interlocks import SafetyError
from bringup_station.sim import make_sim_machine


def test_soft_limits_block_out_of_range_moves():
    ctx = make_sim_machine()
    ctx.gantry.home()
    with pytest.raises(SoftLimitError):
        ctx.gantry.move_xy(9999, 0)


def test_probe_finds_contact_at_expected_force():
    ctx = make_sim_machine()
    ctx.gantry.home()
    contact = ctx.gantry.probe_point(10.0, 10.0)
    cfg = ctx.config.probe
    assert contact.force_n >= cfg.target_force_n
    assert contact.force_n <= cfg.max_force_n
    # contact happens just past the simulated contact plane
    assert abs(contact.z_mm - ctx.config.nominal_contact_z_mm) <= 1.0


def test_probe_overtravel_faults_and_retracts():
    # board missing: simulated contact plane far below the overtravel window
    ctx = make_sim_machine()
    ctx.gantry.home()
    with pytest.raises(ProbeContactError):
        ctx.gantry.probe_point(0.0, 0.0, expected_contact_z=40.0)
    # always retracts to safe z on fault
    assert ctx.gantry.position[2] == ctx.config.safe_z_mm


def test_estop_blocks_motion():
    ctx = make_sim_machine()
    ctx.gantry.home()
    ctx.safety_io.set_estop(True)
    with pytest.raises(SafetyError):
        ctx.gantry.move_xy(0, 0)


def test_door_open_blocks_motion():
    ctx = make_sim_machine()
    ctx.gantry.home()
    ctx.safety_io.set_door_closed(False)
    with pytest.raises(SafetyError):
        ctx.gantry.probe_point(0, 0)
