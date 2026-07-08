"""C3 — SPI, UART, CAN, RS485 Bus Engines v1.

First-class bus contracts beyond I2C (shared_bus.py stays the I2C source
of truth and is untouched). Every contract carries: required/optional
nets, voltage-domain gate, support-circuit hooks, role-aware placement
hints (C1 roles), routing hints, firmware metadata, a validation
workflow, and blocked claims. Termination/bias/protection VALUES require
datasheet/policy evidence (C2) — absent evidence is recorded
review-required, never defaulted silently. No protocol, compliance,
timing, or high-speed claim is made by any engine.
"""
import datasheet_ingest_v2 as dv2

BUS_CONTRACT_FIELDS = (
    "bus_id", "bus_type", "voltage_domain", "controller", "peripherals",
    "required_nets", "optional_nets", "pullups", "termination",
    "protection", "connector_role", "placement_hints", "routing_hints",
    "firmware_metadata", "validation_workflow", "blocked_claims", "state",
    "review_required")

COMMON_BLOCKED = ["protocol_correctness", "timing_correctness",
                  "signal_integrity", "EMC", "compliance_certification"]


def voltage_domain_gate(controller_v, peripheral_v):
    """Explicit domain check: match -> ok; known mismatch -> level shifter
    REQUIRED; unknown -> blocked (never guessed)."""
    if controller_v is None or peripheral_v is None:
        return {"state": "blocked",
                "reason": "voltage domain unknown — no silent assumption"}
    if controller_v == peripheral_v:
        return {"state": "ok", "domain": controller_v}
    return {"state": "level_shifter_required",
            "detail": "%s <-> %s domains differ; a level shifter (TXB "
                      "class) must sit between them (C1 placement rule "
                      "levelshift_between_domains)" % (controller_v,
                                                       peripheral_v)}


def _termination(part_for_evidence, evidence_type, policy_value=None,
                 policy_source=None):
    """Termination/bias values need evidence or an explicit policy."""
    if policy_value is not None and policy_source:
        return {"value": policy_value, "source": "policy:%s" % policy_source,
                "state": "policy_set_review_required"}
    ev = dv2.support_value_v2(part_for_evidence or "UNKNOWN", evidence_type)
    if ev["state"] == "evidence_verified_review_required":
        return {"value": ev["value"], "source": ev["source_ref"],
                "state": "evidence_backed_review_required"}
    return {"value": None, "source": None,
            "state": "recorded_absent_review_required",
            "note": "no termination/bias evidence — recorded, NOT faked; "
                    "board still generates, claim gates stay closed"}


def _base(bus_id, bus_type, controller, peripherals, domain_gate):
    return {
        "bus_id": bus_id, "bus_type": bus_type,
        "voltage_domain": domain_gate,
        "controller": controller, "peripherals": peripherals,
        "optional_nets": [], "pullups": None, "termination": None,
        "protection": {"state": "placeholder — ESD device requires "
                                "evidence or explicit selection"},
        "connector_role": None,
        "firmware_metadata": {}, "blocked_claims": list(COMMON_BLOCKED),
        "review_required": [],
        "state": "contract_review_required"
                 if domain_gate["state"] != "blocked" else "blocked",
    }


def spi_bus(bus_id, controller, peripherals, controller_v=None,
            peripheral_v=None, qspi=False):
    gate = voltage_domain_gate(controller_v, peripheral_v)
    c = _base(bus_id, "spi", controller, peripherals, gate)
    c["required_nets"] = ["SPI_SCLK", "SPI_MOSI", "SPI_MISO"] + [
        "SPI_CS_%s" % (p.get("name", i)) for i, p in enumerate(peripherals)]
    c["chip_selects"] = {p.get("name", str(i)): "SPI_CS_%s"
                         % (p.get("name", i))
                         for i, p in enumerate(peripherals)}
    if qspi:
        c["required_nets"] = ["QSPI_SCLK", "QSPI_SS", "QSPI_SD0", "QSPI_SD1",
                              "QSPI_SD2", "QSPI_SD3"]
        c["firmware_metadata"]["qspi"] = "boot flash class — nets follow "\
            "the proven bare-RP2040 QSPI pattern"
    c["optional_nets"] = ["SPI_HOLD", "SPI_WP"] if not qspi else []
    series = dv2.support_value_v2(
        (peripherals[0].get("part") if peripherals else None) or "UNKNOWN",
        "bus_timing_limits")
    c["series_resistors"] = ("evidence_backed"
                             if series["state"].startswith("evidence_verified")
                             else "not_added — no evidence; recorded")
    c["placement_hints"] = ["flash_near_mcu (C1) for flash-class "
                            "peripherals", "keep CS stubs short"]
    c["routing_hints"] = [{"group": "spi", "nets": c["required_nets"],
                           "note": "route as a group; no length matching "
                                   "claim at FS speeds"}]
    c["validation_workflow"] = ["continuity per net", "CS isolation check",
                                "loopback if firmware supports"]
    return c


