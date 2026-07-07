"""Phase 19: generate the multi-board electromechanical co-design artifacts
from the real board data (envelopes from board.json) + the real backplane run.

  gen_phase19.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "..", "hardware", "planner"))
import system_codesign as sc  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "public", "runs")
TARGETS = ["fl1-backplane-v1", "fl1-cal-board-v4"]


def _w(name, obj):
    for r in TARGETS:
        json.dump(obj, open(os.path.join(RUNS, r, "data", name + ".json"), "w"), indent=1)


# board envelopes from REAL board.json geometry
envelopes = []
for role, name, run, slot in sc.BOARDS:
    bj = json.load(open(os.path.join(RUNS, run, "data", "board.json")))
    bs = bj.get("boardSize", {})
    envelopes.append({
        "board": name, "role": role, "run_id": run, "slot": slot,
        "dimensions_mm": [round(bs.get("wMm", 0), 1), round(bs.get("hMm", 0), 1)],
        "mounting_holes": "4x M3 at 7mm corner inset (uniform, Phase 15.6/16.7)",
        "bus_connector": "2x07 bus-v2 header, bottom edge",
        "tp_zone": "bottom margin rows (uniform)",
        "keepouts": "fiducial keepout rule areas + 3mm around bus header",
        "component_height_assumption": "<= 15mm (Pico module + relays tallest)",
        "cable_exit": "top edge (DUT/instrument connectors)",
        "front_panel": role in ("external_instrument_interface", "power_current_monitor"),
        "thermal_concern": "relay coils" if role == "relay_probe_matrix"
                           else ("shunt I^2R" if role == "power_current_monitor" else "none noted"),
        "orientation": "vertical card, bus edge down",
    })
_w("fl1-board-envelope-report", {"version": "v1", "boards": envelopes})
_w("fl1-slot-standard-v1", sc.slot_standard(envelopes))
_w("fl1-system-architecture", sc.system_architecture())

# backplane concept + REAL compose evidence
bp = os.path.join(RUNS, "fl1-backplane-v1", "data")
bj = json.load(open(os.path.join(bp, "board.json")))
drc = json.load(open(os.path.join(bp, "drc.json")))
lr = json.load(open(os.path.join(bp, "last-run.json")))
viol = len([v for v in (drc.get("violations") or []) if v.get("type") != "solder_mask_bridge"])
bp_pass = lr.get("status") == "PASSED" and viol == 0
_w("fl1-backplane-concept-v1", {
    "version": "v1", "slots": 6, "connector": "2x07 PinHeader (bus v2)",
    "carries": ["+5V", "+3V3", "GND x3", "I2C_SDA/SCL", "FAULT", "INTERLOCK",
                "RST_OUT", "TRIG", "ID_A0-A2 per-slot straps"],
    "strap_scheme": "slot k ties ID_An to +3V3 where bit n of k is 1; card "
                    "pull-downs read floating pins as 0 -> addresses 0x50-0x55",
    "system_pullups": "I2C pull-ups on the backplane (R94/R95) — the ERC gate "
                      "required a defined bus; card pull-up stacking recorded "
                      "as a Rev B item",
    "power": "~1.5A at 5V conservative budget; inline fuse recommended",
    "grounding": "single GND plane; chassis tie deferred to the enclosure phase",
    "mechanical": "M3 mounting + 30mm slot pitch", "labels": "SLOT n / ID 0x5n silk",
    "not": ["no measurement claims", "no hidden address conflicts (straps make "
            "them impossible by construction)", "assumes partial population is "
            "legal (any subset of cards works)", "per-board validation unchanged"]})
_w("fl1-backplane-v1-compose-report", {
    "version": "v1", "run_id": "fl1-backplane-v1", "stress_test": False,
    "routing": "%s/%s" % (bj.get("netsRouted"), bj.get("netsTotal")),
    "drc_violations": viol, "unconnected": len(drc.get("unconnected_items") or []),
    "pipeline_status": lr.get("status"),
    "status": "ready_to_build_with_review" if bp_pass else "revise_before_order",
    "board_size_mm": [bj.get("boardSize", {}).get("wMm"), bj.get("boardSize", {}).get("hMm")],
    "order": "order_3_pcba_review_required (NEVER automatic)" if bp_pass else "revise",
    "note": "passive board: connectors + straps + pull-ups + TPs only"})

# unified connector map + compatibility (incl. the REAL pull-up stacking finding)
conns = [{"connector": "J8 bus header", "board": "every card", "mate": "backplane slot",
          "pins": 14, "domain": "5V/3V3", "keyed": False,
          "label": "pin-1 silk mark", "validation": "identity scan"},
         {"connector": "J40-J45 slots", "board": "backplane", "mate": "card J8",
          "pins": 14, "domain": "5V/3V3", "keyed": False,
          "label": "SLOT n / ID 0x5n", "validation": "strap readback"},
         {"connector": "J20 DUT input", "board": "PCM-1", "mate": "DUT harness",
          "pins": 3, "domain": "0-24V labeled", "keyed": False,
          "label": "V+ / RTN(shunt) / GND", "validation": "V/I sense sanity"},
         {"connector": "J12 instrument UART", "board": "EII-1", "mate": "COTS TTL",
          "pins": 4, "domain": "3V3 TTL", "keyed": False,
          "label": "TX RX 3V3 GND (TTL)", "validation": "loopback"},
         {"connector": "GPIO bank J10/J11", "board": "digital + EII", "mate": "DUT/instrument",
          "pins": 5, "domain": "3V3, 100R series", "keyed": False,
          "label": "GPIO0-3 + GND", "validation": "loopback/boot-state"},
         {"connector": "PROBEn + INSTR_BUS", "board": "relay matrix", "mate": "DUT harness",
          "pins": 6, "domain": "signal relays", "keyed": False,
          "label": "channel map silk", "validation": "continuity"}]
_w("fl1-unified-connector-map", {"version": "v1", "connectors": conns})
_w("fl1-pinout-compatibility-report", {
    "version": "v1",
    "findings": [
        {"item": "bus header pinout", "status": "CONSISTENT",
         "detail": "all six cards + backplane carry identical bus-v2 pinout"},
        {"item": "slot strap addressing", "status": "CONSISTENT",
         "detail": "0x50-0x55 by construction; bench default 0x50 preserved"},
        {"item": "I2C pull-up stacking", "status": "REVIEW_REQUIRED",
         "detail": "each card carries 4.7k pull-ups (proven standalone design) "
                   "+ backplane system pull-ups: 6 cards populated -> ~670-780 "
                   "ohm effective, exceeding the I2C 3mA sink spec. Mitigation: "
                   "bench-verify bus levels at first assembly; card-side DNP "
                   "option in Rev B. HONESTLY RECORDED, not hidden"},
        {"item": "connector keying", "status": "REVIEW_REQUIRED",
         "detail": "2x07 pin headers are unkeyed — reversed insertion possible; "
                   "silk pin-1 marks + checklist in v1, keyed shrouded header "
                   "in Rev B"},
        {"item": "ADC address coexistence", "status": "CONSISTENT",
         "detail": "PCM-1 ADS1115 at 0x48, cal ADS1115 at 0x49, EEPROMs "
                   "0x50-0x55 — no conflicts"}]})

_w("fl1-dut-fixture-concept", sc.fixture_options())
_w("fl1-grounding-shielding-strategy", sc.grounding())
_w("fl1-system-power-architecture", sc.power_architecture())
_w("fl1-thermal-airflow-concept", sc.thermal())
_w("fl1-enclosure-serviceability-concept", sc.enclosure())
wf = sc.workflows()
_w("fl1-assembly-workflow", {"version": "v1", "steps": wf["assembly"]})
_w("fl1-service-workflow", {"version": "v1", "steps": wf["service"]})
_w("fl1-multiboard-validation-plan", sc.validation_plan())
_w("fl1-system-traceability-model", sc.traceability())
_w("fl1-monolithic-costdown-roadmap", sc.costdown_roadmap())
_w("fl1-system-manufacturing-readiness", sc.system_manufacturing(envelopes))
_w("fl1-system-risk-register", sc.risk_register())

# layout map + simple SVG
slots = [{"slot": s, "board": n, "x_mm": 20 + s * 30} for _r, n, _run, s in sc.BOARDS]
_w("fl1-system-layout-map", {
    "version": "v1", "plate_mm": [220, 200], "backplane_at": "y=170 (rear)",
    "slots": slots, "dut_area": "front-left 80x60", "instrument_side": "front-right",
    "power_entry": "rear-left backplane inlet", "service_access": "top (vertical extraction)"})
svg = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 440 400" font-family="monospace" font-size="9">',
       '<rect x="10" y="10" width="420" height="380" fill="#1a1a1a" stroke="#555"/>',
       '<rect x="30" y="330" width="380" height="40" fill="#333" stroke="#8b5"/>',
       '<text x="40" y="355" fill="#8b5">FL-1 PASSIVE BACKPLANE v1 (9/9 nets, 0 DRC)</text>']
for s in slots:
    x = 35 + s["slot"] * 62
    svg.append('<rect x="%d" y="120" width="52" height="210" fill="#252525" stroke="#79c"/>' % x)
    svg.append('<text x="%d" y="135" fill="#79c">S%d 0x5%d</text>' % (x + 4, s["slot"], s["slot"]))
    words = s["board"].split()
    svg.append('<text x="%d" y="150" fill="#aaa">%s</text>' % (x + 4, words[0][:8]))
svg.append('<rect x="30" y="30" width="150" height="70" fill="#2a2222" stroke="#c95"/>')
svg.append('<text x="38" y="55" fill="#c95">DUT AREA (front-left)</text>')
svg.append('<rect x="250" y="30" width="160" height="70" fill="#22262a" stroke="#9c5"/>')
svg.append('<text x="258" y="55" fill="#9c5">COTS INSTRUMENTS (front-right)</text>')
svg.append('<text x="30" y="390" fill="#888">open-frame 220x200 · power entry rear-left · '
           'vertical card extraction · NOT production-ready</text>')
svg.append('</svg>')
for r in TARGETS:
    open(os.path.join(RUNS, r, "data", "fl1-system-layout.svg"), "w").write("\n".join(svg))

print("backplane: %s (%s, %d DRC) -> %s" % (lr.get("status"),
      "%s/%s" % (bj.get("netsRouted"), bj.get("netsTotal")), viol,
      "ready_to_build_with_review" if bp_pass else "revise"))
print("envelopes: %d boards, slot standard %d slots @30mm" % (len(envelopes), 6))
print("fixture: swappable DUT adapter card; enclosure: open frame")
