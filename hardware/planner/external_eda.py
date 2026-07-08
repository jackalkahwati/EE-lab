"""M3B — External Open-Source Electrical EDA Evidence Layer v1.

KiCad stays the board source of truth; flroute stays the router. External
tools produce ANALYSIS EVIDENCE artifacts — or honest unavailable /
missing-model artifacts — that feed claim gates. Nothing here creates
physical evidence, overrides DRC/ERC, or upgrades a claim without the
required inputs. Availability is never correctness.
"""
import importlib
import json
import os
import re
import shutil
import subprocess

REPO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")

RESULT_STATUSES = ("not_run", "unavailable", "skipped_missing_input",
                   "failed_tool_error", "failed_model_error",
                   "completed_with_warnings", "completed", "passed_gate",
                   "failed_gate")

ANALYSIS_TYPES = (
    "spice_operating_point", "spice_transient", "spice_ac",
    "voltage_divider_check", "led_current_check", "rc_filter_response",
    "pullup_pulldown_check", "current_sense_check",
    "regulator_stability_placeholder", "impedance_estimate",
    "differential_pair_check", "reference_plane_check", "s_parameter_parse",
    "rf_network_analysis", "ibis_model_check", "high_speed_si_placeholder",
    "power_rail_inventory", "decoupling_inventory",
    "pdn_impedance_placeholder", "power_integrity_estimate",
    "field_solver_placeholder", "external_analysis_unavailable")


# ---------------------------------------------------------------------------
# Phase 1: toolchain inventory (real detection, no network)
# ---------------------------------------------------------------------------
def _module(name):
    try:
        m = importlib.import_module(name)
        return getattr(m, "__version__", "present")
    except Exception:
        return None


def inventory():
    tools = {}
    ng = shutil.which("ngspice")
    ver = None
    if ng:
        try:
            out = subprocess.run([ng, "--version"], capture_output=True,
                                 text=True, timeout=10).stdout
            m = re.search(r"ngspice-?([\w.]+)", out)
            ver = m.group(1) if m else "unknown"
        except Exception:
            ver = "unknown"
    tools["ngspice"] = {"found": bool(ng), "path": ng, "version": ver,
                        "analyses": ["spice_operating_point",
                                     "spice_transient", "spice_ac"],
                        "trust": "advisory (simulation != physical)"}
    tools["openEMS"] = {"found": bool(shutil.which("openEMS")),
                        "path": shutil.which("openEMS"),
                        "analyses": ["field_solver_placeholder"],
                        "trust": "advisory"}
    for mod, analyses in (("skrf", ["s_parameter_parse",
                                    "rf_network_analysis"]),
                          ("numpy", ["numeric support"]),
                          ("scipy", ["numeric support"]),
                          ("matplotlib", ["plot support"]),
                          ("PySpice", ["spice bridge"])):
        v = _module(mod)
        tools[mod] = {"found": v is not None, "version": v,
                      "analyses": analyses, "trust": "advisory"}
    # local evidence files
    ibs, snp = [], []
    for root, _dirs, files in os.walk(os.path.join(REPO, "hardware")):
        for f in files:
            if f.lower().endswith(".ibs"):
                ibs.append(os.path.join(root, f))
            if re.search(r"\.s\d+p$", f.lower()):
                snp.append(os.path.join(root, f))
    tools["ibis_models_local"] = {"found": bool(ibs), "files": ibs[:10]}
    tools["touchstone_files_local"] = {"found": bool(snp), "files": snp[:10]}
    tools["stackup_model_local"] = {
        "found": False,
        "note": "no board-house stackup/material data in the repo — "
                "controlled-impedance claims stay blocked"}
    return {"tools": tools,
            "rules": ["missing tool is NOT a board failure — it blocks only "
                      "related claims",
                      "availability is not proof of analysis correctness"]}


# ---------------------------------------------------------------------------
# Phase 2: evidence schema
# ---------------------------------------------------------------------------
REQUIRED_FIELDS = ("analysis_id", "board_id", "run_id", "tool_name",
                   "tool_availability", "analysis_type", "input_artifacts",
                   "output_artifacts", "result_status", "assumptions",
                   "blocked_claims")


def make_artifact(**kw):
    """Validate + normalize one analysis evidence artifact."""
    problems = [f for f in REQUIRED_FIELDS if kw.get(f) is None]
    if kw.get("result_status") not in RESULT_STATUSES:
        problems.append("invalid result_status")
    if kw.get("analysis_type") not in ANALYSIS_TYPES:
        problems.append("invalid analysis_type")
    for res in kw.get("computed_results", []) or []:
        if res.get("value") is not None and not res.get("units"):
            problems.append("numeric result without units: %s" % res)
    if kw.get("result_status") in ("passed_gate", "failed_gate"):
        th = kw.get("thresholds")
        if not th:
            problems.append("gate result without thresholds")
        elif not kw.get("threshold_provenance"):
            problems.append("thresholds without provenance")
    if problems:
        return None, problems
    kw.setdefault("honesty", "simulation/analysis is NOT physical evidence")
    return kw, []


