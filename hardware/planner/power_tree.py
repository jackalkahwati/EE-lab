"""C5 — Low/Moderate Power-Tree Synthesis v1.

Explicit board-level power trees for the majority envelope: input rails,
LDO-generated rails, cautious buck ARCHITECTURE (evidence-gated), fuses /
reverse-polarity / TVS placeholders, current-sense hooks, enable /
power-good pins, test points, a dependency graph, and sequencing notes
when evidence exists. Every electrical claim rides the M3B/M9 gates:
regulator application circuits without datasheet evidence are BLOCKED,
PI/current/thermal/stability claims stay blocked, motor stages and mains
remain blocked (M9R unchanged). Rails are never merged silently.
"""
import datasheet_ingest_v2 as dv2
import external_eda as ee
import power_stage as ps

BLOCKED_ALWAYS = ["power_integrity_claim", "regulator_stability_claim",
                  "current_capacity_guarantee", "thermal_safety",
                  "efficiency_claim"]


def ldo_rail(name, vin_rail, vout, part=None, load_ma=None):
    """LDO-generated rail. Application circuit values are evidence-gated;
    the STRUCTURE (cin/cout/enable) is standard and review-required."""
    ev = dv2.support_value_v2(part or "UNKNOWN",
                              "regulator_application_circuit")
    app = ("evidence_backed" if ev["state"].startswith("evidence_verified")
           else "review_required — no application-circuit evidence for %s; "
                "cin/cout values are placeholders" % (part or "part"))
    return {
        "rail": name, "source": "ldo", "part": part,
        "vin_rail": vin_rail, "vout": vout,
        "estimated_load_ma": load_ma,
        "application_circuit": app,
        "components": {"cin": "placeholder (review)",
                       "cout": "placeholder (review)",
                       "enable": "tie per datasheet evidence or review",
                       "power_good": "route to MCU GPIO if pin exists"},
        "placement_hints": ["bulk_near_entry (C1)",
                            "decoupling_near_ic (C1)"],
        "state": "synthesized_review_required",
    }


def buck_rail(name, vin_rail, vout, part=None, load_ma=None):
    """Buck ARCHITECTURE only unless datasheet evidence exists for the
    inductor/caps/compensation — honest missing-model report otherwise."""
    needed = ["regulator_application_circuit",
              "inductor_capacitor_requirements", "switching_frequency",
              "compensation_requirements"]
    evs = {k: dv2.support_value_v2(part or "UNKNOWN", k) for k in needed}
    missing = [k for k, v in evs.items()
               if not v["state"].startswith("evidence_verified")]
    rail = {
        "rail": name, "source": "buck", "part": part,
        "vin_rail": vin_rail, "vout": vout,
        "estimated_load_ma": load_ma,
        "feedback_divider": "computable from Vref formula once the part's "
                            "Vref is evidence-backed — advisory math only",
        "placement_hints": ["buck_hot_loop grouped (C1)",
                            "switch node marked NOISY (C1)",
                            "keep ADC/reference outside noisy radius"],
        "blocked_claims": list(BLOCKED_ALWAYS),
    }
    if missing:
        rail["state"] = "architecture_only"
        rail["missing_model_report"] = {
            "missing_evidence": missing,
            "note": "buck stays ARCHITECTURE ONLY without datasheet "
                    "evidence — values are never guessed"}
    else:
        rail["state"] = "synthesized_review_required"
    return rail


def protection(kind, evidence_part=None):
    KINDS = {
        "fuse": "polyfuse/fuse primitive — rating requires load evidence",
        "reverse_polarity": "P-FET or diode primitive — part selection "
                            "review-required",
        "tvs": "TVS/ESD placeholder — clamping voltage needs evidence",
        "current_sense": "shunt + Kelvin intent (C1) — accuracy claims "
                         "blocked without calibration evidence",
    }
    if kind not in KINDS:
        return {"error": "unknown protection kind %s" % kind}
    return {"kind": kind, "detail": KINDS[kind],
            "state": "candidate_review_required"}


def build_power_tree(input_rails, generated, protections=(),
                     mcu_domains=None):
    """Assemble the tree + dependency graph. Rails are distinct nodes —
    merging requires an explicit reviewer decision (never automatic)."""
    rails = {r["rail"]: {"type": "input", **r} for r in input_rails}
    deps = {}
    for g in generated:
        if g["rail"] in rails:
            return {"error": "rail name collision %s — rails are never "
                             "merged silently" % g["rail"]}
        rails[g["rail"]] = g
        deps[g["rail"]] = [g["vin_rail"]]
    for d in (mcu_domains or []):
        if d not in rails:
            rails[d] = {"rail": d, "type": "mcu_internal_domain",
                        "state": "documented (RP2040-class internal LDO — "
                                 "candidate evidence)"}
    widths = {name: ps.trace_width_estimate(
        (r.get("estimated_load_ma") or 100) / 1000.0)
        for name, r in rails.items() if r.get("estimated_load_ma")}
    seq = dv2.support_value_v2("RP2040", "power_sequencing")
    tree = {
        "rails": rails,
        "dependency_graph": deps,
        "protections": [protection(p) for p in protections],
        "test_points": ["per rail: voltage test point (C1 "
                        "testpoint_accessible)"],
        "current_width_advisory": widths,
        "sequencing_notes": (seq["normalized_requirement"]
                             if seq["value"] or seq.get(
                                 "normalized_requirement")
                             else "no sequencing evidence — review-required"),
        "claim_gates": {c: ee.gate(c)["state"] for c in
                        ("power_integrity_claim",
                         "regulator_stability_claim")},
        "blocked_claims": list(BLOCKED_ALWAYS),
        "honesty": "rails explicit, never merged silently; regulator "
                   "values evidence-gated; widths are IPC-2221 ESTIMATES "
                   "(M9); no PI/thermal/stability/capacity claim",
    }
    return tree


def motor_request():
    return {"state": "blocked", "gate": ps.power_stage_gate({}),
            "note": "high-current motor stages remain blocked (M9R)"}


def mains_request(voltage=230):
    return {"state": "blocked", "gate": ps.mains_gate(voltage)}
