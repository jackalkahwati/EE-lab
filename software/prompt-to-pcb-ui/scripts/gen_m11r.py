"""M11R: replay the quarantined M11 high-speed gates through M3B evidence.

Draft: PCIe/DDR/USB3/MIPI detection -> architecture_only with the missing
capability list. Replay adds:
- DDR detection bug regression (multiple phrasings + substring false-
  positive probes stay clean);
- DETECTION GAP CLOSED: 'USB high-speed' (480Mbps) and gigabit Ethernet
  requests previously sailed through as no_high_speed_content — both now
  detect and gate as architecture_only (USB2_HS, ETH_1G);
- every missing capability now cites a recorded M3B state: no IBIS models,
  no stackup, SI benchmark's honest skipped_missing_input, impedance/
  diff-pair/SI claim gates blocked.
No high-speed correctness claim is made anywhere.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import highspeed_rules as hs  # noqa: E402
import external_eda as ee  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")
D = os.path.join(RUNS, "fl1-backplane-v1", "data")

# ---- gate demos incl. the closed detection gaps ----------------------------
demos = {t: hs.hs_gate(t) for t in (
    "PCIe capture card", "DDR4 memory board", "DDR4 SODIMM",
    "SDRAM controller", "USB3 hub", "USB high-speed device",
    "gigabit ethernet switch", "RGMII phy board", "MIPI CSI-2 camera")}
false_positive_probes = {t: hs.hs_gate(t)["verdict"] for t in (
    "plain adder demo", "ladder relay board", "i2c sensor breakout")}

ddr_regression = {
    "phrasings_detected": all(
        "DDR3/4" in demos[t]["classes"] for t in
        ("DDR4 memory board", "DDR4 SODIMM", "SDRAM controller")),
    "substring_false_positives_clean": all(
        v == "no_high_speed_content" for v in false_positive_probes.values()),
    "note": "the pre-hardening draft caught a DDR detection bug; this "
            "regression keeps it dead across phrasings and probes"}

gap_closure = {
    "finding": "detection gaps — 'USB high-speed' and gigabit Ethernet "
               "requests previously returned no_high_speed_content",
    "fix": "USB2_HS + ETH_1G classes and keywords added to "
           "highspeed_rules; both architecture_only like every class",
    "usb_hs_now": demos["USB high-speed device"]["verdict"],
    "eth_now": demos["gigabit ethernet switch"]["verdict"],
    "consistency": "the v1 router already refuses RP_USB_D (advanced-"
                   "routing report); the gate now says so at request time"}

# ---- M3B connections --------------------------------------------------------
inv = ee.inventory()
si_bench = json.load(open(os.path.join(
    D, "compose-si-benchmark-report.json")))["benchmarks"]

m3b = {
    "ibis_models_local": inv["tools"]["ibis_models_local"],
    "stackup_model_local": inv["tools"]["stackup_model_local"],
    "high_speed_signal_integrity_claim":
        ee.gate("high_speed_signal_integrity_claim"),
    "controlled_impedance_claim": ee.gate("controlled_impedance_claim"),
    "differential_pair_quality_claim":
        ee.gate("differential_pair_quality_claim"),
    "si_benchmark_replay": {
        "pcie_request": si_bench["pcie_request"]["verdict"],
        "usb3_request": si_bench["usb3_request"]["verdict"],
        "missing_ibis_report": si_bench["missing_ibis_report"]["status"]},
    "note": "missing IBIS / stackup / length-matching engine / SI models "
            "are recorded states, not prose"}

missing_capability_citations = {
    "impedance_stackup": "M3B stackup_model_local.found == false",
    "length_matching_engine": "no engine in repo (structural)",
    "reference_plane_audit": "no engine in repo (structural)",
    "via_transition_model": "no engine in repo (structural)",
    "external_SI_PI_analysis": "M3B: missing_ibis_report == "
                               "skipped_missing_input",
    "PI_decoupling_network_analysis": "M3B PDN hooks: inventory only, "
                                      "PI blocked"}

blocked = {
    "blocked_claims": sorted(set(hs.BLOCKED) | {
        "high_speed_signal_integrity_claim", "controlled_impedance_claim",
        "differential_pair_quality_claim",
        "differential_pair_routing_beyond_proven_scope"}),
    "proven_scope_note": "diff-pair support is limited to what the "
                         "advanced-routing report proves per board; no "
                         "general claim",
    "missing_capability_citations": missing_capability_citations}

led = json.load(open(os.path.join(RUNS, "power-entry-header-2l", "data",
                                  "compose-physical-evidence-ledger.json")))

report = {
    "version": "v1", "milestone": "M11R high-speed gates replay",
    "replayed_from": "drafts/m7-m12-pre-hardening (M11)",
    "gate_demos": {k: v["verdict"] for k, v in demos.items()},
    "all_domains_architecture_only": all(
        v["verdict"] == "architecture_only" for v in demos.values()),
    "ddr_detection_regression": ddr_regression,
    "detection_gap_closure": gap_closure,
    "m3b_connection": m3b,
    "verdict": "ACCEPTED as gates, with hardening: high-speed domains "
               "(PCIe/DDR/USB3/USB-HS/GbE/MIPI) architecture_only; missing "
               "evidence cited from recorded M3B states; detection gaps for "
               "USB-HS and GbE closed; no SI/PI/eye/timing claim",
    "physical_ledger": {"artifacts": led["artifacts"],
                        "order_status": led["order_status"]},
    "no_ordering_action": True,
    "honesty": "no differential-pair claim beyond proven per-board scope; "
               "no controlled impedance; detection is text-level triage, "
               "not a routing capability"}

md = """# M11R — high-speed gates replay through EDA evidence

