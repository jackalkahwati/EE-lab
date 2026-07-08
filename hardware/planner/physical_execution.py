"""M3 — Physical First Article Execution v1.

The executor that walks the physical path as far as REAL artifacts allow and
not one step further. It scans the board run for human signatures
(order-approval checklist) and evidence files (data/evidence/*.json),
ingests them through the Phase 23.6 schema, advances the state machine only
where approval/evidence permits, and runs the promotion gate only on real
evidence. With nothing present it reports the exact pending state — it
cannot sign, submit, order, or spend.
"""
import json
import os

import physical_evidence as pv


def _load(path):
    return json.load(open(path)) if os.path.exists(path) else None


def execute(run_dir):
    d = os.path.join(run_dir, "data")
    checklist = _load(os.path.join(
        d, "power-entry-header-v1-order-approval-checklist.json")) or {}
    gates = {g["gate"]: g for g in checklist.get("gates", [])}
    quote_ok = bool(gates.get("APPROVED_FOR_QUOTE", {}).get("signed"))
    order_ok = bool(gates.get("APPROVED_FOR_ORDER", {}).get("signed"))

    # evidence files: anything a human dropped into data/evidence/
    ev_dir = os.path.join(d, "evidence")
    artifacts, rejected = [], []
    if os.path.isdir(ev_dir):
        for fn in sorted(os.listdir(ev_dir)):
            if not fn.endswith(".json"):
                continue
            art = _load(os.path.join(ev_dir, fn))
            ok, problems = pv.validate_artifact(art or {})
            if ok and not (art or {}).get("simulated"):
                artifacts.append({"file": fn, **art})
            else:
                rejected.append({"file": fn, "problems": problems or
                                 ["simulated evidence refused"]})

    # walk the state machine as far as reality allows
    state = "package_ready_with_review"
    log = []
    if quote_ok:
        state, why = pv.advance(state, "human_approved_for_quote",
                                human_approval=True)
        log.append(why)
    by_type = {}
    for a in artifacts:
        by_type.setdefault(a.get("artifact_type"), []).append(a)
    if quote_ok and "fab_quote" in by_type:
        state = "quote_received"
        log.append("quote evidence ingested")
    if order_ok and "order_confirmation" in by_type:
        state, why = pv.advance("quote_received", "human_approved_for_order",
                                human_approval=True)
        state = "ordered"
        log.append("order evidence ingested (human-approved)")
    if "received_photos" in by_type:
        state, why = pv.advance(state, "received",
                                evidence={"real": True})
        log.append(why)

    # promotion gate ONLY on real measurement evidence
    meas = {k: {"pass": a[0].get("pass_fail") == "pass",
                "has_measurement": a[0].get("measurement_value") is not None,
                "units": a[0].get("units")}
            for k, a in by_type.items() if k.endswith("_readings")}
    gate_ok, gate_problems = (False, ["no electrical evidence ingested"])
    if meas and "visual_inspection_checklist" in by_type:
        # map to the required evidence set only when the pieces exist
        gate_ok, gate_problems = pv.promotion_gate({})  # full set still absent

    if not quote_ok:
        next_action = ("HUMAN: sign APPROVED_FOR_QUOTE in the order-approval "
                       "checklist, then upload the fab quote to data/evidence/")
    elif not order_ok:
        next_action = ("HUMAN: review quote evidence, sign APPROVED_FOR_ORDER; "
                       "Compose will not submit or spend")
    elif "received_photos" not in by_type:
        next_action = "HUMAN: upload receipt photos + inspection checklist"
    else:
        next_action = "HUMAN: run the 15-step validation workflow, upload readings"

    return {"state": state, "quote_signed": quote_ok, "order_signed": order_ok,
            "artifacts_ingested": len(artifacts), "artifacts_rejected": rejected,
            "promotion": "blocked_on_physical_evidence" if not gate_ok else
                         "eligible_for_gate_review",
            "gate_problems": gate_problems, "log": log,
            "next_action": next_action,
            "prohibitions": ["no auto-submit", "no auto-order", "no spend",
                             "no fake evidence", "no simulated ingestion"]}
