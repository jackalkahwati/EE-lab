"""Silkscreen polarity: a '+' printed beside the negative terminal passes ERC,
passes DRC, gets fabricated, and tells whoever wires the battery to reverse it."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "blocks"))
import compose  # noqa: E402

BOX = (0.0, 0.0, 4.0, 2.0)  # centre (2, 1)


def _placed(ref="J1"):
    return [{"ref": ref, "box": BOX}]


def test_reversed_marking_is_caught():
    """The article's fault: '+' next to the negative pad."""
    problems = compose.check_silk_polarity(
        silk=[("BAT + -", 2.0, 1.0, 0.6)],
        netlist=[{"ref": "J1", "netmap": {"1": "GND", "2": "VBAT"}}],
        placed=_placed(),
    )
    assert len(problems) == 1, problems
    assert "reversed" in problems[0]
    assert "pad 1 = GND" in problems[0]


def test_correct_marking_is_silent():
    problems = compose.check_silk_polarity(
        silk=[("BAT + -", 2.0, 1.0, 0.6)],
        netlist=[{"ref": "J1", "netmap": {"1": "VBAT", "2": "GND"}}],
        placed=_placed(),
    )
    assert problems == [], problems


def test_non_polarity_labels_are_ignored():
    for text in ("CONSOLE G TX RX", "FLASH 3V3 G TX RX EN IO9", "ANTENNA KEEP-OUT",
                 "MONITOR-ONLY  no supply  no DMM claim", "DUT IN 0-24V 0-500mA MAX"):
        assert compose.check_silk_polarity(
            silk=[(text, 2.0, 1.0, 0.6)],
            netlist=[{"ref": "J1", "netmap": {"1": "GND", "2": "VBAT"}}],
            placed=_placed(),
        ) == [], text


def test_label_binds_to_the_NEAREST_part():
    """Two connectors, opposite polarity order — the check must not pick the wrong one."""
    netlist = [
        {"ref": "J1", "netmap": {"1": "VBAT", "2": "GND"}},   # correct
        {"ref": "J2", "netmap": {"1": "GND", "2": "VBAT"}},   # reversed
    ]
    placed = [{"ref": "J1", "box": (0.0, 0.0, 4.0, 2.0)},     # centre (2, 1)
              {"ref": "J2", "box": (40.0, 0.0, 44.0, 2.0)}]   # centre (42, 1)
    assert compose.check_silk_polarity([("BAT + -", 2.0, 1.0, 0.6)], netlist, placed) == []
    near_j2 = compose.check_silk_polarity([("BAT + -", 42.0, 1.0, 0.6)], netlist, placed)
    assert len(near_j2) == 1 and "J2" in near_j2[0], near_j2


def test_a_part_that_is_not_a_power_interface_is_skipped():
    assert compose.check_silk_polarity(
        silk=[("SIG + -", 2.0, 1.0, 0.6)],
        netlist=[{"ref": "U1", "netmap": {"1": "SDA", "2": "SCL"}}],
        placed=_placed("U1"),
    ) == []


def test_rail_names_are_recognised():
    for pos in ("VBAT", "VBUS", "VIN", "VCC", "VDD", "3V3", "5V", "BAT+"):
        problems = compose.check_silk_polarity(
            silk=[("PWR + -", 2.0, 1.0, 0.6)],
            netlist=[{"ref": "J1", "netmap": {"1": "GND", "2": pos}}],
            placed=_placed(),
        )
        assert len(problems) == 1, f"{pos} should read as positive: {problems}"
