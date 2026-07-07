"""Phase 19.1: generate the backplane-integration-fix artifacts.

  gen_phase191.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import i2c_system as ic  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")
TARGETS = ["fl1-backplane-v1", "fl1-cal-board-v4"]


def _w(name, obj):
    for r in TARGETS:
        json.dump(obj, open(os.path.join(RUNS, r, "data", name + ".json"), "w"), indent=1)


_w("fl1-i2c-pullup-ownership-model", ic.ownership_model())

# checker scenarios (the report shows the checker WORKING, incl. the bad case)
full_stack = [(n, v, p) for _r, n, _refs, v, p in ic.I2C_BOARDS]
scenarios = {
    "system_all_populated_AS_BUILT": ic.effective_pullup(full_stack),
    "system_revb_backplane_owner": ic.effective_pullup(
        [(n, v, "DNP" if r != "passive_backplane" else "populated")
         for r, n, _refs, v, _p in ic.I2C_BOARDS]),
    "standalone_single_card": ic.effective_pullup(
        [("Digital Bring-up v2.1", 4700, "populated")], mode="standalone"),
    "missing_all_pullups": ic.effective_pullup(
        [(n, v, "DNP") for _r, n, _refs, v, _p in ic.I2C_BOARDS]),
    "unknown_population": ic.effective_pullup(
        [("Digital Bring-up v2.1", 4700, "unknown"),
         ("Passive Backplane v1", 4700, "populated")]),
}
_w("fl1-i2c-pullup-checker-report", {
    "version": "v1", "classifications": list(ic.CLASSIFICATIONS),
    "thresholds": {"bus_v": ic.BUS_V, "vol": ic.VOL,
                   "sink_max_ma": ic.I_SINK_MAX_MA,
                   "r_min_ok_ohm": round(ic.R_MIN_OK, 1)},
    "scenarios": scenarios,
    "physical_compliance": "measurement_required for ALL scenarios — rise time "
                           "+ sink current with recorded instrument identity; "
                           "no I2C compliance claim from arithmetic alone"})

# Rev B population plan
plan_rows = []
for role, name, refs, val, _p in ic.I2C_BOARDS:
    is_bp = role == "passive_backplane"
    plan_rows.append({
        "board": name, "refs": refs, "value_ohm": val,
        "current": "populated",
        "standalone_build": "populated (required for bench validation)",
        "backplane_system_build": "populated (OWNER)" if is_bp else "DNP",
        "revb_footprint_change": None if is_bp else
            "add solder-jumper / 0-ohm link in series so card pull-ups are "
            "enable-able without rework",
        "revb_population_change": None if is_bp else "DNP default in system BOM view",
        "assembly_note": "system builds: verify card R10/R11 NOT populated"
                          if not is_bp else "always populated",
        "validation_note": "standalone validation populates them first" if not is_bp
                            else "bus defined with zero cards inserted",
        "redesign_required": False,
        "bom_dnp_note_sufficient_for_first_article": True})
_w("fl1-revb-i2c-pullup-population-plan", {
    "version": "v1", "direction": "backplane owns system I2C pull-ups; card "
    "pull-ups DNP by default for system builds, populated for standalone/debug; "
    "solder-jumper enable in Rev B",
    "boards": plan_rows,
    "first_article_path": "DNP notes in the assembly checklist are SUFFICIENT "
    "for first articles (no redesign needed); effective pull-up calculation "
    "required before system validation"})

_w("fl1-connector-keying-policy", {
    "version": "v1",
    "policy": ic.orientation_check()["rules"],
    "connectors": [{
        "connector": c[0], "board": c[1], "type": c[2], "pins": c[3],
        "pitch_mm": 2.54, "pin1_marking": "silk" if c[5] else "MISSING",
        "reversal_risk": "yes" if not c[4] else "no",
        "offset_insertion_risk": "yes (unshrouded)" if not c[4] else "no",
        "keyed_candidate": "keyed shrouded box header (same pitch)",
        "locking_candidate": "friction latch option" if c[6] else None,
        "cost_risk": "low (commodity)",
        "severity": "high" if c[6] and not c[4] else "medium",
        "revb": "keyed shrouded" if c[6] and not c[4] else "shrouded option",
        "first_article_mitigation": "pin-1 silk + checklist + human inspection"}
        for c in ic.CONNECTORS]})
_w("fl1-connector-orientation-checker-report", ic.orientation_check())

# Rev B recommendations with evidence links
_w("fl1-system-revb-recommendations", {
    "version": "v1", "recommendations": [
        {"recommendation_id": "REVB-001", "affected": "all six cards (R10/R11)",
         "evidence": "fl1-pinout-compatibility-report (Phase 19) + "
                     "fl1-i2c-pullup-checker-report scenario "
                     "system_all_populated_AS_BUILT",
         "severity": "medium", "change": "card pull-ups DNP in system builds; "
         "solder-jumper enable in Rev B", "auto_redesign": False,
         "human_review": True, "benefit": "single-owner bus within I2C spec",
         "risk": "standalone validation must populate first",
         "phase": "first article: BOM/DNP note; Rev B: jumper footprint",
         "first_article_ok_with_mitigation": True, "revb_redesign": True},
        {"recommendation_id": "REVB-002", "affected": "backplane R94/R95",
         "evidence": "same", "severity": "low",
         "change": "backplane confirmed as the system pull-up OWNER",
         "auto_redesign": False, "human_review": True,
         "benefit": "bus defined with any card population",
         "risk": "none identified", "phase": "no change needed",
         "first_article_ok_with_mitigation": True, "revb_redesign": False},
        {"recommendation_id": "REVB-003",
         "affected": "J8 card headers + J40-J45 slots + power/DUT connectors",
         "evidence": "fl1-connector-orientation-checker-report",
         "severity": "high", "change": "keyed shrouded headers for all "
         "board-to-backplane and safety/power connectors",
         "auto_redesign": False, "human_review": True,
         "benefit": "reversed insertion becomes impossible",
         "risk": "footprint change -> Rev B respin of connector zones",
         "phase": "first article: pin-1 silk + checklist + inspection; "
                  "Rev B: connector swap", "first_article_ok_with_mitigation": True,
         "revb_redesign": True},
        {"recommendation_id": "REVB-004", "affected": "assembly checklist",
         "evidence": "Phase 19 assembly workflow", "severity": "medium",
         "change": "add pin-1 orientation inspection + card pull-up DNP "
         "verification + photo evidence steps", "auto_redesign": False,
         "human_review": True, "benefit": "human-verifiable mitigations",
         "risk": "none", "phase": "immediate (workflow-only)",
         "first_article_ok_with_mitigation": True, "revb_redesign": False},
        {"recommendation_id": "REVB-005", "affected": "system layout",
         "evidence": "Phase 19 grounding/slot-order notes (preserved)",
         "severity": "low", "change": "keep cal card one slot from relay "
         "coils; keep DUT return through PCM-1 only", "auto_redesign": False,
         "human_review": True, "benefit": "noise partitioning preserved",
         "risk": "unmeasured until bring-up", "phase": "unchanged",
         "first_article_ok_with_mitigation": True, "revb_redesign": False}],
    "rules": ["no automatic redesign in this phase", "first articles still "
              "carry review-required findings (visible)", "Rev B recommendations "
              "are NOT production readiness", "evidence links preserved"]})

# validation plan v2
_w("fl1-multiboard-validation-plan-v2", {
    "version": "v2", "adds_over_v1": [
        {"stage": "i2c_pullup_ownership_check", "checks": [
            "identify installed boards", "read intended population mode",
            "compute effective pull-up (checker)",
            "verify exactly one system owner or approved configuration",
            "BLOCK system validation if classification is too_strong_pullup, "
            "missing_pullup, unknown_population, or invalid_configuration"]},
        {"stage": "i2c_physical_measurement", "checks": [
            "SDA/SCL idle voltage", "low-level sink behavior if feasible",
            "rise time with external scope if available (instrument identity "
            "recorded)", "otherwise the bus stays measurement_required — no "
            "compliance claim from arithmetic"]},
        {"stage": "connector_orientation_inspection", "checks": [
            "keyed/shrouded status", "pin-1 marks present", "cable/header "
            "orientation verified", "photo/inspection evidence recorded",
            "BLOCK system validation if orientation cannot be verified"]},
        {"stage": "slot_identity_scan", "checks": ["0x50-0x55 as expected",
            "no conflicts", "missing slots handled"]},
        {"stage": "safety_line_continuity", "checks": ["interlock", "fault",
            "reset", "trigger", "sync (TRIG only in v1 — honest scope)"]},
        {"stage": "power_on_sequence", "checks": ["current-limited bench 5V",
            "no DUT connected initially", "no unexpected draw"]}],
    "rules": ["mock evidence remains simulated", "physical I2C compliance "
              "requires physical measurement", "no pass with unverifiable "
              "connector orientation", "no pass with invalid effective pull-up",
              "no production-ready claim"]})

# manufacturing v2 + risks v2
_w("fl1-system-manufacturing-readiness-v2", {
    "version": "v2", "adds": [
        "BOM views: standalone (card pull-ups populated) vs system (card "
        "pull-ups DNP, backplane owner populated)",
        "assembly note: verify card R10/R11 NOT populated in system builds",
        "pin-1 inspection step with photo evidence",
        "keyed shrouded connector candidates listed for Rev B quote",
        "quote-package caveat: first articles ship with unkeyed headers + "
        "documented mitigations"],
    "honesty": "order statuses unchanged; board recommendations unchanged; "
               "system not production-ready; nothing ordered"})
_w("fl1-system-risk-register-v2", {
    "version": "v2", "changes": [
        {"risk": "I2C pull-up stacking", "was": "identified (Phase 19)",
         "now": "ENFORCED: checker blocks invalid configurations; Rev B "
                "population plan exists; still review_required until "
                "physically measured"},
        {"risk": "unkeyed connectors", "was": "identified (Phase 19)",
         "now": "ENFORCED: orientation checker + inspection gate in validation "
                "plan v2; Rev B keyed-connector recommendation recorded"}],
    "carried_forward": "all 8 Phase 19 risks remain open until bring-up"})

# human approval form v2
form = """# FL-1 Seven-Board System — Human Approval Form v2

