"""Phase 18.8 — Full-16 monolithic no-Pico FL-1 integration stress test model.

All verdicts trace to the three REAL compose attempts (fl1-core6-mono-pico,
fl1-core6-mono-bare, fl1-full16-mono-bare). Hard blockers dominate. This is a
stress test, not a product decision: the six modular plugin boards remain the
valid, review-required first articles.
"""

TREATMENTS = ("implemented_now", "implemented_reduced_scope",
              "external_cots_interface_only", "reserved_zone_only",
              "architecture_only", "blocked")

# The canonical Full-16 function map with the monolithic treatment each function
# received in the Candidate D attempt. Grounded in what is actually on the
# composed boards vs. what the evidence system forbids claiming.
FUNCTIONS = [
    (1, "Controller / Backplane", "implemented_now",
     "CAN link + FAULT/INTERLOCK/RST_OUT/TRIG + identity + bus header on copper",
     None),
    (2, "Digital Bring-up", "implemented_now",
     "UART + I2C + SPI + protected GPIO bank on copper", None),
    (3, "Relay / Probe Matrix", "implemented_now",
     "4-relay matrix, SR_OE safe default, channel map (proven pattern)", None),
    (4, "Calibration / Reference", "implemented_now",
     "REF3025 + divider + dedicated ADS1115 (0x49) — UNCALIBRATED until a "
     "traceable chain exists post-fab", None),
    (5, "External Instrument Interface", "implemented_now",
     "TTL UART bridge + trigger/sync on protected GPIO; no internal instrument "
     "claims", None),
    (6, "Power / Current Monitor", "implemented_now",
     "shunt + divider + protected ADS1115 (0x48); monitor-only 0-24V/0-500mA", None),
    (7, "DMM-lite", "architecture_only",
     "the V/I chains exist on-board but NO DMM claim is permitted without "
     "calibration evidence; DMM-lite remains gated on the physical cal board", None),
    (8, "Programmable DUT Power Control", "architecture_only",
     "no proven high-side switch/current-limit part in the library; safe "
     "power-supply behavior needs protection+thermal+validation evidence",
     "no validated power-control part + no protection evidence"),
    (9, "INA-class Current Monitor Variant", "architecture_only",
     "INA228 sources and routes (dc-measure fixture) but the measurement path "
     "has no validation evidence; future PCM-2", None),
    (10, "Stimulus / DAC", "architecture_only",
     "MCP4725-class ingests clean but is not approved into the library; no "
     "funcgen-class claim ever without amplitude/frequency/distortion evidence",
     "DAC not approved into library"),
    (11, "Function Generator Interface", "external_cots_interface_only",
     "COTS funcgen driven through the EII UART/trigger paths already on copper", None),
    (12, "Logic / Event Capture", "implemented_reduced_scope",
     "protected GPIO event capture (us-class, honest); NO logic-analyzer timing "
     "claim; COTS LA for timing truth", None),
    (13, "Scope-lite / Waveform Capture", "external_cots_interface_only",
     "internal scope remains hard-blocked (no sampling/bandwidth/timing path); "
     "COTS scope via EII trigger/serial", None),
    (14, "RF / 50-ohm Interface", "reserved_zone_only",
     "external-tool-first stands; a connector zone is reserved in the "
     "partitioning model only — NO RF performance claim", None),
    (15, "Relay Expansion / Higher-Channel Matrix", "reserved_zone_only",
     "board area reserved next to the proven matrix; duplicating the modular "
     "relay board remains the evidenced expansion path", None),
    (16, "Calibration Expansion / Reference Ladder", "implemented_reduced_scope",
     "REF_DIV2 ladder extension on copper (Candidate D) — more known nodes, "
     "zero accuracy claim", None),
]

HARD_BLOCKERS = ("qfn56_fanout_failure", "qspi_routing_failure", "usb_unsupported",
                 "clock_layout_unsupported", "mixed_signal_noise_risk",
                 "unsafe_relay_defaults", "dropped_nets", "drc_erc_failure",
                 "role_incompleteness", "missing_validation_path",
                 "fake_internal_instrument_claim", "unsupported_calibration_path")


