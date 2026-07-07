"""Phase 15.6: role-completeness + first-article review v2 for the regenerated
Batch 1 boards. Consumes the REAL pipeline outputs (board file, devices manifest,
DRC, assembly readiness) — order recommendations only for boards that are BOTH
gate-clean and role-complete.

  gen_role_review.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import role_completeness as rc   # noqa: E402
import build_policy as bp        # noqa: E402

RUNS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "runs")

BOARDS = [
    ("controller_backplane", "fl1-core-controller-v2", "FL-1 Controller / Backplane v2"),
    ("digital_bringup", "fl1-core-digital-v2", "FL-1 Digital Bring-up v2"),
    ("relay_probe_matrix", "fl1-core-relay-v2", "FL-1 Relay / Probe Matrix v2"),
]

review = {"version": "v2", "review_type": "first_article_order_review_v2", "boards": []}
for role, run_id, cls in BOARDS:
    base = os.path.join(RUNS, run_id)
    d = os.path.join(base, "data")
    board_text = open(os.path.join(base, "variant.kicad_pcb")).read()
    devices = json.load(open(os.path.join(d, "devices.json")))
    lr = json.load(open(os.path.join(d, "last-run.json")))
    bjson = json.load(open(os.path.join(d, "board.json")))
    drc = json.load(open(os.path.join(d, "drc.json"))) if os.path.exists(os.path.join(d, "drc.json")) else {}
    viol = len([v for v in (drc.get("violations") or []) if v.get("type") != "solder_mask_bridge"])
    unconn = len(drc.get("unconnected_items") or [])

    # role-completeness (the new gate)
    role_rep = rc.check_role(role, board_text, devices)
    json.dump(role_rep, open(os.path.join(d, "role-completeness-report.json"), "w"), indent=1)
    open(os.path.join(d, "role-completeness-report.md"), "w").write(
        "# Role completeness — %s\n\nStatus: **%s** (%d/%d)\n\nMissing:\n%s\n\nCaveats:\n%s\n"
        % (cls, role_rep["status"], role_rep["requirements_met"], role_rep["requirements_checked"],
           "\n".join("- " + m for m in role_rep["missing"]) or "- none",
           "\n".join("- " + c for c in role_rep["caveats"]) or "- none"))

    # order pack validation (v2)
    pack = bp.order_pack_validation(d)
    gates_clean = lr.get("status") == "PASSED" and viol == 0 and unconn == 0
    role_ok = role_rep["status"] in ("role_complete", "role_complete_with_review")

    # the v2 rule: order recommendation ONLY if gates clean AND role complete
    if gates_clean and role_ok and pack["order_pack_valid"]:
        rec = "order_3_pcba_review_required"
    elif gates_clean and not role_ok:
        rec = "revise_before_order"
    else:
        rec = "do_not_order"

    review["boards"].append({
        "board": role, "board_class": cls, "run_id": run_id,
        "routing": "%s/%s" % (bjson.get("netsRouted"), bjson.get("netsTotal")),
        "drc_violations": viol, "unconnected": unconn,
        "pipeline_status": lr.get("status"),
        "role_completeness": role_rep["status"],
        "role_missing": role_rep["missing"],
        "role_caveats": role_rep["caveats"],
        "order_pack_valid": pack["order_pack_valid"],
        "order_pack_missing": pack["missing"],
        "recommendation": rec,
        "human_review_required": True,
        "known_limitations": role_rep["caveats"],
    })

review["decision_rule"] = ("order recommendation requires: pipeline PASSED + 0 DRC + 0 unconnected "
                           "+ role_complete(_with_review) + valid order pack. DRC-clean but "
                           "role_incomplete = revise_before_order.")
all_order = all(b["recommendation"] == "order_3_pcba_review_required" for b in review["boards"])
review["batch_decision"] = ("order_3_pcba_review_required (all three)" if all_order
                            else "mixed — see per-board recommendations")

md = ["# First-Article Order Review v2 — FL-1 Batch 1 (regenerated)", "",
      "**Batch decision: %s**" % review["batch_decision"], ""]
for b in review["boards"]:
    md += ["## %s — **%s**" % (b["board_class"], b["recommendation"]),
           "- routing %s, DRC %d, unconnected %d, pipeline %s" %
           (b["routing"], b["drc_violations"], b["unconnected"], b["pipeline_status"]),
           "- role: %s%s" % (b["role_completeness"],
                             (" — missing: " + "; ".join(b["role_missing"])) if b["role_missing"] else ""),
           "- known limitations: %s" % ("; ".join(b["known_limitations"]) or "none"), ""]
md += ["## Decision rule", review["decision_rule"]]

# primitive library artifact + write everywhere relevant
prim = rc.primitive_library()
targets = [os.path.join(RUNS, r, "data") for _ro, r, _c in BOARDS] + \
          [os.path.join(RUNS, "fl1-cal-board", "data")]
for t in targets:
    os.makedirs(t, exist_ok=True)
    json.dump(review, open(os.path.join(t, "phase15-first-article-review-v2.json"), "w"), indent=1)
    open(os.path.join(t, "phase15-first-article-review-v2.md"), "w").write("\n".join(md))
    json.dump(prim, open(os.path.join(t, "fl1-board-primitive-library.json"), "w"), indent=1)
    json.dump({"version": "v2", "boards": {b["board"]: {
        "order_pack_valid": b["order_pack_valid"], "missing": b["order_pack_missing"]}
        for b in review["boards"]}},
        open(os.path.join(t, "phase15-validated-order-pack-v2.json"), "w"), indent=1)

for b in review["boards"]:
    print("%-24s role=%-28s -> %s" % (b["board"], b["role_completeness"], b["recommendation"]))
print("BATCH: %s" % review["batch_decision"])
