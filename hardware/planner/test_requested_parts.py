"""What the user asked for must either be built or be REPORTED as substituted.

Two silent drops, both found on a real board: an exact MCU ("STM32L071") was
reduced to its family at parse time and the catalogue's STM32F103 was reported
as "the requested MCU"; and requested connectors ("a 2-position screw terminal
and a 2x4 pin header") were never parsed at all, so the board shipped with
neither and the design gate correctly refused it for having no connector.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import intent  # noqa: E402
import mcu_selector  # noqa: E402

PROMPT = ("Simple I2C temperature sensor breakout: an STM32L071 MCU reading a BME280 "
          "over I2C, a 2-position screw terminal for 5V and GND, and a 2x4 pin header "
          "breaking out 3V3, GND, SWDIO, SWCLK, SDA and SCL.")


def _req(fam, requested, buses=("I2C",)):
    return mcu_selector.requirements_from_design(
        {"mcu": {"family": fam, "requested": requested}, "buses": list(buses),
         "sensors": [], "radios": []}, [])


def test_exact_mcu_token_survives_parsing():
    d = intent.parse_intent(PROMPT)
    assert d["mcu"]["family"] == "STM32"
    assert d["mcu"]["requested"] == "STM32L071", d["mcu"]


def test_requested_connectors_are_parsed():
    d = intent.parse_intent(PROMPT)
    kinds = {(c["kind"], c.get("pins") or (c.get("rows"), c.get("cols"))) for c in d["connectors"]}
    assert ("screwterminal", 2) in kinds, d["connectors"]
    assert ("header", (2, 4)) in kinds, d["connectors"]


def test_unstocked_exact_part_lands_on_its_family_and_is_reported():
    r = mcu_selector.select_mcu(_req("STM32", "STM32L071"))
    assert r["selected"] == "STM32F103", r          # nearest stocked relative, not RP2040
    assert r["substituted_for"] == "STM32L071", r    # and it SAYS so
    assert "NOT in the seed library" in r["why"], r["why"]


def test_exact_stocked_part_is_not_a_substitution():
    r = mcu_selector.select_mcu(_req("STM32", "STM32F103C8T6"))
    assert r["selected"] == "STM32F103"
    assert r["substituted_for"] is None, r


def test_bare_family_request_is_honoured_not_flagged():
    r = mcu_selector.select_mcu(_req("STM32", None))
    assert r["selected"] == "STM32F103"
    assert r["substituted_for"] is None, r


def test_unknown_part_with_no_family_is_reported_loudly():
    r = mcu_selector.select_mcu(_req(None, "XYZ9000"))
    assert r["selected"]                             # something is built
    assert r["substituted_for"] == "XYZ9000", r      # but the drop is not silent
    assert "no stocked relative" in r["why"], r["why"]


def test_header_with_words_between_dimensions_and_header_is_parsed():
    from hardware.planner.intent import parse_intent
    for prompt in ("2x4 pin SWD header for debug", "a 2x5 shrouded header", "2x4 header"):
        di = parse_intent(prompt)
        heads = [c for c in di["connectors"] if c["kind"] == "header"]
        assert heads and heads[0]["rows"] == 2 and heads[0]["cols"] in (4, 5), (prompt, di["connectors"])


def test_requested_connector_row_starts_past_the_test_points(tmp_path):
    """The bottom row placed TP1-TP4 at 5mm steps but never advanced the cursor, so
    the first requested connector sat on TP1/TP2 (measured: PLACEMENT GATE FAIL
    'overlap: TP1 <-> J20' on the first board that asked for a screw terminal)."""
    import synth
    compose = synth.compose  # the module object synth actually calls, not a second import
    pins = [{"number": "1", "name": "SDA", "etype": "bidirectional"},
            {"number": "2", "name": "SCL", "etype": "bidirectional"},
            {"number": "3", "name": "VCC", "etype": "power_in"},
            {"number": "4", "name": "GND", "etype": "power_in"}]
    dev = lambda mpn, cat, fp: {"mpn": mpn, "category": cat, "pins": pins, "kicad_footprint": fp,
                                "interfaces": [{"type": "i2c", "signals": {}}]}
    design = {"final_design": [dev("ADS1115IDGS", "adc.precision", "Package_SO:TSSOP-10_3x3mm_P0.5mm"),
                               dev("24LC02", "memory.eeprom", "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm")],
              "intent": {"mcu": {"family": "rp2040"},
                         "connectors": [{"kind": "screwterminal", "pins": 2}]}}
    placed = {}
    real_place, real_tp = compose.place, compose.tp
    def rec_place(lib, fp, ref, x, y, *a, **k):
        placed[ref] = (x, y); return real_place(lib, fp, ref, x, y, *a, **k)
    def rec_tp(ref, x, y, *a, **k):
        placed[ref] = (x, y); return real_tp(ref, x, y, *a, **k)
    compose.place, compose.tp = rec_place, rec_tp
    try:
        synth.synth(design, str(tmp_path / "board.kicad_pcb"))
    finally:
        compose.place, compose.tp = real_place, real_tp
    tps = {r: xy for r, xy in placed.items() if r.startswith("TP")}
    assert "J20" in placed, sorted(placed)
    assert tps, sorted(placed)
    jx, jy = placed["J20"]
    same_row = [r for r, (x, y) in tps.items() if abs(y - jy) < 3]
    assert same_row, "test points and the connector should share the bottom row"
    last_tp_x = max(placed[r][0] for r in same_row)
    assert jx >= last_tp_x + 4 + 3, f"J20 at x={jx} overlaps test points ending at x={last_tp_x}: {tps}"