# ---------------------------------------------------------------------------
# Phase 3: claim gates
# ---------------------------------------------------------------------------
CLAIM_GATES = {
    "controlled_impedance_claim": {
        "requires": ["stackup + material data", "impedance_estimate or "
                     "field solver", "fab stackup/coupon evidence"],
        "state": "blocked — no stackup/material data in repo"},
    "differential_pair_quality_claim": {
        "requires": ["pair geometry", "impedance evidence",
                     "length-matching analysis"],
        "state": "blocked"},
    "high_speed_signal_integrity_claim": {
        "requires": ["IBIS/behavioral models", "constraints",
                     "external SI analysis"],
        "state": "blocked — no IBIS models found"},
    "power_integrity_claim": {
        "requires": ["load currents", "capacitor models",
                     "PDN analysis", "measurement for strong claims"],
        "state": "blocked — load currents unknown"},
    "rf_performance_claim": {
        "requires": ["RF model/simulation (openEMS or measured "
                     "S-parameters)", "measurement"],
        "state": "blocked — no models, no measurements"},
    "antenna_performance_claim": {
        "requires": ["field solver or chamber measurement"],
        "state": "blocked"},
    "regulator_stability_claim": {
        "requires": ["regulator SPICE/loop model", "or bench evidence"],
        "state": "blocked — no regulator models"},
    "analog_filter_response_claim": {
        "requires": ["RC-only ideal analysis (advisory) or SPICE with "
                     "models", "measurement for accuracy"],
        "state": "advisory_possible (ideal RC only)"},
    "current_measurement_accuracy_claim": {
        "requires": ["shunt tolerance + reference + CALIBRATION evidence"],
        "state": "blocked — calibration requires physical references"},
    "calibration_claim": {
        "requires": ["physical reference measurements"],
        "state": "blocked — structurally physical"},
    "EMC_claim": {
        "requires": ["lab measurement"],
        "state": "blocked — structurally physical"},
}


def gate(claim, evidence_present=None):
    g = CLAIM_GATES.get(claim)
    if g is None:
        return {"claim": claim, "state": "unknown_claim_blocked"}
    ev = evidence_present or {}
    missing = [r for r in g["requires"] if not ev.get(r)]
    return {"claim": claim, "requires": g["requires"], "missing": missing,
            "state": "evidence_review_required" if not missing
                     else "blocked",
            "note": "no external analysis bypasses DRC/ERC, creates "
                    "physical evidence, or reaches production_ready"}


# ---------------------------------------------------------------------------
# Phase 4: SPICE — real netlist generation; honest unavailability
# ---------------------------------------------------------------------------
def spice_divider_netlist(vin, r_top, r_bot):
    return ("* Compose M3B divider check (ideal R only)\n"
            "V1 in 0 DC %g\nR1 in out %g\nR2 out 0 %g\n"
            ".op\n.end\n" % (vin, r_top, r_bot))


def run_spice(netlist_text, workdir, tag):
    """Run ngspice if present; otherwise an honest 'unavailable' artifact.
    The netlist is REAL either way and preserved as an input artifact."""
    os.makedirs(workdir, exist_ok=True)
    cir = os.path.join(workdir, tag + ".cir")
    open(cir, "w").write(netlist_text)
    ng = shutil.which("ngspice")
    if not ng:
        return {"result_status": "unavailable", "input_artifacts": [cir],
                "output_artifacts": [],
                "note": "ngspice not installed — netlist generated and "
                        "preserved; analysis awaits the tool"}
    out = os.path.join(workdir, tag + ".out")
    p = subprocess.run([ng, "-b", "-o", out, cir], capture_output=True,
                       text=True, timeout=60)
    if p.returncode != 0:
        return {"result_status": "failed_tool_error",
                "input_artifacts": [cir], "output_artifacts": [out],
                "stderr_tail": p.stderr[-300:]}
    return {"result_status": "completed", "input_artifacts": [cir],
            "output_artifacts": [out]}


def analytic_divider(vin, r_top, r_bot):
    """Ideal-R advisory computation (allowed: resistor-only, ideal parts).
    Advisory only; never a calibration/accuracy claim."""
    vout = vin * r_bot / (r_top + r_bot)
    return {"computed_results": [
        {"name": "Vout", "value": round(vout, 4), "units": "V"},
        {"name": "Idiv", "value": round(vin / (r_top + r_bot) * 1000, 4),
         "units": "mA"}],
        "assumptions": ["ideal resistors", "no load", "nominal values — "
                        "no tolerance analysis"],
        "trust": "advisory-analytic (not SPICE, not measurement)"}


