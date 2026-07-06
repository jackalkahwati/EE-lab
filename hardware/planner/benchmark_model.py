"""Reference PCBA benchmark model + FL-1 benchmark suite (Phase 13 D).

A benchmark is the honest SPEC of what an FL-1 board class must contain to be
buildable: required blocks, components, nets, protection, calibration hooks, test
points, validation hooks, manufacturing constraints, and the signoff checks that
apply, plus HARD-FAIL rules (a board missing these is do_not_build) and advisory
rules (noted, not fatal). Each benchmark carries a trust/license classification so
we never silently reuse an external reference we are not licensed to reuse.

The scoring engine (benchmark_score.py) compares a generated board package to its
benchmark; it CONSUMES evidence (fine-pitch escape, shared-bus, DRC, ingestion)
and never reinterprets it.
"""
import json

# license / trust classes — reuse is only allowed for internal or licensed refs
TRUST = ("internal_firstlight", "manufacturer_reference_only",
         "open_source_needs_license_review", "licensed_reusable",
         "idea_only", "unknown_untrusted")
REUSABLE_TRUST = ("internal_firstlight", "licensed_reusable")


def _bench(name, board_class, trust, reference_source, **kw):
    reusable = "reusable" if trust in REUSABLE_TRUST else "reference_only"
    b = {
        "name": name,
        "board_class": board_class,
        "reference_source": reference_source,
        "trust": trust,
        "reuse_status": reusable,
        "required_blocks": kw.get("blocks", []),
        "required_components": kw.get("components", []),
        "required_nets": kw.get("nets", []),
        "required_layout_features": kw.get("layout", []),
        "required_protection": kw.get("protection", []),
        "required_calibration_hooks": kw.get("calibration", []),
        "required_test_points": kw.get("test_points", []),
        "required_validation_hooks": kw.get("validation", ["FL-1 validation package"]),
        "required_manufacturing": kw.get("manufacturing", ["standard_4_layer"]),
        "required_signoff_checks": kw.get("signoff", []),
        "hard_fail_rules": kw.get("hard_fail", []),
        "advisory_rules": kw.get("advisory", []),
        "scoring_rules": kw.get("scoring", {"pass_threshold": 0.8, "review_threshold": 0.6}),
        "unsupported_claims_forbidden": kw.get("forbidden", []),
        "provenance": kw.get("provenance", "FirstLight FL-1 program, Phase 13 benchmark v1"),
    }
    assert trust in TRUST
    return b


