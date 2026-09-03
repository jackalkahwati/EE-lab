"""CLI bridge: turn a natural-language board prompt into the synth design JSON.

    python3 plan_cli.py "<prompt>"
    # or pipe the prompt on stdin

Runs the planner (plain-Python: intent -> resolve -> recover) and prints a JSON
object with exactly the keys synth.py consumes ({final_design, intent,
recovery_report}) plus the honest build report so the pipeline can surface every
substitution. Kept dependency-light (no KiCad/pcbnew) so /api/pipeline/run can
run it with the system python3 before handing the design to KiCad-python synth.
"""
import json
import sys

from evaluate import converge
from decompose import build_design_tree


USAGE = """usage: python3 plan_cli.py "<prompt>"        (or pipe the prompt on stdin)

Turns a natural-language board prompt into the synth design JSON: runs the
planner (intent -> resolve -> recover -> converge) and prints ONE JSON object
with {final_design, intent, recovery_report, honest_report, overall_status,
requires_approval, design_tree, checks, converged, warnings} on stdout.
An empty prompt prints {"error": "empty prompt"}.

  -h, --help   show this help and exit (not treated as a prompt)"""


def main():
    args = sys.argv[1:]
    if any(a in ("-h", "--help") for a in args):
        print(USAGE)
        return
    prompt = " ".join(args).strip() or sys.stdin.read().strip()
    if not prompt:
        print(json.dumps({"error": "empty prompt"}))
        return
    # Stage 3: converge() runs the planner, then REAL design-level evaluators
    # (mcu-fit / rail-compat / coverage / routing-risk) and a fixpoint loop; it
    # reports converged only when the real checks pass, never fakes it.
    r = converge(prompt)
    # Stage 2: the recursive subsystem tree rides alongside the flat design so the
    # pipeline can show HOW the product decomposes. synth still builds from
    # final_design; the tree is structure + rationale, it invents no parts.
    tree = build_design_tree(r["intent"], r["final_design"])
    print(json.dumps({
        "final_design": r["final_design"],
        "intent": r["intent"],
        "recovery_report": r["recovery_report"],
        "honest_report": r["honest_report"],
        "overall_status": r["overall_status"],
        "requires_approval": r.get("requires_approval", []),
        "design_tree": tree,
        "checks": r["checks"],          # Stage 3: real design verification
        "converged": r["converged"],
        "warnings": r["warnings"],
    }))


if __name__ == "__main__":
    main()
