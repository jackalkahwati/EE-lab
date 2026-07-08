"""C8 — First Physical Evidence Campaign Readiness v1.

The prioritized ladder of real boards that will populate the physical
evidence ledger. PLANNING ONLY: nothing is ordered, no quote is
submitted, no evidence is marked present. APPROVED_FOR_QUOTE remains the
human unlock; every rung names its evidence gained, risk, review needs,
instruments, pass/fail criteria, claims unlocked IF passed, and claims
that stay blocked regardless.
"""
import json
import os

RUNS = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    "..", "..", "software", "prompt-to-pcb-ui", "public",
                    "runs")

EVIDENCE_TYPES = [
    "visual_inspection", "continuity", "resistance_checks",
    "power_rail_voltage", "current_draw", "i2c_scan",
    "spi_uart_loopback", "can_rs485_loopback", "usb_enumeration",
    "firmware_bsp_boot", "oscilloscope_capture", "thermal_image",
    "dfm_feedback", "assembly_yield", "failure_analysis"]

# (name, run_dir or None, why, risk, evidence gained, claims unlocked if
#  passed, order)
LADDER = [
    ("power-entry-header", "power-entry-header-v1",
     "simplest routed+DRC-clean board; cheapest first physical datapoint",
     "low", ["visual_inspection", "continuity", "resistance_checks",
             "power_rail_voltage", "dfm_feedback"],
     ["first physically_validated board (scope: this board)",
      "DFM feedback loop opens"], 1),
    ("usbc-power-entry", "usbc-power-entry-v1",
     "USB-C power-only + fine-pitch connector assembly evidence",
     "low", ["visual_inspection", "continuity", "power_rail_voltage",
             "dfm_feedback", "assembly_yield"],
     ["fine-pitch connector assembly evidence"], 2),
    ("bme280-i2c-sensor", "bme280-sandbox-v1",
     "LGA-8 assembly + first I2C-scan evidence",
     "medium (LGA hand-assembly)", ["i2c_scan", "continuity",
                                    "power_rail_voltage"],
     ["LGA escape physically built", "I2C bring-up evidence"], 3),
    ("chipdown-pcf8574-24lc02", "chipdown-24lc02-v1",
     "generic chip-down path physically exercised",
     "low", ["i2c_scan", "continuity"],
     ["chip-down synthesis path physical evidence"], 4),
    ("txb0102-multi-rail", "chipdown-txb0102-v1",
     "M6 multi-rail domains on real copper",
     "medium", ["power_rail_voltage", "continuity"],
     ["multi-rail domain separation physically checked"], 5),
    ("ds3231m-vbat", "chipdown-ds3231m-v1",
     "VBAT domain + RTC bring-up",
     "medium", ["i2c_scan", "power_rail_voltage"],
     ["VBAT backup path evidence"], 6),
    ("ads1115-mixed-signal", "chipdown-ads1115-v1",
     "first analog measurement path (sanity, NOT calibration)",
     "medium", ["i2c_scan", "power_rail_voltage",
                "oscilloscope_capture"],
     ["ADC sanity-read evidence (accuracy still blocked)"], 7),
    ("usb-fs-board", None,
     "BLOCKED until C4 primitives exist (verified ESD + router pair proof)",
     "blocked", ["usb_enumeration"],
     [], 8),
    ("power-tree-board", None,
     "C5 LDO tree board; regulator application values still "
     "review-required",
     "medium", ["power_rail_voltage", "current_draw", "thermal_image"],
     ["first power-tree physical datapoint (stability still blocked "
      "without model)"], 9),
    ("dut-power-monitor", "fl1-meas-v2",
     "pairs with FL-1 validation sessions",
     "medium", ["power_rail_voltage", "i2c_scan",
                "oscilloscope_capture"],
     ["DUT monitor bring-up evidence"], 10),
    ("relay-control", "fl1-core6-bare-rp2040-combination-v1",
     "relay click + bare-RP2040 boot attempt — the big one",
     "high (127 components, QFN-56 reflow, boot risk)",
     ["firmware_bsp_boot", "continuity", "i2c_scan",
      "oscilloscope_capture", "assembly_yield", "failure_analysis"],
     ["bare-MCU boot evidence IF it boots (never claimed before)"], 11),
    ("controlled-impedance-coupon", None,
     "BLOCKED: no stackup data — coupon design cannot claim target Z",
     "blocked", ["dfm_feedback"], [], 12),
    ("bga-escape-coupon", None,
     "BLOCKED: no ball-grid escape emitter (M7R)",
     "blocked", ["dfm_feedback"], [], 13),
]

ALWAYS_BLOCKED = [
    "production_readiness (needs yield + manufacturing evidence at scale)",
    "calibration/accuracy (needs reference instruments + evidence)",
    "EMC/compliance", "thermal safety ratings", "lifetime/reliability"]


def rung_report(name, run_dir, why, risk, evidence, unlocks, order):
    quote_ready = False
    drc = None
    if run_dir:
        p = os.path.join(RUNS, run_dir, "data", "last-run.json")
        if os.path.exists(p):
            lr = json.load(open(p))
            drc = lr.get("board", {}).get("drc", {}).get("violations")
            quote_ready = lr.get("status") == "PASSED"
    return {
        "board": name, "source_run": run_dir, "why_build": why,
        "risk": risk, "recommended_order": order,
        "cost_class": ("blocked" if risk == "blocked" else
                       "prototype-batch (quote-dependent; no number "
                       "invented)"),
        "evidence_gained": evidence,
        "required_review": "human review of the manufacturing package "
                           "(standing requirement)",
        "required_instruments": ["DMM", "bench PSU"]
        + (["oscilloscope"] if "oscilloscope_capture" in evidence else [])
        + (["thermal camera"] if "thermal_image" in evidence else []),
        "pass_fail_criteria": "per fl1-testplan/validation workflow of the "
                              "source run; measurements need name+value+"
                              "units (E8)",
        "claims_unlocked_if_passed": unlocks,
        "claims_still_blocked": ALWAYS_BLOCKED,
        "quote_packet_readiness": ("packet generatable — human "
                                   "APPROVED_FOR_QUOTE pending"
                                   if quote_ready else
                                   "not ready (no PASSED run)" if run_dir
                                   else "blocked upstream"),
        "drc_violations_at_emission": drc,
    }


def campaign():
    rungs = [rung_report(*r) for r in LADDER]
    return {
        "version": "v1",
        "milestone": "C8 First Physical Evidence Campaign Readiness",
        "rungs": rungs,
        "buildable_now": [r["board"] for r in rungs
                          if "generatable" in r["quote_packet_readiness"]],
        "blocked": [r["board"] for r in rungs if r["risk"] == "blocked"],
        "evidence_types": EVIDENCE_TYPES,
        "rules": [
            "nothing is ordered; no quote is submitted; planning only",
            "APPROVED_FOR_QUOTE remains the human unlock (E2/E7)",
            "physical evidence enters ONLY via real files + named-reviewer "
            "acceptance (E1/E8)",
            "the ledger stays empty until then",
            "cost classes are quote-dependent — no invented numbers"],
    }
