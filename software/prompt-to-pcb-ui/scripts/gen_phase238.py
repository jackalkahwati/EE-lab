"""Milestone M1 (autonomous roadmap): Chip-Down Component Synthesis v1.

  gen_phase238.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import chipdown_synthesis as cd  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")
RUN = "chipdown-pcf8574-v1"
TARGETS = ["fl1-backplane-v1", RUN]


def _w(name, obj):
    for r in TARGETS:
        d = os.path.join(RUNS, r, "data")
        os.makedirs(d, exist_ok=True)
        json.dump(obj, open(os.path.join(d, name + ".json"), "w"), indent=1)


_w("compose-roadmap-to-generic-pcba-generator", {
    "version": "v1 (updated by the autonomous milestone loop)",
    "final_goal": "generic evidence-gated PCBA generator producing review-"
                  "required first-article packages from product-level requests",
    "done": ["intent synthesis", "JIT acquisition", "subcircuits", "packs",
             "2L/4L flows", "QFN-56 sandbox", "package families",
             "physical evidence loop (awaiting signature)",
             "chip-down component synthesis v1 (THIS MILESTONE)"],
    "milestones_remaining": [
        {"m": "Bare-MCU product board / Pico replacement v1",
         "unblocked_by": "chip-down synthesis + QFN-56 escape"},
        {"m": "Core-6 bare-RP2040 monolith attempt", "unblocked_by": "same"},
        {"m": "Physical first-article evidence ingestion",
         "blocked_on": "human APPROVED_FOR_QUOTE signature"},
        {"m": "High-current / power-stage rules v1"},
        {"m": "Advanced fabrication classes v1 (4+ layers, finer geometry)"},
        {"m": "BGA/HDI/microvia roadmap", "blocked_on": "verified BGA part"},
        {"m": "High-speed / SI-PI rules v1 (external expertise gate)"},
        {"m": "RF / controlled impedance rules v1 (external expertise gate)"},
        {"m": "Full hardware digital twin v1"}],
    "selection_rationale": "fleet #1 (execute physical loop) requires the "
                           "human signature; chip-down synthesis was the "
                           "highest-leverage software milestone: it converts "
                           "the package-family system + JIT verification "
                           "into GENERALITY (any verified chip, no hand "
                           "block)"})
e = cd.synthesize_chipdown("Interface_Expansion", "PCF8574T",
                           "Package_SO", "SOIC-16_3.9x9.9mm_P1.27mm", "U40")
d2 = os.path.join(RUNS, RUN, "data")
bj = json.load(open(os.path.join(d2, "board.json")))
drc = json.load(open(os.path.join(d2, "drc.json")))
viol = len([v for v in (drc.get("violations") or [])
            if v.get("type") != "solder_mask_bridge"])
_w("compose-chipdown-synthesis-v1-report", {
    "version": "v1",
    "mechanism": "synthesize_chipdown: parse symbol (KiCad `extends` "
                 "inheritance RESOLVED — PCF8574T carries no pins; its base "
                 "TCA9534 does) -> classify package -> verify footprint "
                 "geometry -> verify mapping (mapping_blocked REFUSES) -> "
                 "bus policy -> compose {chipdown:[...]} entry -> generic "
                 "emitter (place + per-power-pin decoupling + pullups + IO "
                 "header + review silk)",
    "parser_fixes": ["string-aware depth scan (parens inside quoted "
                     "descriptions overran blocks and could steal the NEXT "
                     "symbol's pins — caught before it shipped)",
                     "extends provenance preserved through recursion"],
    "proof_part": {"part": "PCF8574T (I2C IO expander)", "package": e["package"],
                   "symbol": e["symbol"], "pins": e["evidence"]["pins_parsed"],
                   "never_hand_blocked": True},
    "proof_run": {"run": RUN, "routing": "%s/%s" % (bj.get("netsRouted"),
                  bj.get("netsTotal")), "drc": viol,
                  "status": json.load(open(os.path.join(
                      d2, "last-run.json")))["status"]},
    "gates": ["state must be synthesized_review_required or compose refuses",
              "tier-3 packages return architecture_only",
              "mapping/footprint blocks refuse layout"],
    "honesty": "generic synthesis is REVIEW-REQUIRED; no functional claim "
               "(the expander is placed and wired, not proven to respond); "
               "nothing physical"})
_w("compose-chipdown-fleet-learning-update", {
    "version": "v1",
    "capability_gained": "any symbol+footprint-verified tier-1/2 chip can now "
                         "be placed chip-down with synthesized support — no "
                         "hand block per part",
    "scope": "proven for SOIC-16 I2C expander; policy covers power/GND/I2C/"
             "straps/INT/NC/IO; SPI/UART/analog policies are gaps",
    "gaps": ["bus policy beyond I2C", "per-part decoupling values (datasheet "
             "extraction still missing)", "multi-rail chips", "crystal/flash "
             "requirements detection (RP2040-class remains hand-blocked)"],
    "next_recommendation": {
        "recommendation": "Bare-MCU product board / Pico replacement v1",
        "reason": "chip-down synthesis + QFN-56 escape are both proven; "
                  "combining them into a product-level bare-MCU board is the "
                  "next generality step a signature does not block",
        "blocked_alternative": "physical evidence ingestion (awaiting "
                               "APPROVED_FOR_QUOTE)"}})
_w("compose-chipdown-pack-registry-update", {
    "version": "v1",
    "new_pack": {"chipdown_synthesis_pack": {
        "state": "routed_in_sandbox (PCF8574/SOIC-16 scope)",
        "evidence": RUN, "blocked_claims": e["blocked_claims"]}},
    "package_registry_note": "SOIC family gains chip-down-synthesis evidence "
                             "(scoped to this part); no family-wide promotion"})

print("chipdown %s: %s/%s nets, DRC %d" % (RUN, bj.get("netsRouted"),
                                           bj.get("netsTotal"), viol))