# ---------------------------------------------------------------------------
# FL-1 benchmark suite — 10 board classes. Requirements are honest to what the
# board IS; hard-fail rules are what makes it do_not_build.
# ---------------------------------------------------------------------------
SUITE = [
    _bench("calibration_reference", "Calibration / reference board", "internal_firstlight",
           "FirstLight ADS1115 measurement path + REF3025 reference + resistor divider",
           blocks=["controller/bus source", "precision voltage reference",
                   "resistor divider (REF_DIV)", "measurement ADC", "board-ID EEPROM",
                   "FL-1 bus connector"],
           components=["voltage_reference", "adc", "memory.eeprom"],
           nets=["REF_OUT", "REF_DIV", "I2C_SDA", "I2C_SCL"],
           layout=["labeled test points on REF_OUT + REF_DIV", "ADC fine-pitch escape"],
           calibration=["known reference node REF_OUT", "divided node REF_DIV",
                        "ADC measures both nodes"],
           test_points=["REF_OUT", "REF_DIV"],
           signoff=["analog", "digital", "manufacturing"],
           hard_fail=["required component not ingested", "calibration path missing",
                      "shared bus disconnected", "fine-pitch escape failed", "DRC/ERC failed"],
           advisory=["metrology traceability is external", "no absolute-accuracy claim"]),

    _bench("digital_bringup", "Digital bring-up board", "internal_firstlight",
           "FirstLight controller + IO expander / header pattern",
           blocks=["MCU/controller", "protected digital IO", "bus header", "status LEDs"],
           components=["mcu"], nets=["I2C_SDA", "I2C_SCL"],
           layout=["header fanout", "test points on key IO"],
           protection=["series resistors / clamps on external IO (advisory)"],
           test_points=["+3V3", "reset"], signoff=["digital", "manufacturing"],
           hard_fail=["MCU not ingested", "DRC/ERC failed", "programming/debug path missing"],
           advisory=["input protection recommended for field IO"]),

    _bench("relay_probe_matrix", "Relay / probe matrix board", "internal_firstlight",
           "FirstLight relay matrix pattern (pattern_backed)",
           blocks=["controller", "shift-register / IO expander", "relay drivers",
                   "relays", "probe headers", "flyback protection"],
           components=["shift_register", "relay"], nets=["SR_LATCH"],
           layout=["relay coil traces widened", "probe header array"],
           protection=["flyback diode per relay coil"],
           test_points=["relay common"], signoff=["digital", "power", "manufacturing"],
           hard_fail=["relay driver missing", "flyback protection missing", "DRC/ERC failed"],
           advisory=["coil current budget"]),

    _bench("power_current_monitor", "Programmable power / current monitor board",
           "internal_firstlight", "FirstLight INA-class monitor + rail pattern",
           blocks=["controller", "current-sense monitor", "shunt", "rail",
                   "protection / eFuse (advisory)"],
           components=["monitor"], nets=["I2C_SDA", "I2C_SCL"],
           layout=["kelvin shunt sense", "wide power traces"],
           protection=["current limit / eFuse (advisory unless part present)"],
           calibration=["shunt value known"], test_points=["rail", "shunt+", "shunt-"],
           signoff=["power", "analog", "manufacturing"],
           hard_fail=["current monitor not ingested", "shunt sense missing", "DRC/ERC failed"],
           advisory=["eFuse recommended", "thermal budget on shunt"]),

    _bench("dmm_lite", "DMM-lite measurement board", "internal_firstlight",
           "FirstLight ADS1115 front end + input divider/protection",
           blocks=["controller/bus", "measurement ADC", "input divider",
                   "input protection", "reference"],
           components=["adc"], nets=["I2C_SDA", "I2C_SCL"],
           layout=["input divider", "analog quiet zone", "ADC fine-pitch escape"],
           protection=["input clamp / series R (advisory)"],
           calibration=["reference available"], test_points=["VIN", "VSENSE"],
           signoff=["analog", "digital", "manufacturing"],
           hard_fail=["ADC not ingested", "fine-pitch escape failed", "DRC/ERC failed"],
           advisory=["NO 6.5-digit precision claim", "input protection recommended"],
           forbidden=["6.5-digit precision", "guaranteed absolute accuracy"]),

    _bench("external_instrument_interface", "External instrument interface board",
           "internal_firstlight", "FirstLight buffered IO / level-shift pattern",
           blocks=["controller", "buffered/level-shifted IO", "connectors", "protection"],
           components=["mcu"], nets=[], layout=["connector fanout"],
           protection=["ESD / series protection on external lines"],
           test_points=["IO"], signoff=["digital", "manufacturing"],
           hard_fail=["connector/level-shift missing", "DRC/ERC failed"],
           advisory=["protection required for external connections"]),

    _bench("stimulus_funcgen_lite", "Stimulus / function-generator-lite starter",
           "manufacturer_reference_only", "DAC eval reference (reference-only, needs ingestion)",
           blocks=["controller", "DAC / output path", "output buffer", "output protection"],
           components=["dac"], nets=[], layout=["output stage"],
           protection=["output clamp"], test_points=["OUT"],
           signoff=["analog", "manufacturing"],
           hard_fail=["DAC / output path not ingested", "DRC/ERC failed"],
           advisory=["NO function-generator-class quality claim"],
           forbidden=["function-generator-class performance", "arbitrary waveform guarantee"]),

    _bench("logic_capture", "Logic capture starter", "internal_firstlight",
           "FirstLight buffered digital capture (needs timing simulation)",
           blocks=["controller", "buffered digital inputs", "sample buffer"],
           components=["mcu"], nets=[], layout=["input buffer"],
           protection=["series R on inputs"], test_points=["CH0"],
           signoff=["digital", "manufacturing"],
           hard_fail=["input buffer missing", "DRC/ERC failed"],
           advisory=["NO logic-analyzer-class timing claim", "needs timing simulation"],
           forbidden=["logic-analyzer-class timing", "guaranteed sample-rate/skew"]),

    _bench("scope_lite", "Scope-lite starter", "idea_only",
           "no validated FirstLight reference — unsupported",
           blocks=["fast ADC", "analog front end", "clocking", "capture memory"],
           components=["fast_adc", "afe"], nets=[],
           layout=["controlled analog front end", "clock distribution"],
           signoff=["analog", "high_speed", "manufacturing"],
           hard_fail=["fast ADC not ingested", "analog front end absent",
                      "clocking absent", "capture path absent"],
           advisory=["UNSUPPORTED: no oscilloscope-class bandwidth/ENOB/sample-rate"],
           forbidden=["oscilloscope-class bandwidth", "oscilloscope-class ENOB",
                      "oscilloscope-class sample-rate"]),

    _bench("rf_50ohm_interface", "RF / 50 ohm interface board", "manufacturer_reference_only",
           "50 ohm microstrip estimate (IPC-2141), no S-parameters",
           blocks=["SMA/BNC connector", "50 ohm microstrip", "ground stitching", "RF keepout"],
           components=[], nets=["RF"],
           layout=["50 ohm microstrip estimate", "ground stitching", "RF keepout"],
           test_points=[], signoff=["rf_50ohm", "high_speed", "manufacturing"],
           hard_fail=["connector missing", "DRC/ERC failed"],
           advisory=["50 ohm is an ESTIMATE (IPC-2141), no S-parameters, no tuning",
                     "controlled-impedance stackup + board-house quote required for a guarantee"],
           forbidden=["guaranteed impedance", "measured S-parameters", "RF performance guarantee"]),
]


