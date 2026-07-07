"""Generate the Phase 15 build-policy / order / manufacturing artifacts.

Attempted Batch 1 (core, real routed boards) + held boards (from Phase 13/14
evidence). Decides package type + order recommendation per board, validates the
order pack for order-ready boards, maps adapters, and runs the mock demos.

  gen_phase15.py <primary_run_data_dir>
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import build_policy as bp   # noqa: E402
import fl1_core as fc       # noqa: E402
import validation as va     # noqa: E402
import instruments as ins   # noqa: E402

RUNS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "runs")
data_dir = sys.argv[1]
core = fc.core_v1()


def _assembly_ready(run_id):
    p = os.path.join(RUNS, run_id, "data", "assembly-readiness.json")
    if os.path.exists(p):
        ar = json.load(open(p))
        return ar.get("ready_for_assembly", False), not ar.get("missing_parts") and not ar.get("unavailable_parts")
    return False, False


# ---- Batch 1 attempted boards: real build results ----
attempted = []
for b in core["boards"]:
    ar, sourced = _assembly_ready(b["run_id"])
    r = b["build_result"]
    attempted.append({"board": b["id"], "board_class": b["name"], "run_id": b["run_id"],
                      "provides_capabilities": b["provides_capabilities"],
                      "evidence": {"build_recommendation": r["build_recommendation"],
                                   "routes_clean": r["routes_clean"], "drc_violations": r["drc_violations"],
                                   "assembly_ready": ar, "sourced": sourced, "attempted": True,
                                   "validation_readiness_status": "validation_ready_with_cots"}})

# ---- held / optional boards: from Phase 13 build-readiness (honest, not overridden) ----
brd = json.load(open(os.path.join(data_dir, "fl1-build-readiness-dashboard.json"))) \
    if os.path.exists(os.path.join(data_dir, "fl1-build-readiness-dashboard.json")) else {"boards": []}
core_ids = {b["id"] for b in core["boards"]}
NAMEMAP = {"controller_backplane": "controller_backplane"}
held = []
for b in brd.get("boards", []):
    name = b["board"]
    if name in core_ids or name == "controller_backplane":
        continue
    ev = {"build_recommendation": b["recommendation"],
          "routes_clean": False, "drc_violations": 1,
          "attempted": name == "calibration_reference",
          "exact_blockers": b.get("exact_blockers", [])[:2],
          "validation_readiness_status": None}
    # Phase 16.5: the cal board has a REAL build result — read it instead of the
    # held-board defaults, so a physical pass flows through the policy honestly.
    if name == "calibration_reference":
        att_p = os.path.join(data_dir, "cal-board-attempt.json")
        if os.path.exists(att_p):
            att = json.load(open(att_p))
            if att.get("outcome") == "A_physical_pass":
                ev.update({"routes_clean": True, "drc_violations": 0,
                           "assembly_ready": True, "sourced": True,
                           "exact_blockers": []})
    held.append({"board": name, "board_class": b.get("board_class"), "evidence": ev})

# ---- build policy per board ----
policies = [bp.build_policy(x["board"], x["evidence"]) for x in attempted + held]

# ---- order-pack validation for order-ready attempted boards ----
order_packs = {}
for x in attempted:
    pol = next(p for p in policies if p["board"] == x["board"])
    if pol["allowed_to_generate_order_package"]:
        order_packs[x["board"]] = bp.order_pack_validation(os.path.join(RUNS, x["run_id"], "data"))

# ---- adapter mapping for attempted boards ----
mappings = [bp.adapter_mapping(x["board"], x["provides_capabilities"]) for x in attempted]

# ---- mock demo runs for attempted boards ----
core_br = {"boards": [{"board": b["id"], "recommendation": b["build_result"]["build_recommendation"]}
                      for b in core["boards"]]}
wt = va.fl1_workflow_templates(core_br)
wfs = {w["target_board"]: w for w in wt["workflows"]}
mock = ins.MockAdapter()
demos = [va.run_workflow(wfs[x["board"]], mock, "p15-" + x["board"])
         for x in attempted if x["board"] in wfs]

# ---- Phase 15 board readiness dashboard ----
dashboard = []
for x in attempted + held:
    pol = next(p for p in policies if p["board"] == x["board"])
    op = order_packs.get(x["board"])
    dashboard.append({
        "board": x["board"], "board_class": x.get("board_class"),
        "attempted": pol["allowed_to_attempt_board"],
        "build_policy": pol["order_recommendation"],
        "package_type": pol["package_type"],
        "order_recommendation": pol["order_recommendation"],
        "human_review_required": pol["required_human_review"],
        "order_pack_valid": op["order_pack_valid"] if op else None,
        "physical_validation_blocked": pol["physical_validation_blocked"],
        "exact_blockers": pol["exact_blockers"],
        "held_reason": (pol["exact_blockers"][0] if pol["physical_validation_blocked"]
                        and pol["exact_blockers"] else
                        ("do_not_build / unsupported" if pol["physical_validation_blocked"] else None)),
    })


def _w(name, obj, md=None):
    for d in [data_dir] + [os.path.join(RUNS, b["run_id"], "data") for b in core["boards"]]:
        os.makedirs(d, exist_ok=True)
        json.dump(obj, open(os.path.join(d, name + ".json"), "w"), indent=1)
        if md:
            open(os.path.join(d, name + ".md"), "w").write(md)


_w("phase15-build-policy-report", {"version": "v1", "boards": policies})
_w("phase15-package-policy", bp.package_policy())
_w("phase15-board-readiness-dashboard", {"version": "v1", "board_count": len(dashboard), "boards": dashboard})
_w("manufacturing-order-pack-validation", {"version": "v1", "boards": order_packs})
_w("phase15-adapter-mapping", {"version": "v1", "mappings": mappings})
_w("phase15-demo-validation-runs", {"version": "v1", "run_count": len(demos), "runs": demos})

print("Phase 15 policy: %d attempted, %d held" % (len(attempted), len(held)))
for d in dashboard:
    print("  %-28s %-30s pkg=%-24s review=%s" % (d["board"], d["order_recommendation"],
          d["package_type"], d["human_review_required"]))
