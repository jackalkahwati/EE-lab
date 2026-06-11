from bringup_station.boardio.testpoints import Board, TestPoint
from bringup_station.sequencer.plan import Action, Limits, Step, TestPlan
from bringup_station.sim import make_sim_machine
from bringup_station.vision.registration import fit_transform


def make_board():
    board = Board(name="demo")
    for tp in [TestPoint("TP1", "3V3", 10.0, 5.0),
               TestPoint("TP2", "GND", -10.0, 5.0)]:
        board.testpoints[tp.name] = tp
    return board


def make_plan():
    return TestPlan(name="rail check", board="demo", steps=[
        Step(Action.SET_POWER,
             params={"channel": 0, "volts": 5.0, "current_limit_a": 0.5}),
        Step(Action.MEASURE_VOLTAGE, target="TP1",
             params={"probe": 0, "channel": 0}, limits=Limits(3.2, 3.4)),
        Step(Action.MEASURE_VOLTAGE, target="TP2",
             params={"probe": 0, "channel": 1}, limits=Limits(-0.05, 0.05)),
        Step(Action.POWER_OFF),
    ])


def test_full_plan_passes_with_good_dut():
    ctx = make_sim_machine()
    ctx.daq.channel_volts = {0: 3.3, 1: 0.0}  # healthy virtual DUT
    report = ctx.engine.run(make_plan(), make_board())
    assert report.passed
    assert not report.aborted
    # cleanup happened
    assert not ctx.power.any_on
    assert ctx.router.routes == {}
    assert ctx.gantry.position[2] == ctx.config.safe_z_mm


def test_bad_rail_fails_step_but_completes_run():
    ctx = make_sim_machine()
    ctx.daq.channel_volts = {0: 1.2, 1: 0.0}  # 3V3 rail collapsed
    report = ctx.engine.run(make_plan(), make_board())
    assert not report.passed
    assert not report.aborted
    failed = [r for r in report.results if not r.ok]
    assert len(failed) == 1
    assert failed[0].value == 1.2


def test_estop_mid_run_aborts_and_cleans_up():
    ctx = make_sim_machine()
    ctx.daq.channel_volts = {0: 3.3}

    plan = make_plan()
    # trip e-stop right after the power-on step by hooking the power system
    original = ctx.power.set_output

    def tripping_set_output(channel, enabled):
        original(channel, enabled)
        if enabled:
            ctx.safety_io.set_estop(True)

    ctx.power.set_output = tripping_set_output
    report = ctx.engine.run(plan, make_board())
    assert report.aborted
    assert "estop" in report.abort_reason
    assert ctx.router.routes == {}


def test_run_with_board_transform():
    ctx = make_sim_machine()
    ctx.daq.channel_volts = {0: 3.3, 1: 0.0}
    # board placed shifted on the fixture; fiducials found by "vision"
    transform = fit_transform(
        [(0.0, 0.0), (100.0, 0.0), (0.0, 50.0)],
        [(20.0, -15.0), (120.0, -15.0), (20.0, 35.0)])
    report = ctx.engine.run(make_plan(), make_board(), transform)
    assert report.passed


def test_gate_step_failure_aborts_run():
    ctx = make_sim_machine()
    ctx.smu.resistance_script = [2.0]  # dead short to ground
    plan = TestPlan(name="gated", board="demo", steps=[
        Step(Action.MEASURE_RESISTANCE, target="TP1",
             params={"probe": 0, "ref": "gnd"},
             limits=Limits(lo=100.0, hi=1e12), gate=True),
        Step(Action.SET_POWER,
             params={"channel": 0, "volts": 5.0, "current_limit_a": 0.5}),
    ])
    report = ctx.engine.run(plan, make_board())
    assert report.aborted
    assert "gate step failed" in report.abort_reason
    # the short was caught before power was ever applied
    assert ("output", 0, True) not in ctx.power.events