def benchmark_model():
    """The reference PCBA benchmark model (structure + trust vocabulary)."""
    return {
        "version": "v1",
        "trust_classes": list(TRUST),
        "reusable_trust_classes": list(REUSABLE_TRUST),
        "benchmark_fields": ["required_blocks", "required_components", "required_nets",
                             "required_layout_features", "required_protection",
                             "required_calibration_hooks", "required_test_points",
                             "required_validation_hooks", "required_manufacturing",
                             "required_signoff_checks", "hard_fail_rules", "advisory_rules",
                             "scoring_rules", "unsupported_claims_forbidden", "provenance"],
        "reuse_policy": "external reference designs are NOT directly reused unless trust is "
                        "internal_firstlight or licensed_reusable",
    }


def fl1_suite():
    return {"version": "v1", "benchmark_count": len(SUITE), "benchmarks": SUITE}


def get(name):
    for b in SUITE:
        if b["name"] == name:
            return b
    return None


def to_markdown_suite():
    lines = ["# FL-1 reference benchmark suite", "",
             "Version v1 - %d board benchmarks." % len(SUITE), ""]
    for b in SUITE:
        lines.append("## %s (%s)" % (b["name"], b["board_class"]))
        lines.append("- trust: %s (%s) - source: %s" % (b["trust"], b["reuse_status"],
                     b["reference_source"]))
        lines.append("- required blocks: %s" % ", ".join(b["required_blocks"]))
        lines.append("- required components: %s" % ", ".join(b["required_components"]))
        if b["required_nets"]:
            lines.append("- required nets: %s" % ", ".join(b["required_nets"]))
        lines.append("- hard-fail rules: %s" % "; ".join(b["hard_fail_rules"]))
        if b["unsupported_claims_forbidden"]:
            lines.append("- forbidden claims: %s" % "; ".join(b["unsupported_claims_forbidden"]))
        lines.append("")
    return "\n".join(lines)


if __name__ == "__main__":
    print(json.dumps(fl1_suite(), indent=1))
