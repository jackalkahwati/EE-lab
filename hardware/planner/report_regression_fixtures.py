"""Small source-only fixtures for the C2, signoff, validation, M3 and M9-M12 tests.

Call only inside regression_support.regression_snapshot. These are policy tests,
not reconstructions or certifications of historical boards. Seed JSON is INPUT
state; report JSON is written by the actual versioned producer scripts. In
particular we never seed board/DRC/router reports or a fine-grid pass report.
"""
import json
import subprocess
import sys

from regression_support import require_snapshot


_PROVENANCE = {
    "fixture_kind": "synthetic_policy_input",
    "historical_run_evidence": False,
    "physical_evidence": False,
    "scope": "report and policy contracts only; no routing or fabrication claim",
}


def _input(path, value):
    """Write explicit initial state, never a substitute generated report."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({**value, "_fixture_provenance": _PROVENANCE}, indent=2))


def _generate(root, script, *args):
    scripts = root / "software/prompt-to-pcb-ui/scripts"
    subprocess.run([sys.executable, str(scripts / script), *map(str, args)],
                   cwd=root, check=True, timeout=120)


def _legacy_targets(root, *names):
    # Legacy producers choose these names themselves. The paths exist only in
    # the disposable snapshot, never the checkout's private public/runs link.
    runs = root / "software/prompt-to-pcb-ui/public/runs"
    for name in names:
        (runs / name / "data").mkdir(parents=True, exist_ok=True)
    return runs


def c2_artifacts():
    root = require_snapshot()
    runs = _legacy_targets(root, "fl1-backplane-v1", "bare-mcu-qfn56-core-sandbox-v1")
    # Explicit source inputs: gen_c2.SEED (unverified candidates) and BENCH.
    # The script ingests them into a fresh DB, then calls dv2.support_value_v2
    # and dv2.part_report. Its DB rewrite is confined to the copied planner.
    _generate(root, "gen_c2.py")
    return runs / "fl1-backplane-v1/data"


def policy_artifacts(*, fixed, validation=False):
    root = require_snapshot()
    case = "synthetic-fixed-policy" if fixed else "synthetic-blocked-policy"
    data = root / "regression-cases" / case / "data"
    # Explicit predicate inputs, NOT measured or routed outputs. A single
    # hypothetical violation deliberately avoids the historical default of 13.
    _input(data / "cal-board-attempt.json", {
        "drc_violations": 0 if fixed else 1,
        "fine_pitch_escape": {
            "result": "escaped_and_checked" if fixed else "escaped_but_drc_failed",
            "exact_blocker": None if fixed else "blocked_by_grid_resolution",
        },
    })
    _input(data / "shared-bus-report.json", {
        "buses": [{"routing_status": "connected" if fixed else "disconnected"}],
    })
    # gen_benchmark_signoff still contains legacy hardcoded non-calibration
    # assumptions. Its output tests report/scoring behavior, not their truth.
    _generate(root, "gen_benchmark_signoff.py", data)
    if validation:
        # Consume the dashboard actually produced above, never a seeded verdict.
        _generate(root, "gen_instrument_validation.py", data)
    return data


def historical_calibration_artifacts():
    """Reserved for genuine producer outputs, never populated from policy seeds.

    The snapshot deliberately has no historical run artifacts. This named root
    keeps historical linkage checks independent of the synthetic policy cases;
    an eventual real reconstruction must place its producer outputs here.
    """
    return require_snapshot() / "regression-cases/historical-calibration/data"


def finegrid_policy_input(*, fixed):
    """Conditional selector only: never written as a router/fine-grid report."""
    return {"outcome": "A_physical_pass" if fixed else "B_honest_fail",
            "_fixture_provenance": dict(_PROVENANCE)}


def m3_artifacts():
    root = require_snapshot()
    runs = _legacy_targets(root, "power-entry-header-2l", "fl1-backplane-v1")
    run = runs / "power-entry-header-2l"
    data = run / "data"
    # These are the executor's unsigned/empty INITIAL state. No quote, order,
    # receipt, reading or passing physical evidence is manufactured.
    _input(data / "power-entry-header-v1-order-approval-checklist.json", {
        "version": "v1", "gates": [
            {"gate": "APPROVED_FOR_QUOTE", "signed": None, "date": None},
            {"gate": "APPROVED_FOR_ORDER", "signed": None, "date": None},
        ], "auto_submit": False, "auto_order": False,
    })
    _input(data / "compose-physical-evidence-ledger.json", {
        "version": "v1", "artifacts": [], "human_approvals": [],
        "order_status": "not_ordered",
    })
    (data / "evidence").mkdir(exist_ok=True)
    _generate(root, "gen_m3.py")
    return run


def m9_m12_artifacts():
    root = require_snapshot()
    runs = _legacy_targets(root, "fl1-backplane-v1", "bare-mcu-qfn56-core-sandbox-v1")
    # Inputs are the script's explicit current, voltage and request examples;
    # every output is generated by the production rule/gate functions.
    _generate(root, "gen_m9_m12.py")
    return runs / "fl1-backplane-v1/data"
