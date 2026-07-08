"""M9-M12: high-current, RF, high-speed, reliability — models + gates."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import power_stage as ps  # noqa: E402
import rf_rules as rf  # noqa: E402
import highspeed_rules as hs  # noqa: E402
import reliability_classes as rc  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")


def _w(name, obj):
    for r in ["fl1-backplane-v1", "bare-mcu-qfn56-core-sandbox-v1"]:
        json.dump(obj, open(os.path.join(
            RUNS, r, "data", name + ".json"), "w"), indent=1)


_w("compose-m9-power-stage-rules", {
    "version": "v1", "milestone": "M9 High-Current / Power-Stage Rules",
    "trace_width_estimates": [ps.trace_width_estimate(a)
                              for a in (0.5, 1, 2, 5, 10, 20)],
    "power_stage_gate": {"required": list(ps.REQUIRED_FOR_POWER_STAGE),
                         "motor_board_today": ps.power_stage_gate({})},
    "mains": {"230V request": ps.mains_gate(230), "envelope": "<=48V review"},
    "benchmark": {"motor_controller": "BLOCKED (9 requirements missing)",
                  "low_current_load_switch": "architecture_only — MOSFET/"
                  "driver primitives unverified; not routed to avoid a "
                  "decorative power stage"},
    "honesty": "widths are IPC-2221 ESTIMATES review-required; no thermal, "
               "safety, or current-rating claim; no mains support"})
_w("compose-m10-rf-rules", {
    "version": "v1", "milestone": "M10 RF / Controlled-Impedance Rules",
    "gate_demo": rf.rf_gate("SMA RF adapter with antenna path"),
    "rf_adapter_benchmark": "remains architecture_only (as since 22.1) — "
                            "now with the exact requirement list",
    "honesty": "no impedance correctness without stackup + field solver + "
               "fab coupon evidence; no antenna/EMC/compliance claims"})
_w("compose-m11-highspeed-rules", {
    "version": "v1", "milestone": "M11 High-Speed / SI-PI Rules",
    "classes": hs.HS_CLASSES, "required_capabilities": list(hs.REQUIRED),
    "gate_demos": {"PCIe capture": hs.hs_gate("PCIe capture card"),
                   "DDR4 SODIMM": hs.hs_gate("DDR4 memory board"),
                   "USB3 hub": hs.hs_gate("USB3 hub")},
    "honesty": "PCIe/DDR/USB3 architecture_only; no SI/PI correctness, "
               "eye, or timing claims; integrates with M8 fab gates"})
_w("compose-m12-reliability-classes", {
    "version": "v1", "milestone": "M12 Reliability / Space / Defense Classes",
    "classes": rc.CLASSES,
    "gate_demos": {t: rc.classify_request(t) for t in
                   ("LEO satellite payload", "defense radio",
                    "implantable sensor", "industrial controller",
                    "bench instrument")},
    "blocked_claims": rc.BLOCKED,
    "honesty": "class mapping + review workflows only; space/defense/"
               "mission-ready claims structurally blocked without evidence"})
print("M9-M12 artifacts written")
