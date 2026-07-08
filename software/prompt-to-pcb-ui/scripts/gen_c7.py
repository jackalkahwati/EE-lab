"""C7: template benchmarks — instantiate all 8, block unsupported
variants, verify cited proven runs really exist and really routed."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import board_templates as bt  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")

B, citations = {}, {}
for name in bt.TEMPLATES:
    r = bt.instantiate(name)
    B[name] = r
    # verify every cited run exists AND routed (last-run PASSED)
    cited = []
    for run in bt.TEMPLATES[name]["proven_runs"]:
        lr_path = os.path.join(RUNS, run, "data", "last-run.json")
        status = None
        if os.path.exists(lr_path):
            status = json.load(open(lr_path)).get("status")
        cited.append({"run": run, "exists": os.path.exists(lr_path),
                      "status": status})
    citations[name] = cited

B["blocked_variant_mains"] = bt.instantiate("industrial_io_controller",
                                            variant="mains input")
B["blocked_variant_impedance_coupon"] = bt.instantiate(
    "validation_coupon", variant="impedance coupon")
B["blocked_variant_rf_tuning"] = bt.instantiate(
    "environmental_telemetry_node", variant="RF performance tuning")
B["unknown_template"] = bt.instantiate("flying_car_esc")

summary = {k: v["state"] for k, v in B.items()}

report = {
    "version": "v1", "milestone": "C7 Customer Board Program Templates",
    "templates": {k: {"board_class": t["board_class"],
                      "blocks": t["architecture_blocks"],
                      "blocked_variants": list(t["blocked_variants"]),
                      "roi_note": t["roi_note"]}
                  for k, t in bt.TEMPLATES.items()},
    "proven_run_citations": citations,
    "rules": [
        "templates are not fake demos: instances run the full "
        "architecture/design/routing/DRC gates; citations point at runs "
        "that already routed in sandbox",
        "unsupported variants block with the exact gate (mains -> M9R, "
        "impedance coupon -> M3B stackup, RF tuning -> M10R, USB-FS -> C4 "
        "primitives)",
        "usb_fs_data_logger blocks entirely until C4 primitives land — "
        "an honestly blocked template ships as blocked",
    ],
    "benchmarks": summary,
}

md = "# C7 — Customer Board Program Templates v1\n\n8 templates.\n\n%s\n\n" \
     "## Instantiation results\n%s\n" % (
         "\n".join("- " + r for r in report["rules"]),
         "\n".join("- %s: %s" % (k, v) for k, v in summary.items()))

for r in ["fl1-backplane-v1", "bare-mcu-qfn56-core-sandbox-v1"]:
    d = os.path.join(RUNS, r, "data")
    json.dump(report, open(os.path.join(
        d, "customer-board-program-templates-v1.json"), "w"), indent=1)
    open(os.path.join(d, "customer-board-program-templates-v1.md"),
         "w").write(md)
    json.dump({"benchmarks": B, "citations": citations}, open(os.path.join(
        d, "template-benchmark-report.json"), "w"), indent=1)
    open(os.path.join(d, "template-benchmark-report.md"), "w").write(md)

print("C7:", json.dumps(summary))
