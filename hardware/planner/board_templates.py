"""C7 — Customer Board Program Templates v1.

Eight reusable program templates for the majority enterprise envelope.
These are not demo mockups: each instantiates to a compose spec in the
PROVEN block vocabulary, cites the real routed-in-sandbox run(s) that
already exercised its board class, names required evidence, and blocks
unsupported variants with the exact gate that refuses them.
"""
import usb_fs

TEMPLATES = {
    "environmental_telemetry_node": {
        "prompt_example": "battery telemetry node: MCU, BME280, LoRa, "
                          "debug header, test points",
        "architecture_blocks": ["power", "mcu", "i2c sensor", "lora",
                                "antenna"],
        "board_class": "lora-node / env-sensor class",
        "proven_runs": ["run-demo-loranode-1783227819",
                        "env-sensor-benchmark-v2"],
        "allowed_variants": ["BME280 or sourced I2C sensor", "GNSS add-on",
                             "battery or USB-C power"],
        "blocked_variants": {"RF performance tuning": "M10R gates",
                             "custom antenna design": "module-contained "
                                                      "RF only"},
        "required_evidence": ["sensor datasheet candidates (C2)",
                              "module cert evidence for regulatory claims"],
        "validation_plan": ["power rails", "I2C scan", "LoRa comms check",
                            "GNSS sky test if fitted (field)"],
        "roi_note": "replaces a contractor spin for telemetry pilots",
    },
    "industrial_io_controller": {
        "prompt_example": "industrial IO controller: MCU, CAN or RS485, "
                          "GPIO expansion, protected power, status LEDs",
        "architecture_blocks": ["power", "mcu", "can bus", "gpio bank",
                                "status led"],
        "board_class": "fl1-comms-head-can class",
        "proven_runs": ["run-fl1comms-1783238274"],
        "allowed_variants": ["CAN (C3 engine)", "RS485 (C3 engine)",
                             "isolated CAN module (review-required)"],
        "blocked_variants": {"mains input": "M9R mains gate",
                             "high-current outputs": "M9R power-stage gate"},
        "required_evidence": ["termination policy or evidence (C3)"],
        "validation_plan": ["power", "bus loopback (bench)",
                            "GPIO continuity"],
        "roi_note": "commonest industrial pilot shape",
    },
    "lab_instrument_interface": {
        "prompt_example": "lab instrument interface: MCU, relays, ADC "
                          "monitor, board-ID EEPROM, instrument bus",
        "architecture_blocks": ["power", "mcu", "relay", "current sense "
                                "instrument", "board id eeprom", "fl1 bus"],
        "board_class": "fl1-core / instrument class",
        "proven_runs": ["fl1-core6-bare-rp2040-combination-v1"],
        "allowed_variants": ["relay count scaling", "CAN uplink"],
        "blocked_variants": {"measurement accuracy claims":
                             "calibration evidence required (M3B)"},
        "required_evidence": ["relay contact ratings (C2 candidates)"],
        "validation_plan": ["relay click test", "ADC sanity read",
                            "EEPROM ID read"],
        "roi_note": "instrument-adjacent boards; FL-1 bundle anchor",
    },
    "dut_power_monitor": {
        "prompt_example": "DUT power monitor: power in/out, current sense, "
                          "divider, ADC, protection",
        "architecture_blocks": ["power", "mcu", "current sense instrument",
                                "cal reference"],
        "board_class": "fl1-dc-measure class",
        "proven_runs": ["fl1-meas-v2"],
        "allowed_variants": ["INA2xx or shunt+ADC", "protection set (C5)"],
        "blocked_variants": {"current accuracy claims":
                             "calibration evidence required",
                             "high-current path": "M9R gate"},
        "required_evidence": ["shunt tolerance (C2)",
                              "load currents for PI (still absent)"],
        "validation_plan": ["rail voltages", "known-load sanity read"],
        "roi_note": "pairs directly with FL-1 validation sessions",
    },
    "calibration_reference_board": {
        "prompt_example": "calibration reference: voltage reference, ADC, "
                          "EEPROM, test points",
        "architecture_blocks": ["power", "mcu", "cal reference",
                                "board id eeprom"],
        "board_class": "fl1-cal class",
        "proven_runs": ["fl1-cal-board-v4"],
        "allowed_variants": ["REF30xx class references"],
        "blocked_variants": {"analog accuracy claims":
                             "structurally physical — calibration "
                             "evidence required (M3B)"},
        "required_evidence": ["reference tolerance data (C2)"],
        "validation_plan": ["reference voltage read (sanity, NOT "
                            "calibration)"],
        "roi_note": "anchors honest measurement stories",
    },
    "adapter_breakout": {
        "prompt_example": "adapter/breakout: connectors, power, level "
                          "shifting, test points",
        "architecture_blocks": ["power", "gpio bank"],
        "board_class": "connector-breakout / lab-adapter class",
        "proven_runs": ["connector-breakout-v1", "lab-adapter-v1"],
        "allowed_variants": ["TXB-class level shifting (M6 rails)",
                             "2-layer where the profile allows"],
        "blocked_variants": {},
        "required_evidence": [],
        "validation_plan": ["continuity map"],
        "roi_note": "fast, low-risk first boards for pilots",
    },
    "validation_coupon": {
        "prompt_example": "validation coupon: power rails, test "
                          "structures, evidence workflow",
        "architecture_blocks": ["power"],
        "board_class": "coupon class",
        "proven_runs": ["power-entry-header-v1"],
        "allowed_variants": ["rail/test-structure coupons"],
        "blocked_variants": {"impedance coupon": "no stackup data — "
                             "controlled-impedance workflow blocked (M3B)",
                             "BGA escape coupon": "no escape emitter "
                             "(M7R)"},
        "required_evidence": ["stackup data would unlock the impedance "
                              "coupon"],
        "validation_plan": ["continuity + resistance sweep"],
        "roi_note": "feeds the physical evidence ledger first",
    },
    "usb_fs_data_logger": {
        "prompt_example": "USB-FS data logger: MCU, USB-FS, sensor, "
                          "storage placeholder",
        "architecture_blocks": ["power", "mcu", "i2c sensor",
                                "usb-fs data"],
        "board_class": "usb-fs logger class",
        "proven_runs": [],
        "allowed_variants": [],
        "blocked_variants": {"the whole template TODAY": "C4 primitives "
                             "missing: verified ESD device + router-proven "
                             "D+/D- pair", "USB compliance": "always "
                             "blocked"},
        "required_evidence": ["C4 primitive completion"],
        "validation_plan": usb_fs.VALIDATION_PLAN,
        "roi_note": "unlocks once C4 primitives land",
    },
}