def function_map():
    return {"version": "v1", "functions": [
        {"n": n, "function": f, "treatment": t, "detail": d,
         "exact_blocker": blk,
         "unsupported_claims": _forbidden(n)}
        for n, f, t, d, blk in FUNCTIONS]}


def _forbidden(n):
    return {
        7: ["precision/DMM claim without calibration evidence"],
        8: ["programmable-PSU claim", "high-current/high-voltage claim"],
        10: ["function-generator-class amplitude/frequency/distortion claims"],
        11: ["internal function-generator claim"],
        12: ["logic-analyzer-class timing claims"],
        13: ["oscilloscope-class bandwidth/sample-rate claims"],
        14: ["RF/impedance performance claims"],
        16: ["calibration accuracy claim without physical validation"],
    }.get(n, [])


def candidates(results):
    """results = {run_id: {routing, drc, unconn, status, role, nopico_ok}} from
    the REAL runs; scores stay subordinate to hard blockers."""
    b = results["fl1-core6-mono-pico"]
    c = results["fl1-core6-mono-bare"]
    d = results["fl1-full16-mono-bare"]
    return [
        {"id": "A", "name": "modular backplane + plugin cards (CURRENT)",
         "status": "proven — six review-required boards, all gates green",
         "evidence": "Batch 1 + EII-1 + PCM-1 real runs", "hard_blockers": [],
         "strengths": "lowest integration risk, best debug isolation, smallest "
                      "respin blast radius, per-module bring-up",
         "weaknesses": "connector/card count, backplane assembly"},
        {"id": "B", "name": "Core-6 monolithic, Pico module",
         "status": "routed_and_review_required" if b["status"] == "PASSED"
                   else "blocked_by_density",
         "evidence": "run fl1-core6-mono-pico: %s nets, %d DRC, %d unconn, "
                     "role %s" % (b["routing"], b["drc"], b["unconn"], b["role"]),
         "hard_blockers": [],
         "strengths": "one-board cost-down candidate WITHOUT bare-MCU risk; "
                      "proves monolithic density is composable (~174x186mm)",
         "weaknesses": "all-or-nothing bring-up; noise partitioning modeled, "
                       "not measured; large board cost"},
        {"id": "C", "name": "Core-6 monolithic, bare RP2040 (no Pico)",
         "status": "blocked_by_qfn56_fanout",
         "evidence": "run fl1-core6-mono-bare: %s nets, %d DRC violations, %d "
                     "unconnected — ALL violations are between fanout escape "
                     "artifacts (0 touch the QFN body); role %s; no-Pico "
                     "subsystem checks ALL PRESENT" %
                     (c["routing"], c["drc"], c["unconn"], c["role"]),
         "hard_blockers": ["qfn56_fanout_failure"],
         "exact_blocker": "fine-pitch fanout is single-row lane geometry (proven "
                          "at 0.5mm TSSOP-10); a four-sided 0.4mm QFN-56 needs a "
                          "quadrant-aware escape planner — escapes collide "
                          "(48 violations) and 18 items stay unconnected "
                          "(RP_XIN/RP_DVDD/SWD among them)",
         "strengths": "everything EXCEPT the QFN escape works: subsystem parts "
                      "place, role completeness 16/16",
         "weaknesses": "pin maps are manual transcriptions (ingestion "
                       "validation required); USB advisory only"},
        {"id": "D", "name": "Full-16 monolithic, bare RP2040 (MAIN STRETCH)",
         "status": "architecture_only_with_blockers",
         "evidence": "run fl1-full16-mono-bare: %s nets, %d DRC, %d unconn — "
                     "same single blocker as C; all 16 functions carry honest "
                     "treatments (6 implemented, 2 reduced, 2 external-COTS, "
                     "2 reserved, 4 architecture_only)" %
                     (d["routing"], d["drc"], d["unconn"]),
         "hard_blockers": ["qfn56_fanout_failure"],
         "exact_blocker": "identical QFN-56 escape-density failure as Candidate C",
         "strengths": "the Full-16 ambition is now MAPPED honestly — nothing "
                      "fake, every gap named",
         "weaknesses": "inherits every C weakness plus maximum respin blast "
                       "radius and mixed-signal risk"},
        {"id": "E", "name": "Full-16 monolithic, alternate MCU/module",
         "status": "architecture_only",
         "evidence": "no credible proven alternate in the library: the only "
                     "validated MCU primitive is the Pico module; an LQFP "
                     "0.5mm-pitch MCU (leaded, escapes like TSSOP) is the "
                     "plausible candidate but has no ingestion, no firmware "
                     "port, no validation path today",
         "hard_blockers": [], "exact_blocker": "no credible proven alternate selected"},
    ]


