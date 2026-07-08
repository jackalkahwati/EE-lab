"""M5 — Datasheet-Driven Support Circuit Synthesis v1.

Provenance for every support-circuit value. Values come from a trusted
evidence DB (datasheet_db.json, human-curated) or they are REVIEW-REQUIRED
placeholders that say so. No provenance -> no claim. Nothing is invented.
"""
import json
import os

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "datasheet_db.json")

SOURCE_TYPES = ("datasheet_pdf", "manufacturer_metadata", "trusted_library",
                "human_review", "none")

SUPPORT_KEYS = ("decoupling_nF", "bulk_uF", "pullup_kohm_range",
                "address_strap_rule", "reset_requirements",
                "crystal_load_pF", "regulator_cin_uF", "regulator_cout_uF",
                "adc_reference", "exposed_pad_rule", "abs_max_v")

BLOCKED_WITHOUT_EVIDENCE = ("calibrated_performance", "timing_correctness",
                            "clock_performance", "sensor_accuracy",
                            "thermal_reliability", "compliance")


def _db():
    if os.path.exists(DB_PATH):
        return json.load(open(DB_PATH))
    return {}


def support_value(part, key, db=None):
    """Evidence-derived value or an honest placeholder. Every return carries
    provenance; a placeholder can never upgrade a claim."""
    db = _db() if db is None else db
    rec = (db.get(part) or {}).get(key)
    if rec and rec.get("source") in SOURCE_TYPES and rec.get("source") != "none" \
            and rec.get("value") is not None and rec.get("source_ref"):
        return {"key": key, "value": rec["value"],
                "units": rec.get("units"),
                "provenance": rec["source"],
                "source_ref": rec["source_ref"],
                "state": "evidence_derived_review_required",
                "claims_allowed": ["value_selection_basis"],
                "claims_blocked": list(BLOCKED_WITHOUT_EVIDENCE)}
    return {"key": key, "value": None, "units": None,
            "provenance": "none",
            "state": "review_required_placeholder",
            "claims_allowed": [],
            "claims_blocked": list(BLOCKED_WITHOUT_EVIDENCE) +
                              ["value_selection_basis"]}


def provenance_report(part, keys=SUPPORT_KEYS, db=None):
    vals = [support_value(part, k, db=db) for k in keys]
    n_ev = sum(1 for v in vals if v["provenance"] != "none")
    return {"part": part, "values": vals,
            "evidence_derived": n_ev, "placeholders": len(vals) - n_ev,
            "rule": "no provenance -> no claim; placeholders stay "
                    "review-required; nothing invented"}