| Board | Decision (approve_first_article_with_mitigation / revise_before_order / hold) | Notes |
|---|---|---|
| Controller / Backplane v2.1 |  |  |
| Digital Bring-up v2.1 |  |  |
| Relay / Probe Matrix v2.1 |  |  |
| Calibration / Reference v2 |  |  |
| External Instrument Interface EII-1 |  |  |
| Power / Current Monitor PCM-1 |  |  |
| Passive Backplane v1 |  |  |

System-level acknowledgements (initial each):

- [ ] I2C pull-up stacking finding acknowledged (six cards + backplane stack to
      ~670-780 ohm; checker classifies too_strong_pullup)
- [ ] Card-side DNP / backplane-owner population plan acknowledged
- [ ] Unkeyed connector first-article mitigation acknowledged (pin-1 silk +
      checklist + human inspection)
- [ ] Keyed shrouded connector Rev B recommendation acknowledged
- [ ] No production-readiness claim is made anywhere
- [ ] No automatic ordering occurs; Compose cannot spend money

**Compose provides evidence and recommendations. It does not submit orders.**
"""
for r in TARGETS:
    open(os.path.join(RUNS, r, "data", "fl1-seven-board-human-approval-form-v2.md"), "w").write(form)

print("as-built system:", scenarios["system_all_populated_AS_BUILT"]["classification"],
      scenarios["system_all_populated_AS_BUILT"]["effective_ohm"], "ohm,",
      scenarios["system_all_populated_AS_BUILT"]["estimated_sink_ma_at_VOL"], "mA")
print("Rev B (backplane owner):", scenarios["system_revb_backplane_owner"]["classification"],
      scenarios["system_revb_backplane_owner"]["effective_ohm"], "ohm")
print("missing:", scenarios["missing_all_pullups"]["classification"],
      "| unknown:", scenarios["unknown_population"]["classification"])
oc = ic.orientation_check()
print("connectors flagged:", sum(1 for c in oc["connectors"]
      if c["classification"] == "unkeyed_review_required"), "of", len(oc["connectors"]))
