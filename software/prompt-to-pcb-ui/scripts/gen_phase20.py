"""Phase 20: generate the production-line + supply-chain artifacts from the
seven REAL board packages.

  gen_phase20.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import production_line as pl  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")
BOARDS = [
    ("Controller / Backplane v2.1", "fl1-core-controller-v21"),
    ("Digital Bring-up v2.1", "fl1-core-digital-v21"),
    ("Relay / Probe Matrix v2.1", "fl1-core-relay-v21"),
    ("Calibration / Reference v2", "fl1-cal-board-v4"),
    ("External Instrument Interface EII-1", "fl1-eii1-v1"),
    ("Power / Current Monitor PCM-1", "fl1-pcm1-v1"),
    ("Passive Backplane v1", "fl1-backplane-v1"),
]
TARGETS = ["fl1-backplane-v1", "fl1-cal-board-v4"]


def _w(name, obj):
    for r in TARGETS:
        json.dump(obj, open(os.path.join(RUNS, r, "data", name + ".json"), "w"), indent=1)


def _protected_class(part):
    p = part.lower()
    if "ref30" in p or "reference" in p:
        return "precision_reference"
    if "ads1115" in p or ("adc" in p and "header" not in p):
        return "adc"
    if "relay" in p:
        return "relay"
    if "24lc" in p or "eeprom" in p:
        return "eeprom"
    if "pico" in p or "rp2040" in p:
        return "mcu_module"
    return None


# ---- Phase 1: system BOM rollup from the REAL per-board BOMs -----------------
rollup, board_costs = [], {}
for name, run in BOARDS:
    bom = json.load(open(os.path.join(RUNS, run, "data", "bom.json")))
    lines = bom if isinstance(bom, list) else bom.get("lines", [])
    total = 0.0
    for ln in lines:
        total += float(ln.get("lineTotal") or 0)
        prot = _protected_class(str(ln.get("part", "")))
        pullup = "R10" in str(ln.get("ref", "")) or "R94" in str(ln.get("ref", ""))
        rollup.append({
            "board": name, "run_id": run, "ref": ln.get("ref"),
            "part": ln.get("part"), "supplier_pn": ln.get("lcsc"),
            "qty_per_board": ln.get("qty"), "qty_per_system": ln.get("qty"),
            "unit_price_usd": ln.get("unitPrice"),
            "substitution_policy": ("not_allowed_silent (%s)" % pl.PROTECTED[prot])
                                   if prot else "allowed_with_review (passives: "
                                   "same value/size/tolerance)",
            "single_source": prot in ("precision_reference", "adc"),
            "dnp_note": "system builds: card pull-ups DNP (backplane owns bus); "
                        "standalone builds: populated" if pullup and
                        run != "fl1-backplane-v1" else None,
            "first_article_note": "populated per standalone-validation variant "
                                  "until system assembly" if pullup else None,
            "revb_note": "solder-jumper enable footprint" if pullup and
                         run != "fl1-backplane-v1" else None,
        })
    board_costs[name] = round(total, 2)

SYSTEM_ITEMS = [
    ("M3x8 standoffs", 28, 0.15, "mechanical"), ("M3 screws/nuts", 56, 0.03, "mechanical"),
    ("aluminum plate 220x200", 1, 18.0, "mechanical"),
    ("2x07 socket headers (slot mating)", 6, 0.45, "connector — Rev B alternate: "
     "KEYED SHROUDED box header (same pitch)"),
    ("DUT harness (interim)", 1, 12.0, "cable"), ("bench 5V lead", 1, 4.0, "cable"),
    ("QR/serial label set", 7, 0.5, "labels"), ("inline fuse holder + fuses", 1, 3.0,
     "protection (recommended before routine use)"),
    ("DUT adapter card placeholder", 1, 0.0, "placeholder — Compose-generated later"),
    ("inspection aids (loupe/photo jig)", 1, 0.0, "placeholder"),
]
for item, qty, price, cat in SYSTEM_ITEMS:
    rollup.append({"board": "SYSTEM", "ref": cat, "part": item,
                   "qty_per_system": qty, "unit_price_usd": price,
                   "substitution_policy": "not_allowed_silent (mating interface)"
                   if "connector" in cat else "allowed_with_review"})
_w("fl1-system-bom-rollup", {
    "version": "v1", "lines": rollup,
    "per_board_bom_cost_usd": board_costs,
    "protected_components": pl.PROTECTED,
    "notes": ["I2C pull-up DNP/population states represented per build variant",
              "keyed connector candidates listed as Rev B alternates",
              "no silent substitutions for protected classes"]})

# ---- Phase 2: vendors + sourcing risk ----------------------------------------
CATS = [
    ("MCU module", "official RPi distributors", "second distributor", "Pico module",
     "exact_part_required", "low"),
    ("EEPROM", "LCSC/DigiKey", "Mouser", "24LC02 SOIC-8", "not_allowed_silent", "low"),
    ("ADC", "TI direct/DigiKey", "Mouser", "ADS1115 TSSOP-10", "exact_part_required",
     "medium (single-source TI)"),
    ("precision reference", "TI direct/DigiKey", "Mouser", "REF3025 SOT-23",
     "exact_part_required", "medium (single-source TI)"),
    ("shunts", "LCSC", "DigiKey", "0402 value-selected", "not_allowed_silent", "low"),
    ("relays", "LCSC/DigiKey", "Mouser", "signal relay (validated footprint)",
     "not_allowed_silent", "medium"),
    ("connectors", "LCSC", "DigiKey", "2.54mm headers; Rev B keyed shrouded",
     "not_allowed_silent (board-to-backplane)", "low"),
    ("pull-up resistors", "LCSC", "any", "0402 4.7k", "allowed_with_review", "low"),
    ("protection components", "LCSC", "DigiKey", "series R / fuse",
     "not_allowed_silent (safety-adjacent)", "low"),
    ("headers/mechanical", "LCSC/McMaster", "Amazon industrial", "standoffs/screws",
     "allowed_with_review", "low"),
    ("labels/QR", "local print", "any", "polyester labels", "allowed", "low"),
    ("open-frame parts", "McMaster/SendCutSend", "local shop", "plate",
     "allowed_with_review", "low"),
    ("cable/harness", "bench-made v1", "harness shop later", "interim harness",
     "allowed_with_review", "low"),
]
_w("fl1-approved-vendor-list", {
    "version": "v1", "categories": [
        {"category": c, "primary": p, "alternate": a, "approved_parts": ap,
         "substitution": sub, "lead_time": "PLACEHOLDER — quote-time data",
         "stock_risk": risk, "lifecycle_risk": "active parts, none EOL-flagged",
         "traceability": "any substitution recorded in the evidence ledger"}
        for c, p, a, ap, sub, risk in CATS],
    "rules": ["no silent substitution for protected classes",
              "supplier substitutions are traceable, always"]})
_w("fl1-sourcing-risk-model", {
    "version": "v1",
    "highest_risks": [
        {"part": "REF3025", "risk": "single-source TI", "mitigation": "buy 3x spares"},
        {"part": "ADS1115", "risk": "single-source TI (clones exist but are "
         "FORBIDDEN silent substitutes)", "mitigation": "buy 3x spares, authorized "
         "distributors only"},
        {"part": "signal relays", "risk": "footprint variants across brands",
         "mitigation": "pin-compatible verified list only"},
        {"part": "Pico module", "risk": "counterfeit market exists",
         "mitigation": "official distributors only"}],
    "note": "lead times are quote-time placeholders — no fake availability data"})

# ---- Phase 3: cost model (grounded per-board BOM + placeholders labeled) -----
bom_sys = round(sum(board_costs.values()), 2)
mech = round(sum(q * p for _i, q, p, _c in SYSTEM_ITEMS), 2)


def batch(n_sys, pcba_per_board=3):
    fab = 7 * pcba_per_board * 8.0     # PLACEHOLDER $8/board fab
    asm = 7 * pcba_per_board * 25.0    # PLACEHOLDER $25/board assembly
    bomc = bom_sys * pcba_per_board    # 3 sets of parts
    return {"systems": n_sys, "pcba_per_board": pcba_per_board,
            "fab_placeholder_usd": fab, "assembly_placeholder_usd": asm,
            "bom_from_real_boms_usd": round(bomc, 2),
            "mechanical_usd": round(mech * n_sys, 2),
            "spares_reserve_usd": 60.0, "rework_reserve_usd": 100.0,
            "inspection_labor_placeholder_usd": 150.0,
            "shipping_tax_placeholder_usd": 80.0,
            "total_placeholder_usd": round(fab + asm + bomc + mech * n_sys +
                                           60 + 100 + 150 + 80, 2)}


_w("fl1-cost-model", {
    "version": "v1",
    "grounded": "per-board BOM costs come from the REAL bom.json files",
    "per_board_bom_usd": board_costs,
    "batches": [batch(1), batch(3), batch(5)],
    "honesty": "fab/assembly/labor/shipping are PLACEHOLDERS until real quotes; "
               "no fake pricing claims"})

# ---- Phase 4: build variants ---------------------------------------------------
_w("fl1-build-variants", {
    "version": "v1", "variants": [
        {"variant": "standalone_card_validation", "use": "bench-validate one card",
         "population": "card I2C pull-ups POPULATED", "connectors": "unkeyed OK "
         "with pin-1 inspection", "validation": "per-board workflows",
         "allowed_claims": "board-level gate evidence only",
         "forbidden_claims": "system behavior, I2C system compliance",
         "order_status": "human_review_required"},
        {"variant": "backplane_system_first_article", "use": "the seven-board machine",
         "population": "backplane owns I2C pull-ups; card pull-ups DNP "
         "(BOM/DNP note — checker blocks the all-populated stack)",
         "connectors": "unkeyed ONLY with pin-1 silk + checklist + inspection",
         "validation": "multi-board plan v2 (blocks invalid pull-up config / "
         "unverified orientation)", "allowed_claims": "review-required first article",
         "forbidden_claims": "production-ready, I2C compliance without measurement",
         "order_status": "human_review_required"},
        {"variant": "revb_system", "use": "post-first-article revision",
         "population": "backplane-owned pull-ups; card jumper-enable footprints",
         "connectors": "keyed shrouded preferred",
         "validation": "plan v2 + physical I2C measurement evidence",
         "allowed_claims": "whatever the evidence then supports",
         "forbidden_claims": "anything unmeasured", "order_status": "not_designed_yet"},
        {"variant": "costdown_monolithic_future", "use": "Rev C cost-down candidate",
         "population": "n/a", "connectors": "n/a",
         "validation": "Phase 18.8 evidence only (Core-6+Pico routed clean)",
         "allowed_claims": "future candidate", "forbidden_claims":
         "first article, production-ready", "order_status": "not_a_candidate"}]})

# ---- Phase 5: manufacturing package audit vs REAL artifacts -------------------
REQUIRED = ["bom.json", "pick_and_place.csv", "board.json", "drc.json",
            "devices.json", "assembly-readiness.json", "sourcing-report.json"]
audit = []
for name, run in BOARDS:
    d = os.path.join(RUNS, run, "data")
    missing = [f for f in REQUIRED if not os.path.exists(os.path.join(d, f))]
    ar = json.load(open(os.path.join(d, "assembly-readiness.json")))
    cls = "package_complete_with_review" if not missing and ar.get("ready_for_assembly") \
        else ("missing_required_artifact" if missing else "review_required")
    audit.append({"board": name, "run_id": run, "classification": cls,
                  "missing": missing,
                  "gerbers": "generated deterministically at order time from the "
                             "package hash",
                  "dnp_notes": "I2C pull-up variant notes attached (Phase 19.1)",
                  "connector_notes": "pin-1 orientation notes attached (Phase 19.1)",
                  "workflows": "incoming inspection + bring-up + validation linked"})
_w("fl1-manufacturing-package-audit", {"version": "v1", "boards": audit,
    "all_complete_with_review": all(a["classification"] ==
                                    "package_complete_with_review" for a in audit)})

# ---- Phase 6: order batch plan (NO ordering) -----------------------------------
_w("fl1-first-article-order-batch-plan", {
    "version": "v1", "order_submitted": False,
    "boards": [{"board": name, "quantity": 3,
                "reason": "first-article standard: 1 to build, 1 to break, 1 spare",
                "extra": "optional +1 backplane (cheap, passive) and +1 relay "
                         "board (channel expansion path)" if "Backplane" in name
                         or "Relay" in name else None}
               for name, _run in BOARDS],
    "spare_parts": ["REF3025 x3", "ADS1115 x3", "signal relays x4", "24LC02 x4",
                    "shunt values x10", "2x07 headers x6", "Pico modules x2"],
    "human_approval": "seven-board approval form v2 MUST be signed first; "
                      "Compose cannot submit orders",
    "incoming_inspection": "per fl1-incoming-inspection-optimization",
    "bringup_sequence": "per fl1-assembly-test-flow"})

# ---- Phase 7: incoming inspection optimization ---------------------------------
_w("fl1-incoming-inspection-optimization", {
    "version": "v1",
    "per_board": ["revision", "serial/QR label", "connector orientation",
                  "pin-1 marks", "DNP/populated pull-up state vs variant",
                  "fine-pitch parts (AOI where present)", "relays seated",
                  "reference/ADC parts genuine-source check", "shunt value",
                  "mounting holes", "test points", "solder quality",
                  "top/bottom photos -> ledger"],
    "system_assembly": ["backplane slots", "card insertion orientation",
                        "slot straps visual", "standoffs/spacers", "harness",
                        "DUT adapter interface", "interlock behavior check"],
    "evidence": "photos + checklist entries appended to the ledger (never rewritten)"})

# ---- Phase 8: assembly/test flow (20 steps) ------------------------------------
FLOW = [
    ("receive boards", "none", "packing list vs order", False, True),
    ("incoming inspection", "loupe/camera", "per-board checklist + photos", False, True),
    ("serialize and scan", "QR scanner", "serials in ledger", False, True),
    ("board-level power sanity", "bench PSU current-limited", "rail voltages", False, False),
    ("board-level identity scan", "service laptop", "EEPROM 0x50 default", False, False),
    ("board-level bring-up", "service laptop", "per-board workflow pass", False, False),
    ("backplane inspection", "loupe", "slots + straps + pull-ups present", False, True),
    ("assemble open-frame system", "hand tools", "assembly checklist", False, True),
    ("verify card orientation", "visual", "pin-1 photo evidence", False, True),
    ("verify I2C pull-up configuration", "checker + visual",
     "effective-pullup classification = ok", False, True),
    ("power system current-limited", "bench PSU", "no unexpected draw", False, False),
    ("enumerate boards by slot", "service laptop", "0x50-0x55 as installed", False, False),
    ("safety-line validation", "DMM", "interlock/fault/reset/trig continuity", True, False),
    ("relay validation", "DMM", "safe default + route/disconnect", True, False),
    ("calibration/reference sanity", "DMM optional", "REF_OUT + ADC readback "
     "(sanity only, no cal claim)", True, False),
    ("power/current monitor sanity", "PSU + DMM", "V/I sense sanity", True, False),
    ("EII loopback", "loopback plug", "TTL loopback pass", False, False),
    ("digital bring-up loopback", "loopback plugs", "UART/I2C/SPI/GPIO", False, False),
    ("mock DUT workflow", "none", "end-to-end mock evidence (SIMULATED class)", False, False),
    ("record system evidence package", "none", "ledger complete + system serial", False, True),
]
_w("fl1-assembly-test-flow", {
    "version": "v1", "steps": [
        {"n": i + 1, "step": s, "tools": t, "evidence": e,
         "cots_identity_required": ci, "human_inspection_required": hi,
         "failure_classification": "per yield/failure tracking model"}
        for i, (s, t, e, ci, hi) in enumerate(FLOW)]})

# ---- Phase 9: yield/failure tracking -------------------------------------------
_w("fl1-yield-failure-tracking-model", {
    "version": "v1",
    "record_fields": ["board_serial", "system_serial", "board_type", "revision",
                      "supplier", "lot", "assembly_result", "inspection_result",
                      "bringup_result", "validation_result", "failure_class",
                      "root_cause_hypothesis", "rework_action",
                      "final_disposition", "evidence_links"],
    "failure_classes": ["fab_defect", "assembly_defect", "component_defect",
                        "design_defect", "handling_damage", "test_setup_error",
                        "unknown"],
    "metrics": ["board pass rate", "system pass rate", "defects by board type/"
                "supplier/component/workflow step", "rework rate", "scrap rate",
                "unknown-failure rate"],
    "state": "MODEL ONLY — no yield data exists until physical boards arrive"})

# ---- Phase 10: RevA->RevB feedback loop ----------------------------------------
_w("fl1-reva-revb-manufacturing-feedback-loop", {
    "version": "v1",
    "inputs": ["incoming inspection failures", "bring-up failures",
               "system validation failures", "supplier substitutions",
               "assembly/rework notes", "I2C measurement data",
               "connector orientation findings", "thermal observations",
               "cable/fixture issues", "technician notes"],
    "outputs": ["Rev B recommendation", "manufacturing change request",
                "component substitution request", "DNP/population update",
                "connector update", "test workflow update", "documentation update"],
    "rules": ["failed evidence preserved", "recommendations cite evidence",
              "no automatic redesign without human approval",
              "no automatic supplier substitution",
              "no automatic production release"],
    "seeded_from_phase191": ["REVB-001..005 already queued with evidence links"]})

# ---- Phase 11: production readiness dashboard ----------------------------------
state = pl.current_state()
_w("fl1-production-readiness-dashboard", {
    "version": "v1", "states": list(pl.READINESS_STATES),
    "current_state": state,
    "cap_rule": "current state must not exceed first_article_ready_for_human_"
                "approval; production_ready requires physical boards + "
                "validation evidence + yield data + human approval (enforced "
                "by production_line.readiness_state)",
    "board_readiness": {name: "review_required (all gates green, human-gated)"
                        for name, _r in BOARDS},
    "open_findings": [
        "I2C pull-up stacking: too_strong_pullup as-built (671 ohm) — visible "
        "until physical measurement and/or Rev B config clears it",
        "unkeyed connectors: review_required — visible until mitigation "
        "inspection evidence or Rev B keying"],
    "blocked_claims": ["production-ready", "I2C compliance", "connector safety "
                       "beyond mitigation", "certification/EMC/thermal/safety",
                       "production scale"],
    "human_approval_state": "PENDING — seven-board approval form v2 unsigned"})

print("BOM rollup: %d lines; per-board BOM (USD): %s" % (len(rollup), board_costs))
print("batch(3 PCBAs/board): $%.2f placeholder total" % batch(1)["total_placeholder_usd"])
print("package audit all complete_with_review:", all(
    a["classification"] == "package_complete_with_review" for a in audit))
print("readiness state:", state)
