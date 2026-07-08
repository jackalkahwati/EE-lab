"""C5: power-tree benchmarks — 10 cases."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import power_tree as pt  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")

B = {}
B["ldo_5v_to_3v3"] = pt.build_power_tree(
    [{"rail": "+5V", "entry": "USB-C power-only"}],
    [pt.ldo_rail("+3V3", "+5V", 3.3, part="AMS1117-3.3", load_ma=300)],
    protections=("fuse",))
B["buck_missing_model"] = pt.build_power_tree(
    [{"rail": "+12V", "entry": "barrel jack"}],
    [pt.buck_rail("+5V", "+12V", 5.0, part="GENERIC_BUCK", load_ma=800)])
B["rp2040_power_tree"] = pt.build_power_tree(
    [{"rail": "+5V", "entry": "USB-C power-only"}],
    [pt.ldo_rail("+3V3", "+5V", 3.3, part="AMS1117-3.3", load_ma=250)],
    protections=("fuse", "tvs"),
    mcu_domains=["DVDD_1V1_internal", "IOVDD_3V3", "USB_PHY_3V3"])
B["txb0102_multi_rail"] = pt.build_power_tree(
    [{"rail": "+3V3", "entry": "regulated"},
     {"rail": "+5V", "entry": "regulated"}],
    [], mcu_domains=["VCCA_3V3", "VCCB_5V"])
B["ds3231m_vbat"] = pt.build_power_tree(
    [{"rail": "+3V3", "entry": "regulated"},
     {"rail": "VBAT_RAIL", "entry": "coin cell (2.3-5.5V candidate "
                                    "evidence)"}], [])
B["power_entry_protection"] = pt.build_power_tree(
    [{"rail": "+5V", "entry": "header"}],
    [], protections=("fuse", "reverse_polarity", "tvs"))
B["current_sense_fixture"] = pt.build_power_tree(
    [{"rail": "+5V", "entry": "header"}],
    [], protections=("current_sense",))
B["motor_board"] = pt.motor_request()
B["mains_board"] = pt.mains_request(230)
B["regulator_stability_gate"] = {
    "state": B["ldo_5v_to_3v3"]["claim_gates"]["regulator_stability_claim"],
    "note": "blocked without a regulator model — M3B gate consulted live"}

summary = {}
for k, v in B.items():
    if "rails" in v:
        summary[k] = {"rails": len(v["rails"]),
                      "gates": v["claim_gates"],
                      "protections": [p["kind"] for p in v["protections"]]}
    else:
        summary[k] = {"state": v.get("state")}

report = {
    "version": "v1", "milestone": "C5 Low/Moderate Power-Tree Synthesis",
    "scope": "input rails, LDO rails, evidence-gated buck ARCHITECTURE, "
             "protection primitives, current-sense hooks, test points, "
             "dependency graph — NO motor stages, NO mains, NO "
             "high-current gate-driver stages",
    "rules": [
        "rails are explicit and never merged silently (collision refused)",
        "regulator application values are evidence-gated (C2); buck stays "
        "architecture_only with a missing-model report otherwise",
        "trace widths are IPC-2221 ESTIMATES (M9), review-required",
        "PI/regulator-stability/current/thermal claims blocked via live "
        "M3B/M9 gates",
        "motor + mains remain blocked (M9R unchanged)",
    ],
    "benchmarks": summary,
}

md = "# C5 — Low/Moderate Power-Tree Synthesis v1\n\n%s\n\n## Benchmarks\n%s\n" % (
    "\n".join("- " + r for r in report["rules"]),
    "\n".join("- %s: %s" % (k, json.dumps(v)) for k, v in summary.items()))

for r in ["fl1-backplane-v1", "bare-mcu-qfn56-core-sandbox-v1"]:
    d = os.path.join(RUNS, r, "data")
    json.dump(report, open(os.path.join(
        d, "low-moderate-power-tree-synthesis-v1.json"), "w"), indent=1)
    open(os.path.join(d, "low-moderate-power-tree-synthesis-v1.md"),
         "w").write(md)
    json.dump({"benchmarks": B}, open(os.path.join(
        d, "power-tree-benchmark-report.json"), "w"), indent=1)
    open(os.path.join(d, "power-tree-benchmark-report.md"), "w").write(md)

print("C5:", json.dumps(summary)[:400])
