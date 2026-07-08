"""C2 regression: datasheet evidence ingestion v2."""
import json
import os
import sys

import datasheet_ingest_v2 as dv2
import datasheet_evidence as m5

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui", "public",
                 "runs", "fl1-backplane-v1", "data")


def art(name):
    p = os.path.join(D, name + ".json")
    return json.load(open(p)) if os.path.exists(p) else None


check("1 28 evidence types, 14 record fields",
      len(dv2.EVIDENCE_TYPES) == 28 and len(dv2.RECORD_FIELDS) == 14)

db = dv2.load_db()
check("2 seed DB loads with candidate records",
      len(db["records"]) >= 15
      and all(r["human_review_state"] == "pending_review"
              for r in db["records"]))
check("3 no fabricated source refs in seed (source_ref is None until a "
      "human verifies)",
      all(r.get("source_ref") is None for r in db["records"]))

# validator honesty
ok1, p1 = dv2.validate_record({"component": "X", "evidence_type": "nope",
                               "normalized_requirement": "r",
                               "extraction_method": "human_entry",
                               "human_review_state": "pending_review",
                               "confidence": "high"})
check("4 unknown evidence type refused", not ok1)
ok2, p2 = dv2.validate_record({"component": "X",
                               "evidence_type": "decoupling_recommendation",
                               "normalized_requirement": "100nF", "value": 100,
                               "extraction_method": "human_entry",
                               "human_review_state": "pending_review",
                               "confidence": "high"})
check("5 numeric value without units refused",
      not ok2 and any("units" in x for x in p2))
ok3, p3 = dv2.validate_record({
    "component": "X", "evidence_type": "decoupling_recommendation",
    "normalized_requirement": "100nF", "value": 100, "units": "nF",
    "extraction_method": "model_recall_pending_verification",
    "human_review_state": "verified", "confidence": "high",
    "source_ref": "section 5.2 table 3"})
check("6 model recall can NEVER self-verify",
      not ok3 and any("never be verified" in x for x in p3))

# state ladder
sv = dv2.support_value_v2("BME280", "recommended_operating_voltage", db)
check("7 candidate value is a SUGGESTION with zero claims",
      sv["state"] == "evidence_candidate_review_required"
      and sv["claims_allowed"] == []
      and "UNVERIFIED" in sv["provenance"])
missing = dv2.support_value_v2("GENERIC_BUCK",
                               "regulator_application_circuit", db)
check("8 regulator application circuit: no evidence -> blocked placeholder",
      missing["state"] == "placeholder_review_required"
      and "value_selection_basis" in str(missing["claims_blocked"]))

# verified path (human-entered with precise ref)
vdb = {"records": []}
vdb, acc, ref = dv2.ingest([{
    "component": "TESTPART", "evidence_type": "decoupling_recommendation",
    "normalized_requirement": "100 nF at VDD", "value": 100, "units": "nF",
    "datasheet_source": "TESTPART datasheet r1.2",
    "source_ref": "section 7.1, table 12",
    "extraction_method": "human_entry", "human_review_state": "verified",
    "confidence": "high"}], vdb)
vv = dv2.support_value_v2("TESTPART", "decoupling_recommendation", vdb)
check("9 verified evidence carries provenance, allows value_selection_basis "
      "ONLY, still review-required",
      vv["state"] == "evidence_verified_review_required"
      and vv["claims_allowed"] == ["value_selection_basis"]
      and "calibrated_performance" in vv["claims_blocked"])

# M5 adapter + M5 unbroken
recs = dv2.adapter_from_m5({"PARTX": {"decoupling_nF": {
    "value": 100, "units": "nF", "source": "datasheet_pdf",
    "source_ref": "p. 33"}}})
check("10 M5 adapter converts legacy records to v2 pending-review",
      len(recs) == 1 and recs[0]["human_review_state"] == "pending_review")
check("11 M5 behavior unchanged (placeholder w/ no claim)",
      m5.support_value("NOPART", "decoupling_nF")["state"]
      == "review_required_placeholder")

bench = art("datasheet-evidence-benchmark-report")
check("12 benchmarks: 8 parts, all honest (candidate/placeholder only)",
      len(bench["benchmarks"]) == 8
      and all(b["all_candidate_or_placeholder"]
              for b in bench["benchmarks"].values()))
rep = art("datasheet-evidence-ingestion-v2")
check("13 report rules: nothing invented, candidates carry zero claims",
      any("invented" in r for r in rep["rules"])
      and any("zero claims" in r for r in rep["rules"]))

npass = sum(1 for ok in checks if ok)
print("%d/%d C2 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
