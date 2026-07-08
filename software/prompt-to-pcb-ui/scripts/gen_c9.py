"""C9: majority-use-case platform status report — honest, ladder-separated."""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")

led = json.load(open(os.path.join(
    RUNS, "power-entry-header-2l", "data",
    "compose-physical-evidence-ledger.json")))

report = {
    "version": "v1",
    "milestone": "C9 Majority-Use-Case Platform Status Report",
    "state_ladder_legend": {
        "routed_package_ready": "routed in sandbox, DRC/ERC clean, "
                                "review-required fab package",
        "review_required": "generatable but a human must review",
        "externally_analyzed": "M3B analysis evidence recorded (advisory)",
        "physically_validated": "NONE — ledger empty",
        "production_ready": "NONE — structurally unreachable without "
                            "evidence"},
    "board_classes_supported": {
        "routed_package_ready (proven run classes)": [
            "embedded controller (module + bare-RP2040 chip-down)",
            "lab/instrument (FL-1 family)", "I2C sensor boards",
            "telemetry (LoRa/GNSS/cellular module boards)",
            "adapter/breakout + test fixtures",
            "power monitor (fl1-dc-measure class)",
            "relay/control", "validation/helper boards",
            "simple chip-down support-IC boards", "multi-rail/mixed-signal"],
        "contract_ready_review_required (C-sprint, no routed benchmark "
        "board yet)": [
            "CAN industrial IO (C3 contract + fl1-comms proven class)",
            "RS485 industrial IO (C3 contract)",
            "LDO power-tree boards (C5)"],
        "blocked": ["USB-FS data boards (C4 primitives missing)",
                    "buck power trees without datasheet evidence",
                    "everything in the advanced envelope below"]},
    "buses": {
        "supported_with_contracts": ["I2C (proven, multi-drop model)",
                                     "SPI (C3)", "UART (C3)", "CAN (C3)",
                                     "RS485 (C3)"],
        "cautiously_gated": ["USB 2.0 FS (C4 — contract only, primitives "
                             "missing)"],
        "blocked": ["USB-HS", "USB3", "PCIe", "DDR", "MIPI (M11R)"]},
    "modules": {
        "proven": ["LoRa", "GNSS", "cellular", "IMU", "relay",
                   "board-ID EEPROM", "debug/SWD"],
        "candidates_review_required": ["Wi-Fi/BLE", "isolated CAN",
                                       "RS485 block", "DAC", "power module",
                                       "low-risk motor driver"]},
    "power_trees": {
        "supported": "input rails + LDO rails + protection candidates + "
                     "test points + dependency graph (C5)",
        "architecture_only": "buck without datasheet evidence "
                             "(missing-model report)",
        "blocked": ["motor stages", "mains", "PI/stability/thermal/"
                    "capacity claims"]},
    "templates": [
        "environmental telemetry node", "industrial IO controller",
        "lab instrument interface", "DUT power monitor",
        "calibration/reference", "adapter/breakout", "validation coupon",
        "USB-FS data logger (BLOCKED until C4 primitives)"],
    "remains_review_required": [
        "every fab package (standing rule)", "all C2 candidate evidence",
        "termination/bias values without evidence",
        "regulator application values", "candidate module footprints"],
    "remains_architecture_only": [
        "buck regulators without evidence", "6-layer/HDI/microvia/"
        "via-in-pad", "BGA boards", "USB-HS/USB3/PCIe/DDR/MIPI",
        "RF beyond module containment"],
    "remains_blocked": [
        "physical validation (ledger empty: %d artifacts, %s)" % (
            len(led["artifacts"]), led["order_status"]),
        "production readiness", "calibration/accuracy", "EMC/compliance",
        "controlled impedance (no stackup data)", "power integrity",
        "regulator stability", "current capacity", "thermal safety",
        "motor power stages", "mains", "space/defense/medical "
        "qualification"],
    "requires_physical_evidence_next": "the C8 ladder: power-entry -> "
        "USB-C -> BME280 -> chip-down -> multi-rail -> VBAT -> "
        "mixed-signal -> DUT monitor -> bare-RP2040 boot attempt",
    "sellable_now_honestly": [
        "evidence-gated board programs in the majority envelope (2L/4L, "
        "I2C/SPI/UART/CAN/RS485, modules) with review-required packages",
        "enterprise program governance (E1-E12): approvals, evidence "
        "packs, audit, pilot ROI",
        "FL-1 bundle with validation-session workflow (evidence "
        "review-gated)"],
    "not_sellable_yet": [
        "anything claiming physical validation (no evidence exists)",
        "USB data function", "RF performance", "high-speed", "BGA/HDI",
        "power-stage/motor/mains boards", "certified/qualified anything"],
    "recommended_pilot_targets": [
        "lab/test-equipment teams (instrument + DUT-monitor templates, "
        "FL-1 bundle)", "industrial IO pilots (CAN/RS485 contracts)",
        "telemetry/asset-tracking pilots (module boards)"],
    "recommended_next_technical": [
        "close the C4 USB-FS primitives (verified ESD part + router pair "
        "proof) — unblocks the logger template",
        "first physical evidence campaign (C8 ladder rung 1)",
        "datasheet evidence verification pass (C2 candidates -> verified)",
        "role-aware placement integration into the live placer (C1 "
        "findings -> repair loop)",
        "stackup data acquisition (cheapest analysis unlock)",
        "BGA escape classifier/coupon generator (M7R fixtures ready)"],
    "final_regression": {
        "C1-C8": "13/13, 13/13, 14/14, 10/10, 12/12, 12/12, 12/12, 10/10",
        "M2-M12R": "all green incl. M3A 17/17 live",
        "enterprise_spot": "E1/E2/E5/E7/E8/E11 green",
        "frontend": "24/24", "secret_scan": "CLEAN",
        "ledger": "empty, not_ordered", "orders_quotes": "none"},
}

md = "# C9 — Majority-Use-Case Platform Status Report v1\n\n" \
     "## Sellable now (honestly)\n%s\n\n## Not sellable yet\n%s\n\n" \
     "## Buses\nSupported: %s · Gated: %s · Blocked: %s\n\n" \
     "## Still blocked (load-bearing)\n%s\n\n" \
     "## Next\n%s\n" % (
         "\n".join("- " + s for s in report["sellable_now_honestly"]),
         "\n".join("- " + s for s in report["not_sellable_yet"]),
         ", ".join(report["buses"]["supported_with_contracts"]),
         ", ".join(report["buses"]["cautiously_gated"]),
         ", ".join(report["buses"]["blocked"]),
         "\n".join("- " + s for s in report["remains_blocked"]),
         "\n".join("- " + s for s in
                   report["recommended_next_technical"]))

for r in ["fl1-backplane-v1", "bare-mcu-qfn56-core-sandbox-v1"]:
    d = os.path.join(RUNS, r, "data")
    json.dump(report, open(os.path.join(
        d, "majority-use-case-platform-status-report.json"), "w"), indent=1)
    open(os.path.join(d, "majority-use-case-platform-status-report.md"),
         "w").write(md)

print("C9 status report written | ledger %d/%s" % (
    len(led["artifacts"]), led["order_status"]))