# ---------------------------------------------------------------------------
# Phase 5: impedance estimator — gated on stackup
# ---------------------------------------------------------------------------
def microstrip_z0(w_mm, h_mm, er, t_mm=0.035):
    """IPC-2141-style microstrip estimate. ADVISORY ONLY; requires a real
    stackup dict to be used for any report."""
    import math
    w, h, t = w_mm, h_mm, t_mm
    weff = w + (t / math.pi) * (1 + math.log(2 * h / t))
    z0 = (87.0 / math.sqrt(er + 1.41)) * math.log(5.98 * h /
                                                  (0.8 * weff + t))
    return round(z0, 1)


def impedance_report(stackup=None, w_mm=0.2):
    if not stackup or not all(k in stackup for k in
                              ("dielectric_h_mm", "er", "source")):
        return {"result_status": "skipped_missing_input",
                "analysis_type": "impedance_estimate",
                "missing": ["stackup (dielectric height, er, SOURCE)"],
                "blocked_claims": ["controlled_impedance_claim",
                                   "differential_pair_quality_claim"],
                "note": "no stackup/material data — estimate refused rather "
                        "than assumed"}
    z0 = microstrip_z0(w_mm, stackup["dielectric_h_mm"], stackup["er"])
    return {"result_status": "completed",
            "analysis_type": "impedance_estimate",
            "computed_results": [{"name": "Z0_microstrip", "value": z0,
                                  "units": "ohm"}],
            "assumptions": ["IPC-2141 closed-form — advisory only",
                            "stackup source: %s" % stackup["source"]],
            "blocked_claims": ["controlled_impedance_claim (needs fab "
                               "stackup + coupon)", "RF/high-speed "
                               "correctness"]}


# ---------------------------------------------------------------------------
# Phase 8: PDN — REAL rail/decoupling inventory from board files
# ---------------------------------------------------------------------------
def pdn_inventory(board_path):
    """Parse a real .kicad_pcb: power rails and decoupling caps per rail."""
    t = open(board_path).read()
    rails = {}
    for rail in ("+5V", "+3V3", "RP_DVDD", "VBAT_RAIL", "AVDD_RAIL",
                 "VREF_RAIL", "VCCB_RAIL"):
        if '"%s"' % rail in t:
            rails[rail] = {"present": True, "decoupling_caps": 0}
    for m in re.finditer(
            r'\(property "Reference" "(C\d+)"[\s\S]{0,4000}?\(net \d+ "([^"]+)"\)',
            t):
        ref, net = m.groups()
        if net in rails:
            rails[net]["decoupling_caps"] += 1
    return {"analysis_type": "power_rail_inventory", "rails": rails,
            "result_status": "completed",
            "missing_for_PI": ["load currents (NOT in any artifact)",
                               "capacitor ESL/ESR models",
                               "physical measurement"],
            "blocked_claims": ["power_integrity_claim",
                               "pdn_impedance (placeholder only)"],
            "note": "decoupling PRESENT is not power integrity PROVEN"}


# ---------------------------------------------------------------------------
# Phase 9: generic runner
# ---------------------------------------------------------------------------
def runner(mode, board_id, run_id, board_path=None, workdir=None):
    """Modes: inventory_only | advisory | gated_for_claims."""
    assert mode in ("inventory_only", "advisory", "gated_for_claims")
    inv = inventory()
    arts = []

    def emit(atype, tool, payload):
        art, problems = make_artifact(
            analysis_id="%s-%s" % (run_id, atype), board_id=board_id,
            run_id=run_id, tool_name=tool,
            tool_availability=bool((inv["tools"].get(tool) or
                                    {}).get("found")),
            analysis_type=atype,
            input_artifacts=payload.get("input_artifacts", []),
            output_artifacts=payload.get("output_artifacts", []),
            result_status=payload.get("result_status", "completed"),
            assumptions=payload.get("assumptions", []),
            computed_results=payload.get("computed_results", []),
            thresholds=payload.get("thresholds"),
            threshold_provenance=payload.get("threshold_provenance"),
            blocked_claims=payload.get("blocked_claims", []))
        arts.append(art if art else {"invalid_artifact": problems})

    if mode == "inventory_only":
        return {"mode": mode, "inventory": inv, "artifacts": [],
                "note": "no analyses executed"}
    if board_path and os.path.exists(board_path):
        emit("power_rail_inventory", "compose-analytic",
             pdn_inventory(board_path))
    emit("impedance_estimate", "compose-analytic", impedance_report(None))
    if workdir:
        sp = run_spice(spice_divider_netlist(5.0, 10000, 10000),
                       workdir, "divider")
        sp["blocked_claims"] = ["calibration_claim",
                                "current_measurement_accuracy_claim"]
        sp["assumptions"] = ["ideal components"]
        emit("spice_operating_point", "ngspice", sp)
    gates = {c: gate(c) for c in CLAIM_GATES}
    return {"mode": mode, "inventory": inv, "artifacts": arts,
            "claim_gates": gates,
            "rules": ["runner never marks physical evidence",
                      "runner never overrides DRC/ERC",
                      "missing tool blocks only related claims"]}
