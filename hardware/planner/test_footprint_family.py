"""A connector is not a chip.

Mutation-checked: making _footprint_for return "0402" unconditionally — which
is exactly the bug this replaced, a 5.0mm screw terminal emitted as a 1.0x0.5mm
chip pad — passed the entire 118-test suite before this file existed. The fix
that unblocked every connector-bearing board had no coverage at all.
"""
import importlib.util
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent

# synth.py pulls in the whole planner on import, so lift the two pure helpers
# out of the source instead. That keeps this a unit test, not an integration one.
_SRC = (HERE / "synth.py").read_text()
_NS = {"re": re, "_QFN_SIZES": [6, 8, 16, 24, 32, 48]}
_start = _SRC.index("_CONNECTOR_RX")
_end = _SRC.index("# bench/instrument extras")
exec(compile(_SRC[_start:_end], "synth-helpers", "exec"), _NS)
footprint_for = _NS["_footprint_for"]


def _pads(n):
    return {str(i): f"NET{i}" for i in range(1, n + 1)}


def test_a_screw_terminal_is_not_an_0402():
    """The original fault: MX126-5.0-02P, 2 pads, became "0402"."""
    fp = footprint_for("TerminalBlock_Phoenix", "TerminalBlock_MX126_5.0mm_2pos", _pads(2))
    assert fp == "screwterminal_2", fp
    assert "0402" not in fp


def test_pin_headers_keep_their_real_geometry():
    assert footprint_for("Connector_PinHeader_2.54mm", "PinHeader_2x04_P2.54mm_Vertical", _pads(8)) == "header_2x4"
    assert footprint_for("Connector_PinHeader_2.54mm", "PinHeader_1x08_P2.54mm_Vertical", _pads(8)) == "header_1x8"
    assert footprint_for("Connector_PinHeader_2.54mm", "PinHeader_1x02_P2.54mm_Vertical", _pads(2)) == "header_1x2"


def test_a_connector_never_gets_a_chip_footprint():
    """design_check's connector rule matches on the footprint string, so any
    chip-shaped result here re-creates the deadlock: the planner ships a board
    whose only connector looks like a passive, and the gate blocks it."""
    for lib, name, n in [
        ("Connector_PinHeader_2.54mm", "PinHeader_1x04_P2.54mm_Vertical", 4),
        ("Connector_USB", "USB_C_Receptacle_GCT_USB4085", 12),
        ("TerminalBlock", "TerminalBlock_3pos", 3),
        ("Connector_Generic", "Conn_01x06", 6),
    ]:
        fp = footprint_for(lib, name, _pads(n))
        assert not re.match(r"^(qfn\d+|\d{4})$", fp), f"{name} -> {fp} is a chip footprint"
        assert re.search(r"header|screwterminal", fp), f"{name} -> {fp}"


def test_non_connectors_are_completely_unchanged():
    """The fix must not disturb anything that already mapped correctly."""
    assert footprint_for("Package_QFP", "LQFP-48", _pads(48)) == "qfn48"
    assert footprint_for("Capacitor_SMD", "C_0402_1005Metric", _pads(2)) == "0402"
    assert footprint_for("Package_SO", "SOIC-8", _pads(8)) == "qfn8"
    assert footprint_for("", "", _pads(24)) == "qfn24"


def test_pad_count_drives_the_pin_count():
    assert footprint_for("Connector_Generic", "Conn_01x10", _pads(10)) == "header_1x10"
    # a 2x04 name with only 8 pads stays 2x4; the name carries the real geometry
    assert footprint_for("Connector_PinHeader_2.54mm", "PinHeader_2x04", _pads(8)) == "header_2x4"


def test_the_drop_list_no_longer_deletes_connectors():
    """_CHIP_SCALE_DROP_LIBS used to contain Connector_PinHeader_2.54mm, so every
    header was removed from a chip-scale board while design_check required one."""
    m = re.search(r"_CHIP_SCALE_DROP_LIBS = \{[^}]*\}", _SRC, re.S)
    assert m, "drop list not found"
    body = m.group(0)
    assert "PinHeader" not in body, "pin headers must not be dropped from product boards"
    assert "TestPoint" not in body, "probe pads must not be dropped — the test plan needs them"
