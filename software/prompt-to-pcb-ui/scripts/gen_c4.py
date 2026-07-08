"""C4: USB full-speed benchmarks — 7 cases."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import usb_fs  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")

B = {}
# 1. RP2040 USB-FS advisory: ESD device + router pair support still missing
B["rp2040_usb_fs_advisory"] = usb_fs.usb_fs_contract(
    mcu="RP2040", connector="USB4125", esd_device=None,
    router_pair_support=False)
# 1b. with primitives satisfied (hypothetical ESD selection + router proof)
B["rp2040_usb_fs_all_primitives"] = usb_fs.usb_fs_contract(
    mcu="RP2040", connector="USB4125", esd_device="USBLC6-2SC6 (candidate)",
    router_pair_support=True)
# 2. power-only board makes no data claim
adv = json.load(open(os.path.join(
    RUNS, "usbc-power-entry-v1", "data",
    "advanced-routing-report.json"))) if os.path.exists(os.path.join(
        RUNS, "usbc-power-entry-v1", "data",
        "advanced-routing-report.json")) else None
imp = json.load(open(os.path.join(
    RUNS, "fl1-backplane-v1", "data",
    "compose-impedance-benchmark-report.json")))
B["usbc_power_only_no_data_claim"] = {
    "board": "usbc-power-entry-v1",
    "m3b_finding": imp["benchmarks"]["usbc_power_only_board"]["finding"],
    "state": "power_only_confirmed"}
# 3. unsupported connector blocks
B["unsupported_connector"] = usb_fs.usb_fs_contract(
    connector="MYSTERY_PORT", esd_device="x", router_pair_support=True)
# 4/5. HS + USB3 remain architecture_only via M11R
B["usb_hs_request"] = usb_fs.usb_request_gate("usb high speed device")
B["usb3_request"] = usb_fs.usb_request_gate("USB3 hub")
# 6. compliance blocked (structural)
B["compliance_claim"] = {"state": "blocked",
                         "blocked_claims": usb_fs.BLOCKED_ALWAYS}
# 7. missing stackup -> impedance blocked
B["missing_stackup_impedance"] = usb_fs.usb_fs_contract(
    esd_device="x", router_pair_support=True)["contract"]["impedance"]

summary = {k: (v.get("state") or v.get("path") or v.get("result_status"))
           for k, v in B.items()}

report = {
    "version": "v1", "milestone": "C4 USB Full-Speed Data Path",
    "scope": "USB 2.0 FS (12 Mbps) ONLY — no HS, no USB3, no PD, no "
             "compliance claim, no physical function claim without test",
    "required_primitives": list(usb_fs.REQUIRED_PRIMITIVES),
    "validation_plan": usb_fs.VALIDATION_PLAN,
    "blocked_always": usb_fs.BLOCKED_ALWAYS,
    "benchmarks": summary,
    "honest_state_today": "the advisory contract BLOCKS: no verified ESD "
        "primitive is selected and the router must prove the D+/D- pair "
        "per board — the exact gaps are named, nothing is faked",
}

md = "# C4 — USB Full-Speed Data Path v1\n\nScope: %s\n\n## Benchmarks\n%s\n" % (
    report["scope"],
    "\n".join("- %s: %s" % (k, v) for k, v in summary.items()))

for r in ["fl1-backplane-v1", "bare-mcu-qfn56-core-sandbox-v1"]:
    d = os.path.join(RUNS, r, "data")
    json.dump(report, open(os.path.join(
        d, "usb-full-speed-data-path-v1.json"), "w"), indent=1)
    open(os.path.join(d, "usb-full-speed-data-path-v1.md"), "w").write(md)
    json.dump({"benchmarks": B}, open(os.path.join(
        d, "usb-full-speed-benchmark-report.json"), "w"), indent=1)
    open(os.path.join(d, "usb-full-speed-benchmark-report.md"),
         "w").write(md)

print("C4:", json.dumps(summary))
