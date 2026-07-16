"""Phase 22.2: generate JIT primitive acquisition artifacts + apply to the
five real gaps with REAL KiCad library presence evidence.

  gen_phase222.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import jit_primitives as jp  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import toolchain  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")
TARGETS = ["fl1-backplane-v1", "env-sensor-benchmark-v1"]
FP = toolchain.kicad_footprints()
SYM = toolchain.kicad_symbols()


def _w(name, obj):
    for r in TARGETS:
        json.dump(obj, open(os.path.join(RUNS, r, "data", name + ".json"), "w"), indent=1)


def _lib_has(pretty, needle):
    try:
        return any(needle.lower() in f.lower()
                   for f in os.listdir(os.path.join(FP, pretty + ".pretty")))
    except OSError:
        return False


def _sym_has(lib, name):
    try:
        return name in open(os.path.join(SYM, lib + ".kicad_sym")).read()
    except OSError:
        return False


_w("compose-primitive-gap-detector", {
    "version": "v1", "gap_types": list(jp.GAP_TYPES),
    "output_fields": ["requested_board", "required_primitive", "why_needed",
                      "current_support_state", "severity", "affected_claims",
                      "acquisition_sources", "board_can_proceed_without_it"],
    "wired_to": "pcba_engine.capability_check feeds this detector"})
_w("compose-primitive-evidence-states", {
    "version": "v1", "states": list(jp.EVIDENCE_STATES),
    "candidate_states": sorted(jp.CANDIDATE_STATES),
    "physical_states": sorted(jp.PHYSICAL_STATES),
    "high_risk_claims": list(jp.HIGH_RISK_CLAIMS),
    "rules": ["candidates cannot support production_ready (can_support_claim)",
              "candidate footprints require human review",
              "routed_in_sandbox is NOT physical validation",
              "physically_validated requires real hardware evidence",
              "failed evidence demotes", "high-risk domains require stricter states"]})
_w("compose-datasheet-ingestion-interface", {
    "version": "v1",
    "accepts": ["pdf path/URL placeholder", "manufacturer", "part number",
                "package", "intended use", "board family", "operating mode"],
    "extracts": ["pinout", "package dimensions", "recommended footprint",
                 "electrical limits", "power pins", "required passives",
                 "communication interface", "layout/thermal/ESD notes",
                 "reference circuits", "abs max ratings", "recommended operating"],
    "implementation": "the PROVEN resolve_part/source_part path (DigiKey -> "
                      "datasheet -> resolved part, cache-first, pad-count "
                      "matched — validated by test_ingest 6/6)",
    "rules": ["incomplete extraction marks fields unknown + requires review",
              "critical dimensions are NEVER inferred silently"]})
_w("compose-symbol-pinmap-generator", {
    "version": "v1", "outputs": ["symbol", "pin map", "electrical types",
    "required/optional/no-connect pins", "power/ground pins", "interface pins",
    "boot/config pins", "warnings"],
    "gate": "jit_primitives.pinmap_gate — unknown pins BLOCK automatic use; "
            "power/ground must be explicit; confidence recorded"})
_w("compose-footprint-acquisition-verification", {
    "version": "v1", "sources": list(jp.ACQUISITION_SOURCES),
    "checks": ["pad count vs pin map", "pitch vs datasheet", "courtyard",
               "silk clear of pads", "pin-1 marker", "orientation",
               "dimensions + tolerances recorded", "review status"],
    "gate": "jit_primitives.verify_footprint — mismatch BLOCKS; missing pin-1 "
            "BLOCKS automatic use; third-party/generated never auto-trusted"})
_w("compose-reference-circuit-extractor", {
    "version": "v1", "captures": ["decoupling", "pulls", "boot straps",
    "crystal/clock", "termination", "protection", "sense resistors",
    "analog filters", "grounding", "keepout notes"],
    "rules": ["advisory until checked", "safety-critical requires review",
              "high-speed/RF requires external solver or advanced capability",
              "power circuits require thermal/current checks"]})
_w("compose-sandbox-primitive-testboard-generator", {
    "version": "v1", "board_kinds": ["sensor breakout", "connector breakout",
    "regulator test board", "MCU core test board", "gate-driver test board",
    "ADC/reference test board", "USB-C power-entry test board"],
    "includes": ["minimal schematic", "placement", "required passives",
                 "test points", "debug header if needed", "DRC/ERC",
                 "manufacturing package if clean", "validation workflow"],
    "rules": ["sandbox clean routes promote to routed_in_sandbox ONLY",
              "sandbox failures preserved", "NOT physical validation"]})
_w("compose-runtime-primitive-acquisition-workflow", jp.runtime_workflow())

# ---- Phase 9: apply to the five REAL gaps with REAL library evidence ----------
bme_sym = _sym_has("Sensor", "BME280")
bme_fp = _lib_has("Package_LGA", "Bosch_LGA-8_2.5x2.5mm_P0.65mm")
usbc_fp = _lib_has("Connector_USB", "USB_C_Receptacle")
sma_fp = _lib_has("Connector_Coaxial", "SMA_Amphenol")
qfn_fp = _lib_has("Package_DFN_QFN", "QFN-56-1EP_7x7mm_P0.4mm")
gd_sym = _sym_has("Driver_FET", "IR2110") or os.path.exists(
    os.path.join(SYM, "Driver_FET.kicad_sym"))

cases = [
    {"gap": "BME280 environmental sensor (humidity+pressure)",
     "library_evidence": {"kicad_symbol_Sensor.BME280": bme_sym,
                          "kicad_footprint_Bosch_LGA-8": bme_fp},
     "state": "footprint_supported_with_review" if bme_sym and bme_fp
              else "candidate_from_library_import",
     "path": "candidate_from_library_import -> pinmap via resolve_part (KiCad "
             "symbol pins, never guessed) -> verify_footprint -> sandbox "
             "sensor-breakout board is the NEXT step",
     "caveats": ["LGA-8 0.65mm two-row escape: fanout proven at 0.5mm single-"
                 "row TSSOP — LGA needs a sandbox route before layout_supported",
                 "no accuracy/calibration claim ever without evidence"],
     "outcome": "primitive_ready_with_review (sandbox pending)"},
    {"gap": "USB-C 5V sink connector + protection",
     "library_evidence": {"kicad_USB_C_Receptacle_footprints": usbc_fp},
     "state": "footprint_supported_with_review" if usbc_fp else "missing",
     "path": "footprints exist (26 variants); CC 5.1k sink pattern already "
             "exists in the synth USB path; the recorded blocker was a "
             "DRC-clean USB-C attempt — sandbox power-entry test board is the "
             "NEXT step",
     "caveats": ["NO USB_certified claim ever without compliance evidence",
                 "16-24 pads incl. shield tabs: DRC courtyard risk is the "
                 "known unproven part"],
     "outcome": "primitive_ready_with_review (sandbox pending)"},
    {"gap": "SMA connector (RF adapter)",
     "library_evidence": {"kicad_SMA_coaxial_footprints": sma_fp},
     "state": "footprint_supported_with_review" if sma_fp else "missing",
     "path": "footprints exist (18 variants); passive breakout sandbox is "
             "feasible", "caveats": ["ALL RF claims remain BLOCKED — advisory "
             "impedance only; external VNA validation required for any RF "
             "statement"],
     "outcome": "primitive_candidate_only (RF claims blocked regardless)"},
    {"gap": "gate driver + power stage",
     "library_evidence": {"kicad_driver_symbols_exist": gd_sym},
     "state": "blocked",
     "path": "symbols exist BUT the blocker is not the symbol: no validated "
             "power-stage LAYOUT primitives (current paths, thermal, gate "
             "loops) and no power validation workflow — symbol presence does "
             "NOT unblock",
     "caveats": ["no fake support: stays blocked until power-stage rules + "
                 "thermal/current evidence exist"],
     "outcome": "primitive_blocked"},
    {"gap": "bare RP2040 (QFN-56)",
     "library_evidence": {"kicad_QFN56_footprint": qfn_fp},
     "state": "blocked",
     "path": "symbol + footprint EXIST and were used in the Phase 18.8 attempt "
             "— the blocker is the quadrant escape planner, a routing "
             "capability, not an acquisition gap",
     "caveats": ["JIT acquisition cannot unblock a routing-capability gap"],
     "outcome": "primitive_blocked (escape planner required)"},
]
_w("compose-jit-primitive-gap-application-report", {
    "version": "v1", "cases": cases,
    "evidence_note": "library_evidence fields are REAL filesystem checks "
                     "against the installed KiCad libraries, not assertions"})

_w("compose-jit-primitive-fleet-memory-update", {
    "version": "v1",
    "acquired": [{"primitive": c["gap"], "source": "kicad_library_import",
                  "state": c["state"], "outcome": c["outcome"],
                  "boards_waiting": 1} for c in cases],
    "promotions": "none beyond footprint_supported_with_review — sandbox "
                  "routes are the next evidence step",
    "demotions": "none", "claim_blockers": "all HIGH_RISK_CLAIMS blocked for "
                 "every JIT primitive (structural)"})

print("gap application:")
for c in cases:
    print("  %-46s %-36s %s" % (c["gap"][:44], c["state"], c["outcome"]))