def instantiate(template_name, variant=None):
    t = TEMPLATES.get(template_name)
    if not t:
        return {"state": "blocked", "reason": "unknown template"}
    if variant and variant in t["blocked_variants"]:
        return {"state": "blocked",
                "variant": variant,
                "blocked_by": t["blocked_variants"][variant],
                "honesty": "unsupported variants block with the exact "
                           "gate; nothing degrades silently"}
    if template_name == "usb_fs_data_logger":
        gate = usb_fs.usb_fs_contract()
        return {"state": "blocked", "template": template_name,
                "blocked_by": gate["missing_primitives"],
                "honesty": "template blocks until C4 primitives exist"}
    return {
        "state": "instantiable_review_required",
        "template": template_name,
        "compose_spec": {"blocks": t["architecture_blocks"],
                         "boardClass": t["board_class"]},
        "proven_runs_cited": t["proven_runs"],
        "required_evidence": t["required_evidence"],
        "validation_plan": t["validation_plan"],
        "evidence_pack_mapping": {
            "scope": "board",
            "run_dir": t["proven_runs"][0] if t["proven_runs"] else None,
            "generator": "E3 buildEvidencePack"},
        "honesty": "instantiation cites runs that ALREADY routed in "
                   "sandbox; a new instance still runs the full "
                   "architecture/design/routing/DRC gates itself",
    }
