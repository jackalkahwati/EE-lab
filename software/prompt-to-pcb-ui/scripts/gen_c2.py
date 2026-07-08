"""C2: datasheet evidence ingestion v2 — seed candidate DB + benchmarks.

Seed records are CANDIDATES (extraction_method:
model_recall_pending_verification, human_review_state: pending_review).
No page/table numbers are fabricated; source_ref names the datasheet
family only. Candidates are suggestions with ZERO claims until a human
verifies them against the actual document.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import datasheet_ingest_v2 as dv2  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")


def cand(component, et, req, value=None, units=None, mfr=None, mpn=None,
         confidence="medium"):
    return {"component": component, "manufacturer": mfr, "mpn": mpn,
            "evidence_type": et, "value": value, "units": units,
            "normalized_requirement": req,
            "datasheet_source": "%s datasheet (revision unverified)"
                                % (mpn or component),
            "datasheet_revision": "unverified", "source_ref": None,
            "extracted_statement": None,
            "extraction_method": "model_recall_pending_verification",
            "human_review_state": "pending_review",
            "confidence": confidence,
            "claim_implications": ["value_selection_basis ONLY after human "
                                   "review"],
            "blocked_claims_if_missing": ["calibrated_performance",
                                          "timing_correctness"]}


SEED = [
    # BME280
    cand("BME280", "recommended_operating_voltage",
         "VDD 1.71-3.6 V; VDDIO 1.2-3.6 V", mfr="Bosch", mpn="BME280"),
    cand("BME280", "address_strap_requirements",
         "I2C address 0x76 (SDO low) / 0x77 (SDO high); SDO must not float",
         mfr="Bosch", mpn="BME280"),
    cand("BME280", "decoupling_recommendation",
         "100 nF decoupling at VDD and VDDIO", value=100, units="nF",
         mfr="Bosch", mpn="BME280"),
    # PCF8574
    cand("PCF8574", "address_strap_requirements",
         "A0-A2 straps select address 0x20-0x27 (PCF8574A: 0x38-0x3F)",
         mfr="NXP/TI", mpn="PCF8574"),
    cand("PCF8574", "pullup_pulldown_values",
         "I2C SDA/SCL require external pull-ups; quasi-bidirectional IO "
         "needs no port pull-ups", mfr="NXP/TI", mpn="PCF8574"),
    # 24LC02
    cand("24LC02", "address_strap_requirements",
         "A0-A2 are NOT decoded on 24LC02 (fixed address 0x50); pins may "
         "tie to VSS", mfr="Microchip", mpn="24LC02B"),
    cand("24LC02", "write_protect_behavior",
         "WP high write-protects the array; tie to VSS for normal writes",
         mfr="Microchip", mpn="24LC02B"),
    # ADS1115
    cand("ADS1115", "recommended_operating_voltage",
         "VDD 2.0-5.5 V", mfr="TI", mpn="ADS1115"),
    cand("ADS1115", "analog_input_range",
         "analog inputs must stay within GND-0.3 V to VDD+0.3 V; PGA "
         "full-scale settings do not extend beyond supply", mfr="TI",
         mpn="ADS1115"),
    cand("ADS1115", "adc_reference_requirements",
         "internal reference; no external reference pin", mfr="TI",
         mpn="ADS1115"),
    # TXB0102
    cand("TXB0102", "interface_voltage_requirements",
         "VCCA must be less than or equal to VCCB; VCCA 1.2-3.6 V, "
         "VCCB 1.65-5.5 V", mfr="TI", mpn="TXB0102"),
    cand("TXB0102", "power_sequencing",
         "OE should be held low during power-up until both rails are "
         "stable (outputs disabled)", mfr="TI", mpn="TXB0102"),
    # DS3231M
    cand("DS3231M", "backup_battery_requirements",
         "VBAT 2.3-5.5 V; battery backup maintains timekeeping when VCC "
         "is absent", mfr="Analog Devices/Maxim", mpn="DS3231M"),
    # RP2040
    cand("RP2040", "boot_strap_requirements",
         "boots from external QSPI flash; USB_BOOT/QSPI_SS strapping "
         "selects BOOTSEL", mfr="Raspberry Pi", mpn="RP2040"),
    cand("RP2040", "crystal_load_capacitors",
         "12 MHz crystal typical; load capacitors per crystal spec "
         "(commonly ~15-33 pF class)", mfr="Raspberry Pi", mpn="RP2040"),
    cand("RP2040", "power_domains",
         "DVDD 1.1 V core from internal LDO; IOVDD 1.8-3.3 V; "
         "USB PHY VDD 3.3 V", mfr="Raspberry Pi", mpn="RP2040"),
    cand("RP2040", "programming_debug_requirements",
         "SWD (SWCLK/SWDIO) two-wire debug", mfr="Raspberry Pi",
         mpn="RP2040"),
]

db = {"records": []}
db, accepted, refused = dv2.ingest(SEED, db)
json.dump(db, open(dv2.DB_V2_PATH, "w"), indent=1)

# benchmarks — the 8 parts from the plan
BENCH = {
    "BME280": ["recommended_operating_voltage", "decoupling_recommendation",
               "address_strap_requirements"],
    "PCF8574": ["address_strap_requirements", "pullup_pulldown_values"],
    "24LC02": ["address_strap_requirements", "write_protect_behavior"],
    "ADS1115": ["analog_input_range", "adc_reference_requirements"],
    "TXB0102": ["interface_voltage_requirements", "power_sequencing"],
    "DS3231M": ["backup_battery_requirements"],
    "RP2040": ["boot_strap_requirements", "crystal_load_capacitors",
               "power_domains", "programming_debug_requirements"],
    "GENERIC_BUCK": ["regulator_application_circuit"],
}
bench = {}
for part, ets in BENCH.items():
    vals = {et: dv2.support_value_v2(part, et, db) for et in ets}
    bench[part] = {
        "values": vals,
        "report": dv2.part_report(part, db),
        "all_candidate_or_placeholder": all(
            v["state"] in ("evidence_candidate_review_required",
                           "placeholder_review_required")
            for v in vals.values()),
    }

report = {
    "version": "v2", "milestone": "C2 Datasheet Evidence Ingestion",
    "evidence_types": len(dv2.EVIDENCE_TYPES),
    "record_fields": list(dv2.RECORD_FIELDS),
    "state_ladder": ["evidence_verified (human-reviewed, precise ref)",
                     "evidence_candidate_review_required (zero claims)",
                     "placeholder_review_required (M5 unchanged)"],
    "seeded_candidates": len(accepted), "refused": refused,
    "rules": [
        "no datasheet facts invented: seed entries are candidates with "
        "extraction_method model_recall_pending_verification and NO "
        "fabricated page/table refs",
        "candidates are suggestions with zero claims",
        "verified requires a human + precise source_ref; model recall can "
        "never self-verify (validator enforces)",
        "missing evidence stays a visible review-required placeholder",
        "regulator application circuit has NO evidence -> blocked",
    ],
    "benchmarks": {p: {"records": b["report"]["records"],
                       "by_state": b["report"]["by_state"],
                       "honest": b["all_candidate_or_placeholder"]}
                   for p, b in bench.items()},
}

md = "# C2 — Datasheet Evidence Ingestion v2\n\n" \
     "28 evidence types, full record schema, validator, M5 adapter, and a " \
     "three-state ladder (verified / candidate / placeholder).\n\n" \
     + "\n".join("- " + r for r in report["rules"]) \
     + "\n\n## Benchmarks\n" \
     + "\n".join("- %s: %d record(s), states %s" % (
         p, b["records"], json.dumps(b["by_state"]))
         for p, b in ((p, bench[p]["report"]) for p in BENCH)) + "\n"

for r in ["fl1-backplane-v1", "bare-mcu-qfn56-core-sandbox-v1"]:
    d = os.path.join(RUNS, r, "data")
    json.dump(report, open(os.path.join(
        d, "datasheet-evidence-ingestion-v2.json"), "w"), indent=1)
    open(os.path.join(d, "datasheet-evidence-ingestion-v2.md"), "w").write(md)
    json.dump(db, open(os.path.join(d, "datasheet-evidence-db.json"), "w"),
              indent=1)
    json.dump({"benchmarks": bench}, open(os.path.join(
        d, "datasheet-evidence-benchmark-report.json"), "w"), indent=1)
    open(os.path.join(d, "datasheet-evidence-benchmark-report.md"),
         "w").write(md)

print("C2: %d candidates seeded, %d refused | all benchmarks honest: %s" %
      (len(accepted), len(refused),
       all(b["all_candidate_or_placeholder"] for b in bench.values())))
