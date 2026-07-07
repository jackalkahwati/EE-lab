"""Calibration state model, measurement uncertainty / claim policy, and Batch 1
calibration/verification workflows (Phase 16 B).

The rail: NO precision claim without physical calibration evidence. Mock
calibration is never physical calibration. Every claim a capability is allowed to
make is enumerated; everything else is forbidden by default.
"""

CAL_STATES = ("not_calibratable", "uncalibrated", "mock_calibrated", "sanity_checked",
              "cots_verified", "internally_calibrated", "externally_calibrated",
              "expired", "invalid")

CONFIDENCE = ("unverified", "simulated_only", "sanity_checked",
              "calibrated_low_confidence", "calibrated_medium_confidence",
              "calibrated_high_confidence", "reference_grade", "unsupported")


def calibration_state_model():
    return {
        "version": "v1",
        "channel_fields": ["board_serial", "board_type", "board_revision", "channel_id",
                           "capability", "calibration_state", "calibration_method",
                           "calibration_source", "reference_instrument",
                           "reference_standard", "calibration_date",
                           "calibration_operator_or_adapter", "calibration_environment",
                           "raw_measurements", "correction_coefficients", "offset",
                           "gain", "linearity", "repeatability", "estimated_uncertainty",
                           "valid_range", "expiration_date", "evidence_uri", "limitations"],
        "states": list(CAL_STATES),
        "rules": ["mock_calibrated is NEVER physical calibration",
                  "sanity_checked is NOT precision calibration",
                  "cots_verified requires the external instrument's identity",
                  "internally_calibrated requires an internal FL-1 board that EXISTS "
                  "and holds valid calibration (none exists yet)",
                  "externally_calibrated requires documented external reference evidence",
                  "no precision claim without physical calibration evidence",
                  "expired/invalid calibration blocks precision claims until renewed"],
    }


def uncertainty_policy():
    """Per-capability claim policy: what may be claimed at each confidence level."""
    def cap(name, allowed, forbidden, note=None):
        return {"capability": name,
                "fields": ["nominal_range", "measured_range", "resolution",
                           "repeatability", "offset_correction", "gain_correction",
                           "estimated_uncertainty", "external_reference_used",
                           "temperature_condition", "confidence_level",
                           "validity_period"],
                "allowed_claims": allowed, "forbidden_claims": forbidden, "note": note}

    return {
        "version": "v1", "confidence_levels": list(CONFIDENCE),
        "claim_rules": [
            "no 'precision' claim without calibration evidence",
            "no 'DMM-like accuracy' without DMM-lite calibration evidence",
            "no '6.5 digit' claim unless explicitly proven",
            "no oscilloscope-class claim without measured bandwidth/timing/calibration evidence",
            "no function-generator-class claim without measured amplitude/frequency/distortion",
            "no logic-analyzer-class timing claim without measured timing evidence",
            "no RF accuracy claim without external RF measurement",
            "no traceability claim without an evidence chain"],
        "capabilities": [
            cap("measure_voltage",
                ["functional voltage reading (uncalibrated)",
                 "sanity-checked range once bring-up passes"],
                ["precision", "DMM-like accuracy", "absolute accuracy %"],
                "COTS DMM verification can raise confidence with instrument identity"),
            cap("measure_current",
                ["functional current reading (uncalibrated)"],
                ["precision", "shunt-accuracy claims without calibrated shunt value"]),
            cap("measure_continuity",
                ["continuity/no-continuity (threshold advisory)"],
                ["contact-resistance accuracy without calibrated 4-wire measurement"]),
            cap("route_channel",
                ["channel routes/disconnects (verified by continuity)"],
                ["low-leakage switching", "high-voltage isolation", "RF switching"]),
            cap("capture_waveform",
                [], ["oscilloscope-class bandwidth/ENOB/sample-rate"],
                "unsupported internally; external scope evidence only"),
            cap("generate_signal",
                ["mock/COTS setpoint applied"],
                ["function-generator-class amplitude/frequency/distortion"]),
            cap("capture_logic",
                ["digital level read"],
                ["logic-analyzer-class timing/skew/sample-rate"]),
            cap("verify_reference",
                ["reference within advisory window (sanity)"],
                ["metrology traceability without an external calibrated reference chain"]),
        ],
    }


# ---- Batch 1 calibration / verification workflows (Phase 8) -----------------
def batch1_cal_workflows():
    return {"version": "v1", "workflows": [
        {"board_type": "controller_backplane",
         "kind": "verification (NOT calibration)",
         "steps": ["interlock line sanity (assert/deassert observed)",
                   "fault line sanity", "reset line sanity", "trigger line sanity",
                   "I2C bus enumeration (board-ID answers at 0x50)"],
         "claims": {"allowed": ["lines function"],
                    "forbidden": ["timing precision (unmeasured)"]},
         "resulting_state": "sanity_checked (never higher without measurement)"},
        {"board_type": "digital_bringup",
         "kind": "verification (NOT calibration)",
         "steps": ["IO voltage-level sanity (3V3 domain)", "UART loopback",
                   "I2C loopback", "SPI loopback", "GPIO bank walk",
                   "protected-IO series-R sanity"],
         "claims": {"allowed": ["interfaces function at 3V3"],
                    "forbidden": ["universal programmer support", "exact timing (unmeasured)"]},
         "resulting_state": "sanity_checked"},
        {"board_type": "relay_probe_matrix",
         "kind": "verification (+ optional COTS continuity)",
         "steps": ["relays default OFF at power-up (SR_OE gate)",
                   "SR_OE enable behavior", "route/disconnect each channel",
                   "continuity through each routed channel",
                   "open/closed resistance IF a COTS DMM is attached (instrument identity recorded)",
                   "safe disconnect all", "stuck-relay detection sweep"],
         "claims": {"allowed": ["channels route/disconnect", "safe default verified"],
                    "forbidden": ["precision/low-leakage switching (unmeasured)",
                                  "high-voltage isolation (spacing/ratings unverified)"]},
         "resulting_state": "sanity_checked, or cots_verified for continuity with a "
                            "recorded COTS DMM identity"},
    ]}
