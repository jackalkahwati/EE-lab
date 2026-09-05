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
