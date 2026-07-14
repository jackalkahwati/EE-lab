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

from planner import run


def main():
    prompt = " ".join(sys.argv[1:]).strip() or sys.stdin.read().strip()
    if not prompt:
        print(json.dumps({"error": "empty prompt"}))
        return
    r = run(prompt)
    # synth.py reads final_design/intent/recovery_report; honest_report +
    # overall_status ride along so the pipeline can report substitutions.
    print(json.dumps({
        "final_design": r["final_design"],
        "intent": r["intent"],
        "recovery_report": r["recovery_report"],
        "honest_report": r["honest_report"],
        "overall_status": r["overall_status"],
        "requires_approval": r.get("requires_approval", []),
    }))


if __name__ == "__main__":
    main()