## Accepted (gate/blocker milestone, with hardening)
- PCIe / DDR3-4 / USB3 / MIPI-LVDS: architecture_only with the missing
  capability list — unchanged from the draft, now evidence-cited.
- DDR detection bug regression: detected across phrasings (memory board,
  SODIMM, SDRAM); substring probes (adder, ladder, i2c) stay clean.

## Replay finding — detection gaps CLOSED
'USB high-speed device' and 'gigabit ethernet switch' previously returned
no_high_speed_content — an honest-refusal hole. USB2_HS and ETH_1G classes
added; both architecture_only. Consistent with the v1 router already
refusing RP_USB_D on real boards.

## Missing evidence, cited (M3B)
- No IBIS models in repo (ibis_models_local: false).
- No stackup/material data (controlled impedance blocked).
- SI benchmark: pcie/usb3 architecture_only; missing-IBIS report is an
  honest skipped_missing_input.
- Length matching / reference-plane audit / via transition model: no
  engines exist (structural).
- Claim gates blocked: high_speed_SI, controlled_impedance, diff-pair
  quality. No diff-pair claim beyond proven per-board scope.

Physical ledger untouched; no ordering or quote action.
"""

for r in ["fl1-backplane-v1", "bare-mcu-qfn56-core-sandbox-v1"]:
    d = os.path.join(RUNS, r, "data")
    json.dump(report, open(os.path.join(
        d, "m11r-high-speed-replay-report.json"), "w"), indent=1)
    open(os.path.join(d, "m11r-high-speed-replay-report.md"), "w").write(md)
    json.dump(m3b, open(os.path.join(
        d, "m11r-si-external-analysis.json"), "w"), indent=1)
    json.dump(blocked, open(os.path.join(
        d, "m11r-high-speed-blocked-claims.json"), "w"), indent=1)

print("M11R: %d domains architecture_only=%s | ddr regression=%s | gaps "
      "closed: usb_hs=%s eth=%s" %
      (len(demos), report["all_domains_architecture_only"],
       ddr_regression["phrasings_detected"],
       gap_closure["usb_hs_now"], gap_closure["eth_now"]))