def uart_bus(bus_id, controller, peripheral, controller_v=None,
             peripheral_v=None, flow_control=False, debug_header=False):
    gate = voltage_domain_gate(controller_v, peripheral_v)
    c = _base(bus_id, "uart", controller, [peripheral], gate)
    c["required_nets"] = ["UART_TX", "UART_RX"]
    c["crossover"] = "controller TX -> peripheral RX (crossover applied at "\
        "the contract level, not silently at routing)"
    if flow_control:
        c["optional_nets"] = ["UART_RTS", "UART_CTS"]
    if gate["state"] == "level_shifter_required":
        c["review_required"].append("insert level shifter between domains")
    if debug_header:
        c["connector_role"] = "debug_header"
        c["placement_hints"] = ["debug header at board edge (C1 "
                                "testpoint_accessible class)"]
    c["blocked_claims"].append("baud_rate_reliability (needs validation)")
    c["validation_workflow"] = ["continuity TX/RX", "crossover check",
                                "loopback echo test if firmware supports"]
    return c


def can_bus(bus_id, controller, controller_v=None, endpoint=False,
            termination_policy=None):
    gate = voltage_domain_gate(controller_v, controller_v)
    c = _base(bus_id, "can", controller, [{"name": "bus"}], gate)
    c["required_nets"] = ["CAN_TX", "CAN_RX", "CANH", "CANL"]
    c["transceiver"] = {"role": "can_transceiver",
                        "placement": "between MCU side and connector side "
                                     "(C1 rule can_between_mcu_connector)"}
    c["termination"] = (_termination(None, "bus_timing_limits",
                                     policy_value="120 ohm",
                                     policy_source=termination_policy)
                        if endpoint and termination_policy
                        else {"value": None,
                              "state": "not_terminated",
                              "note": "termination only when role is "
                                      "endpoint AND policy/evidence allows "
                                      "— never automatic"})
    c["ground_reference"] = "common ground required across nodes; "\
        "isolation is a separate module class"
    c["connector_role"] = "power_connector/header"
    c["blocked_claims"] += ["ISO_11898_compliance", "bus_fault_tolerance"]
    c["validation_workflow"] = ["continuity CANH/CANL", "transceiver "
                                "supply check", "loopback with second node "
                                "(bench)"]
    c["routing_hints"] = [{"group": "can_pair", "nets": ["CANH", "CANL"],
                           "note": "route CANH/CANL together; no impedance "
                                   "claim (no stackup data)"}]
    return c


def rs485_bus(bus_id, controller, controller_v=None, duplex="half",
              termination_policy=None, bias_policy=None):
    gate = voltage_domain_gate(controller_v, controller_v)
    c = _base(bus_id, "rs485", controller, [{"name": "bus"}], gate)
    c["required_nets"] = (["RS485_DI", "RS485_RO", "RS485_DE_RE", "RS485_A",
                           "RS485_B"] if duplex == "half"
                          else ["RS485_DI", "RS485_RO", "RS485_DE",
                                "RS485_RE", "RS485_TXA", "RS485_TXB",
                                "RS485_RXA", "RS485_RXB"])
    c["duplex"] = duplex
    c["transceiver"] = {"role": "rs485_transceiver",
                        "placement": "between MCU and terminal/header (C1 "
                                     "rule rs485_between_mcu_connector)"}
    c["termination"] = _termination(None, "bus_timing_limits",
                                    policy_value="120 ohm" if
                                    termination_policy else None,
                                    policy_source=termination_policy)
    c["bias"] = _termination(None, "pullup_pulldown_values",
                             policy_value="560 ohm bias pair" if bias_policy
                             else None, policy_source=bias_policy)
    c["connector_role"] = "screw_terminal/header"
    c["blocked_claims"] += ["modbus_protocol_correctness",
                            "network_length_rating"]
    c["validation_workflow"] = ["continuity A/B", "DE/RE control check",
                                "loopback with second node (bench)"]
    c["routing_hints"] = [{"group": "rs485_pair", "nets": ["RS485_A",
                                                           "RS485_B"],
                           "note": "route A/B together; no impedance claim"}]
    return c


def make_bus(bus_type, **kw):
    engines = {"spi": spi_bus, "uart": uart_bus, "can": can_bus,
               "rs485": rs485_bus}
    if bus_type not in engines:
        return {"error": "unsupported bus type %s (i2c lives in "
                         "shared_bus.py)" % bus_type}
    return engines[bus_type](**kw)