def rp2040_subsystem(c_result):
    ok = c_result["nopico_ok"]
    return {"version": "v1", "elements": [
        {"element": "RP2040 QFN-56", "footprint": "QFN-56-1EP_7x7mm_P0.4mm (KiCad lib)",
         "ingestion": "NOT ingested — pin map manually transcribed from datasheet; "
                      "ingestion validation REQUIRED before any build",
         "routing_risk": "BLOCKED: qfn56 escape density (real run evidence)",
         "validation": "physical bring-up (SWD detect, blink) after any routed board"},
        {"element": "QSPI flash (W25Q16, SOIC-8)", "ingestion": "manual pin map",
         "routing_risk": "6-net bus placed + partially routed; NO timing claim"},
        {"element": "12MHz crystal (3225)", "routing_risk": "placed + load caps; "
         "NO layout-performance claim without review/evidence"},
        {"element": "3V3 regulator (AMS1117 SOT-223)", "routing_risk": "low"},
        {"element": "decoupling", "routing_risk": "low (7 caps placed)"},
        {"element": "boot select + reset", "routing_risk": "low (straps + headers)"},
        {"element": "SWD header", "routing_risk": "low"},
        {"element": "USB D+/D-", "routing_risk": "ADVISORY test pads only — no "
         "connector, no impedance control capability, NO USB compliance claim"},
        {"element": "status LED", "routing_risk": "omitted in v1 attempt (minor)"}],
        "presence_on_real_board": "ALL PRESENT" if ok else "gaps recorded",
        "honesty": ["no USB compliance claim", "no QSPI timing claim",
                    "no crystal performance claim",
                    "no bare-MCU bring-up claim without physical test evidence",
                    "no Pico module on no-Pico candidates (verified on copper)"]}


def qfn_feasibility(c_result):
    return {"version": "v1", "status": "blocked_by_escape_density",
            "attempted": True,
            "evidence": "real pipeline run fl1-core6-mono-bare: fanout pre-fanned "
                        "41 escapes on U30; %d DRC violations (clearance 13, "
                        "shorts 17, crossings 4, courtyard 14) ALL between escape "
                        "artifacts; %d unconnected" %
                        (c_result["drc"], c_result["unconn"]),
            "root_cause": "fine_pitch_fanout uses single-row lane geometry (built "
                          "for TSSOP-10); QFN-56 needs four-quadrant escape "
                          "planning + thermal-pad via field + 0.4mm pitch below "
                          "the 0.46mm router grid",
            "what_would_unblock": ["quadrant-aware escape planner",
                                   "finer routing grid or off-grid escape channel",
                                   "thermal-pad via strategy",
                                   "RP2040 ingestion validation (pin map)"],
            "assumptions": "4-layer, 0.13/0.13 fine-pitch class, standard fab"}


