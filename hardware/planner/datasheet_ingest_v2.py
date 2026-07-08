"""C2 — Datasheet Evidence Ingestion v2.

Extends M5 (no-provenance-no-claim) with a real evidence pipeline:
28 evidence types, full record schema, a validator, an ingestion adapter,
and a THREE-STATE ladder that support synthesis consumes:

  evidence_verified            human-reviewed, precise source ref
  evidence_candidate_review_required
                               extracted/recalled, pending human review —
                               usable as a SUGGESTION only, zero claims
  placeholder_review_required  nothing — M5 behavior unchanged

Nothing is invented: candidate records carry extraction_method and
human_review_state and can NEVER rise above candidate without a human
setting review_state=verified with a precise source_ref. Unverified
entries never unblock any claim.
"""
import json
import os

import datasheet_evidence as m5

DB_V2_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "datasheet_db_v2.json")

EVIDENCE_TYPES = (
    "recommended_operating_voltage", "absolute_maximum_ratings",
    "power_domains", "boot_strap_requirements", "address_strap_requirements",
    "pullup_pulldown_values", "decoupling_recommendation",
    "bulk_capacitance_recommendation", "crystal_load_capacitors",
    "reset_requirements", "programming_debug_requirements",
    "reference_circuit", "layout_guidance", "exposed_pad_requirements",
    "thermal_pad_via_guidance", "esd_protection_recommendation",
    "analog_input_range", "adc_reference_requirements",
    "current_sense_requirements", "regulator_application_circuit",
    "inductor_capacitor_requirements", "switching_frequency",
    "compensation_requirements", "power_sequencing",
    "backup_battery_requirements", "interface_voltage_requirements",
    "bus_timing_limits", "write_protect_behavior",
)

RECORD_FIELDS = ("component", "manufacturer", "mpn", "datasheet_source",
                 "datasheet_revision", "source_ref", "extracted_statement",
                 "normalized_requirement", "units", "confidence",
                 "extraction_method", "human_review_state",
                 "claim_implications", "blocked_claims_if_missing")

CONFIDENCE = ("high", "medium", "low")
REVIEW_STATES = ("verified", "pending_review", "rejected")
EXTRACTION_METHODS = ("human_entry", "pdf_extraction",
                      "model_recall_pending_verification",
                      "manufacturer_metadata")


def validate_record(rec):
    """Schema + honesty validation. Returns (ok, problems)."""
    problems = []
    for f in ("component", "evidence_type", "normalized_requirement",
              "extraction_method", "human_review_state", "confidence"):
        if not rec.get(f):
            problems.append("missing field: %s" % f)
    if rec.get("evidence_type") not in EVIDENCE_TYPES:
        problems.append("unknown evidence_type %s" % rec.get("evidence_type"))
    if rec.get("confidence") not in CONFIDENCE:
        problems.append("invalid confidence")
    if rec.get("human_review_state") not in REVIEW_STATES:
        problems.append("invalid human_review_state")
    if rec.get("extraction_method") not in EXTRACTION_METHODS:
        problems.append("invalid extraction_method")
    v = rec.get("value")
    if isinstance(v, (int, float)) and not rec.get("units"):
        problems.append("numeric value without units")
    if rec.get("human_review_state") == "verified":
        if not rec.get("source_ref") or "section" not in str(
                rec.get("source_ref", "")).lower() and not any(
                c.isdigit() for c in str(rec.get("source_ref", ""))):
            problems.append("verified evidence requires a PRECISE source_ref "
                            "(page/table/section)")
        if rec.get("extraction_method") == \
                "model_recall_pending_verification":
            problems.append("model recall can never be verified without a "
                            "human changing the extraction record")
    return (len(problems) == 0, problems)


def state_of(rec):
    if rec.get("human_review_state") == "verified":
        return "evidence_verified"
    if rec.get("human_review_state") == "rejected":
        return "placeholder_review_required"
    return "evidence_candidate_review_required"


def load_db():
    if os.path.exists(DB_V2_PATH):
        return json.load(open(DB_V2_PATH))
    return {"records": []}


def ingest(records, db=None):
    """Validate + add records. Invalid records are refused with reasons."""
    db = db or load_db()
    accepted, refused = [], []
    for r in records:
        ok, problems = validate_record(r)
        if ok:
            db["records"].append(r)
            accepted.append(r)
        else:
            refused.append({"record": r.get("component"),
                            "evidence_type": r.get("evidence_type"),
                            "problems": problems})
    return db, accepted, refused


