"""M3: physical first article execution — honest pending state."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import physical_execution as px  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")
RUN = os.path.join(RUNS, "power-entry-header-2l")

result = px.execute(RUN)
out = {"version": "v1", "milestone": "M3 Physical First Article Execution",
       "board": "power-entry-header-2l", **result,
       "honesty": "no human signature exists, so the executor stopped at "
                  "package_ready_with_review — machinery armed, nothing faked"}
for r in ["fl1-backplane-v1", "power-entry-header-2l"]:
    d = os.path.join(RUNS, r, "data")
    json.dump(out, open(os.path.join(
        d, "compose-m3-physical-execution-report.json"), "w"), indent=1)

print("state:", result["state"], "| ingested:", result["artifacts_ingested"])
print("next action:", result["next_action"])