def domains():
    zones = [
        ("bare MCU / digital control", "board center-left", "QFN keepout + escape field"),
        ("QSPI / clock / debug", "adjacent to MCU, short traces", "crystal keepout"),
        ("DUT digital IO", "left edge connectors", None),
        ("relay/switching matrix", "bottom row, away from analog", "coil noise aggressor"),
        ("relay expansion", "RESERVED zone beside matrix", None),
        ("calibration/reference analog", "top-right, quietest corner",
         "victim: keep relay coils + digital edges away"),
        ("calibration expansion ladder", "inside cal analog zone", None),
        ("DMM-lite analog", "architecture_only (no zone committed)", None),
        ("power/current monitor analog", "right edge near DUT connector",
         "DUT return current kept out of cal corner"),
        ("INA monitor alternate", "architecture_only", None),
        ("DUT power control", "architecture_only (no validated parts)", None),
        ("stimulus/DAC", "architecture_only", None),
        ("logic/event capture", "shares protected GPIO bank zone", None),
        ("external instrument interface", "top edge headers", None),
        ("scope external-COTS interface", "external via EII paths (no internal zone)", None),
        ("RF interface", "RESERVED edge zone, external-tool-first", None),
        ("DUT connector area", "right edge, labeled", None),
        ("power input/regulation", "top-left inlet + SOT-223", None),
        ("test points", "bottom margin rows (proven pattern)", None),
        ("safety/interlock/fault", "bus header zone, labeled", None)]
    return {"version": "v1",
            "domains": [{"domain": d, "zone": z, "notes": k} for d, z, k in zones],
            "rules": ["cal/reference separated from relay coil + digital switching",
                      "ADC inputs protected + labeled", "relay defaults safe (SR_OE)",
                      "DUT power path kept out of the low-noise reference corner",
                      "EII paths never create internal instrument claims",
                      "RF/scope internal areas reserved or external-COTS only",
                      "no mains, no high voltage",
                      "partitioning is MODELED, not measured — a real monolith "
                      "would need noise validation evidence"]}


def manufacturing_risk():
    rows = [
        ("modular six-board family", "small boards", "proven", "per-module", "LOW",
         "one card respins alone; fastest time-to-first-working-hardware"),
        ("Core-6 monolithic (Pico)", "~174x186mm, 70 parts", "fine-pitch TSSOP x2",
         "all-or-nothing", "MEDIUM",
         "routes clean today; yield/debug/respin risk concentrated in one board"),
        ("Core-6 monolithic (bare RP2040)", "~152x182mm, 85 parts",
         "QFN-56 0.4mm + TSSOP x2 — X-ray/AOI required", "all-or-nothing", "HIGH",
         "BLOCKED at escape routing; also unvalidated pin maps + bring-up risk"),
        ("Full-16 monolithic (bare RP2040)", "~170x182mm, 88 parts",
         "same + maximum mixed-signal exposure", "all-or-nothing", "HIGH",
         "same blocker; largest respin blast radius of any candidate"),
        ("Full-16 alternate MCU", "unmodeled", "unknown", "all-or-nothing",
         "UNKNOWN", "architecture_only — no credible proven alternate")]
    return {"version": "v1", "rows": [
        {"candidate": c, "size": s, "fine_pitch": f, "bringup": b2,
         "risk": r, "note": n} for c, s, f, b2, r, n in rows]}


def recommendation():
    return {"version": "v1",
            "recommendation": "keep_modular_for_first_articles",
            "secondary": ["build_bare_rp2040_core_test_board_first",
                          "pursue_core6_monolithic_pico_as_costdown_later",
                          "keep_scope_rf_funcgen_external_cots"],
            "reasoning": [
                "the six modular plugin boards are the only articles with full "
                "gate evidence — they remain the first-article path",
                "Candidate B (Core-6 + Pico) ROUTED CLEAN: monolithic density is "
                "now a proven Compose capability, so a Pico-based monolith is a "
                "credible Rev C cost-down AFTER the modular system works",
                "bare RP2040 is blocked by exactly one thing: four-sided QFN-56 "
                "escape planning. When that lands, the right next step is a "
                "SMALL RP2040 core test board (MCU+flash+crystal+reg+SWD only), "
                "physically brought up, BEFORE migrating any plugin board",
                "scope/RF/funcgen/logic-analyzer-class capability stays external "
                "COTS — the stress test changed nothing about those verdicts",
                "Full-16 monolithic is a long-term cost-down shape at most; its "
                "value today is the honest 16-function treatment map"],
            "stress_test_verdict": "SUCCESS AS A STRESS TEST: Compose accounted "
                                   "for all 16 functions, attempted the no-Pico "
                                   "monolith for real, and produced one exact, "
                                   "actionable blocker instead of a fake pass"}
