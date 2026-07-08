"""M3A/M3B shared: UI data, registry, roadmap, fleet learning, hygiene md."""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")
D = os.path.join(RUNS, "fl1-backplane-v1", "data")


def _w(name, obj):
    json.dump(obj, open(os.path.join(D, name + ".json"), "w"), indent=1)


_w("compose-hardening-registry-update", {
    "version": "v1",
    "new_fields": ["router_evidence_state", "router_fixture_coverage",
                   "router_drc_correlation_state", "external_analysis_state",
                   "external_tools_available", "external_tools_missing",
                   "models_missing", "stackup_missing",
                   "claim_gate_dependencies", "analysis_artifact_paths"],
    "board_defaults": {
        "router_fixture_coverage": "24 fixtures (21 synthetic/fanout + 3 "
                                   "realboard replays), all green",
        "router_drc_correlation_state": "kicad-cli DRC ANDed with router "
                                        "pass on every drc_required fixture",
        "external_analysis_state": "inventory + advisory available; "
                                   "claim-gated analyses blocked on models/"
                                   "stackup",
        "external_tools_available": ["ngspice 45.2", "numpy", "scipy",
                                     "matplotlib"],
        "external_tools_missing": ["skrf", "openEMS", "PySpice"],
        "models_missing": ["IC SPICE models", "IBIS", "S-parameters",
                           "fab stackup"],
        "stackup_missing": True}})
_w("compose-roadmap-hardening-update", {
    "version": "v2",
    "sequence": ["M6 (DONE 446530a)",
                 "M3A flroute regression harness (THIS SPRINT)",
                 "M3B external EDA evidence (THIS SPRINT)",
                 "REPLAY quarantined M7-M12 drafts through hardened layers",
                 "M7 BGA verified part", "M8 advanced fab gates",
                 "M9 power-stage", "M10 RF", "M11 high-speed SI",
                 "M12 reliability classes", "M13 digital twin",
                 "M14 closed-loop learning"],
    "why_inserted": "advanced domains (BGA/HDI/power/RF/SI) all depend on "
                    "router trust and analysis evidence; neither had "
                    "dedicated regression before this sprint",
    "unblocked": ["router changes now land against 24 fixtures + goldens",
                  "external claims now have gates wired to real tool "
                  "detection"],
    "still_blocked_on_physical": ["physically_validated anywhere",
                                  "calibration", "EMC", "strong PI",
                                  "controlled-Z manufacturing"]})
_w("compose-hardening-fleet-learning-update", {
    "version": "v1",
    "router": {"harness": "built; full 21/21, realboard 3/3, goldens 24, "
               "synthetic determinism PROVEN (2 identical runs)",
               "bugs_found_and_fixed": [
                   "single-signal fine-pitch rows skipped by fanout "
                   "(0.175mm clearance class)",
                   "zone-dive copper lost when restoring from entries "
                   "instead of the sidecar"],
               "audit_findings": ["two-largest-nets plane heuristic",
                                  "per-net failure reasons not machine-"
                                  "readable in Rust (harness compensates)"]},
    "external_eda": {"available": ["ngspice 45.2 (REAL divider run: "
                                   "Vout 2.5V == analytic)"],
                     "missing": ["skrf", "openEMS", "IBIS", "stackup"],
                     "gates": "11 claim gates wired; 10 blocked, RC-filter "
                              "advisory possible"},
    "next_actions": ["replay M7-M12 drafts through the hardened layers",
                     "the physical first article remains the single "
                     "highest-value evidence (ledger still empty)"]})
open(os.path.join(D, "compose-hardening-pause-hygiene-report.md"),
     "w").write("""# Hardening pause hygiene\n\nM6 committed (446530a) and
green before hardening began. M7-M12 drafts quarantined in
drafts/m7-m12-pre-hardening/ (NOT roadmap-complete; replay after hardening).
The chipdown ball-name pin sort shipped with M6 as a shared-file parser fix
and is recorded, not relabeled. User-local UI/3D work left untouched and
unstaged. The hardening commit stages only M3A/M3B files.\n""")
print("shared artifacts written")