def evidence_for(part, evidence_type=None, db=None):
    db = db or load_db()
    out = [r for r in db["records"] if r["component"] == part
           and (evidence_type is None or r["evidence_type"] == evidence_type)]
    return out


def support_value_v2(part, evidence_type, db=None):
    """The support-synthesis entry point. Verified evidence -> value with
    provenance (still review-required overall, per M5 rules). Candidate ->
    SUGGESTION with zero claims. Missing -> M5 placeholder."""
    recs = evidence_for(part, evidence_type, db)
    verified = [r for r in recs if state_of(r) == "evidence_verified"]
    candidates = [r for r in recs
                  if state_of(r) == "evidence_candidate_review_required"]
    if verified:
        r = verified[0]
        return {"part": part, "evidence_type": evidence_type,
                "value": r.get("value"),
                "normalized_requirement": r["normalized_requirement"],
                "units": r.get("units"),
                "state": "evidence_verified_review_required",
                "provenance": r.get("datasheet_source"),
                "source_ref": r.get("source_ref"),
                "claims_allowed": ["value_selection_basis"],
                "claims_blocked": list(m5.BLOCKED_WITHOUT_EVIDENCE)}
    if candidates:
        r = candidates[0]
        return {"part": part, "evidence_type": evidence_type,
                "value": r.get("value"),
                "normalized_requirement": r["normalized_requirement"],
                "units": r.get("units"),
                "state": "evidence_candidate_review_required",
                "provenance": "%s (UNVERIFIED — %s)" % (
                    r.get("datasheet_source"), r.get("extraction_method")),
                "claims_allowed": [],
                "claims_blocked": list(m5.BLOCKED_WITHOUT_EVIDENCE)
                + ["value_selection_basis (candidate pending human review)"],
                "note": "SUGGESTION ONLY — a human must verify against the "
                        "datasheet before this value carries any basis"}
    return {"part": part, "evidence_type": evidence_type, "value": None,
            "state": "placeholder_review_required", "provenance": "none",
            "claims_allowed": [],
            "claims_blocked": list(m5.BLOCKED_WITHOUT_EVIDENCE)
            + ["value_selection_basis"],
            "note": "no evidence — M5 rule: no provenance, no claim"}


def adapter_from_m5(m5_db):
    """Convert legacy M5 records (part -> key -> {value, source,
    source_ref}) into v2 candidate/verified records."""
    KEY_MAP = {"decoupling_nF": "decoupling_recommendation",
               "bulk_uF": "bulk_capacitance_recommendation",
               "pullup_kohm_range": "pullup_pulldown_values",
               "address_strap_rule": "address_strap_requirements",
               "reset_requirements": "reset_requirements",
               "crystal_load_pF": "crystal_load_capacitors",
               "adc_reference": "adc_reference_requirements",
               "exposed_pad_rule": "exposed_pad_requirements",
               "abs_max_v": "absolute_maximum_ratings"}
    out = []
    for part, keys in (m5_db or {}).items():
        for k, rec in keys.items():
            et = KEY_MAP.get(k)
            if not et or rec.get("value") is None:
                continue
            out.append({
                "component": part, "evidence_type": et,
                "value": rec["value"], "units": rec.get("units"),
                "normalized_requirement": "%s = %s %s" % (
                    k, rec["value"], rec.get("units") or ""),
                "datasheet_source": rec.get("source"),
                "source_ref": rec.get("source_ref"),
                "extraction_method": "human_entry",
                "human_review_state": "pending_review",
                "confidence": "medium",
                "claim_implications": ["value_selection_basis after review"],
                "blocked_claims_if_missing": list(
                    m5.BLOCKED_WITHOUT_EVIDENCE)})
    return out


def part_report(part, db=None):
    db = db or load_db()
    recs = evidence_for(part, None, db)
    by_state = {}
    for r in recs:
        by_state.setdefault(state_of(r), []).append(r["evidence_type"])
    return {"part": part, "records": len(recs), "by_state": by_state,
            "missing_visible": "every evidence_type not present stays a "
                               "review-required placeholder",
            "rule": "unverified candidates carry zero claims; verified "
                    "evidence is still review-required overall"}
