"""Focused unit regressions for planner decisions not covered by run artifacts."""
import build_policy
import mcu_selector
import shared_bus


def _device(mpn, interfaces, category="part"):
    return {
        "mpn": mpn,
        "category": category,
        "pins": [{"number": "1", "name": "IO", "etype": "bidirectional"}],
        "interfaces": interfaces,
    }


def test_blank_mcu_intent_uses_external_bus_source():
    design = {
        "intent": {"mcu": {"family": None}},
        "final_design": [_device("SENSOR", [{"type": "i2c", "signals": {}}])],
    }
    bus = shared_bus.model_buses(design)[0]
    assert "external master" in bus["source"]


def test_alternate_interface_does_not_create_phantom_bus():
    sensor = _device("BME280", [
        {"type": "i2c", "signals": {}, "role": "primary"},
        {"type": "spi", "signals": {}, "role": "alt"},
    ])
    buses = shared_bus.model_buses({
        "intent": {"mcu": {"family": "RP2040"}},
        "final_design": [sensor],
    })
    assert [bus["type"] for bus in buses] == ["i2c"]


def test_write_only_spi_omits_miso_and_gets_a_unique_select():
    shift = _device(
        "74HC595",
        [{"type": "spi_write_only", "signals": {
            "sck": "SRCLK", "mosi": "SER", "latch": "RCLK"}}],
        category="logic.shift_register",
    )
    bus = shared_bus.model_buses({
        "intent": {"mcu": {"family": "RP2040"}},
        "final_design": [shift],
    })[0]
    assert bus["required_nets"] == ["SPI_SCK", "SPI_MOSI"]
    assert bus["chip_selects"] == {"74HC595": "SR_LATCH"}


def test_duplicate_spi_select_is_reported_for_repeated_parts():
    flash = _device(
        "W25Q",
        [{"type": "spi", "signals": {
            "sck": "CLK", "mosi": "DI", "miso": "DO", "cs": "CS"}}],
        category="memory.spi_flash",
    )
    bus = shared_bus.model_buses({
        "intent": {"mcu": "RP2040"}, "final_design": [flash, dict(flash)],
    })[0]
    assert len(bus["chip_selects"]) == 2
    assert any(problem["code"] == "spi_duplicate_cs"
               for problem in shared_bus.check_bus(bus, {}))


def test_bus_connection_requires_source_and_ignores_pullups_as_endpoints():
    bus = {
        "type": "i2c",
        "required_nets": ["I2C_SDA"],
        "device_count": 2,
        "required_endpoint_count": 3,
        "pullups": {"required": False},
    }
    missing_source = {
        "I2C_SDA": [("U1", "1", "sensor"), ("U2", "1", "sensor"),
                    ("R1", "1", "resistor")],
    }
    assert any(problem["code"] == "disconnected_or_fake_net"
               for problem in shared_bus.check_bus(bus, missing_source))

    complete = {"I2C_SDA": missing_source["I2C_SDA"] + [("U0", "1", "mcu")]}
    assert not any(problem["code"] == "disconnected_or_fake_net"
                   for problem in shared_bus.check_bus(bus, complete))


def test_usb_c_power_does_not_require_mcu_usb_data():
    intent = {
        "required_capabilities": ["usb_c_power"],
        "product_goal": "powered sensor",
        "power": {"source": "usb_c"},
        "battery": {"required": False},
        "buses": [],
        "mcu": {"family": None},
    }
    req = mcu_selector.requirements_from_design(intent, [])
    assert req["usb"] is False


def test_wired_usb_interface_requires_mcu_usb_data():
    usb = _device("USB-CONN", [{"type": "usb", "signals": {"dp": "D+", "dm": "D-"}}])
    req = mcu_selector.requirements_from_design({"buses": []}, [usb])
    assert req["usb"] is True


def test_battery_intent_requests_low_power_mcu():
    req = mcu_selector.requirements_from_design({
        "battery": {"required": True}, "buses": [],
    }, [])
    assert req["low_power"] is True


def test_legacy_string_inputs_remain_supported_without_character_splitting():
    legacy = _device("SENSOR", ["i2c"])
    req = mcu_selector.requirements_from_design({
        "mcu": "SAMD21", "required_capabilities": "wifi", "buses": "UART",
    }, [legacy])
    assert req["requested_mcu"] == "SAMD21"
    assert req["wireless"] == ["wifi"]
    assert set(req["interfaces"]) == {"i2c", "uart"}
    legacy_bus = shared_bus.model_buses({
        "intent": {"mcu": "SAMD21"}, "final_design": [legacy],
    })[0]
    assert legacy_bus["type"] == "i2c"
    assert legacy_bus["source"] == "MCU (SAMD21)"


def test_order_package_requires_assembly_and_sourcing_evidence():
    base = {
        "build_recommendation": "ready_to_build_with_review",
        "routes_clean": True,
        "drc_violations": 0,
    }
    missing = build_policy.build_policy("board", base)
    assert missing["allowed_to_generate_order_package"] is False
    assert missing["package_type"] == "design_attempt_package"
    assert missing["allowed_to_attempt_board"] is True

    complete = build_policy.build_policy("board", {
        **base, "assembly_ready": True, "sourced": True,
    })
    assert complete["allowed_to_generate_order_package"] is True
    assert complete["required_human_review"] is True
