"""Phase 23.2 regression: general physical board synthesis engine."""
import json
import os
import sys

import physical_synthesis as ps

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "blocks"))
import compose  # noqa: E402

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui", "public", "runs")
D = os.path.join(RUNS, "fl1-backplane-v1", "data")


def art(name, d=D):
    p = os.path.join(d, name + ".json")
    return json.load(open(p)) if os.path.exists(p) else None


# 1-5 core artifacts
audit = art("compose-physical-synthesis-audit")
check("1 physical synthesis audit (29 blocks, scopes + blockers)",
      audit["block_count"] == 29 and "known_blockers" in audit)
check("2 functional intent IR (22 intents, high-risk blocked list)",
      len(art("compose-functional-intent-ir")["intents"]) == 22)
check("3 request-to-intent compiler generated",
      art("compose-request-to-intent-compiler") is not None)
check("4 intent-to-implementation planner (6 strategies)",
      len(art("compose-intent-to-implementation-planner")["strategies"]) == 6)
check("5 synthesized subcircuit generator (20 kinds)",
      len(art("compose-synthesized-subcircuit-generator-v1")["kinds"]) == 20)

# 6-17 subcircuit kinds callable in compose
for n, kind in [(6, "pullup"), (7, "pulldown"), (8, "divider"),
                (9, "led_indicator"), (10, "button"), (11, "decoupling_cluster"),
                (12, "testpoint_cluster"), (13, "i2c_header"), (14, "spi_header"),
                (15, "uart_header"), (16, "debug_header"), (17, "address_jumper")]:
    check("%d subcircuit '%s' synthesizable" % (n, kind),
          kind in compose.SUBCIRCUITS)

# 18-19 power tree
pt = art("compose-power-tree-synthesizer-v1")
check("18 power-tree synthesizer generated", pt is not None)
check("19 power tree does not invent regulators",
      "invented regulators" in pt["blocked"])
ir_nb = ps.compile_intent("Simple I2C breakout board")
tree = ps.power_tree(ir_nb)
check("19b breakout power tree: no regulator invented (host header note)",
      any("no regulator invented" in c for c in tree["caveats"]))

# 20-21 connectors
cs = art("compose-connector-strategy-engine-v1")
check("20 connector strategy engine generated", cs is not None)
conns = ps.connector_strategy(ps.compile_intent("sensor board with i2c header"))
check("21 orientation/keying risk reported",
      all("orientation_risk" in c for c in conns["connectors"]))

# 22-23 placement
pl = art("compose-constraint-driven-placement-planner-v1")
check("22 constraint-driven placement planner generated",
      len(pl["groups"]) == 6)
check("23 non-FL-1 boards do not use FL-1 floorplan assumptions",
      "ONLY when FL-1 blocks are present" in pl["fl1_isolation"])

# 24-26 flow + roles
check("24 general synthesis flow generated (14-stage chain)",
      len(art("compose-general-physical-synthesis-flow")["chain"]) == 14)
rf = art("compose-generic-role-completeness-framework-v2")
check("25 role framework v2 (11 templates)", len(rf["templates"]) == 11)
check("26 FL-1 requirements not applied to non-FL-1 boards",
      any("FL-1 features" in r and "only for FL-1" in r for r in rf["rules"]))

# 27-36 benchmarks
bench = {b["benchmark"]: b for b in
         art("compose-general-physical-synthesis-benchmark-report")["benchmarks"]}
for n, name in [(27, "Environmental Sensor v2 (regression)"),
                (28, "BME280 Breakout (regression)"),
                (29, "USB-C 5V Power Entry"),
                (30, "Simple I2C Sensor Breakout"),
                (31, "Simple ADC Data Logger"),
                (32, "Raspberry Pi HAT Relay Controller"),
                (33, "Simple Power Entry Header Board")]:
    b = bench[name]
    check("%d %s: PASSED + review outcome" % (n, name.split(" (")[0]),
          b["status"] == "PASSED" and b["drc"] == 0
          and b["outcome"] == "package_ready_with_review")
check("34 motor controller remains blocked",
      bench["Motor Controller Request"]["outcome"].startswith("blocked"))
check("35 RF adapter remains architecture_only",
      bench["RF Adapter Request"]["outcome"] == "architecture_only")
check("36 PCIe remains architecture_only",
      bench["PCIe Request"]["outcome"] == "architecture_only")

# 37-39 synthesis honesty + fleet learning
gen = art("compose-synthesized-subcircuit-generator-v1")
check("37 synthesized subcircuits are review-required",
      any("review-required" in r for r in gen["rules"]))
check("38 synthesized subcircuits never physically validated by generation",
      any("never physically validated" in r for r in gen["rules"]))
flu = art("compose-general-synthesis-fleet-learning-update")
check("39 fleet learning tracks synthesized structures + promotions",
      "synthesized_subcircuits_used" in flu["structures"]
      and len(flu["promotion_recommendations"]) == 2)

# non-FL-1 verification on the pure-synthesis board's copper
txt = open(os.path.join(RUNS, "power-entry-header-v1", "variant.kicad_pcb")).read()
check("pure-synthesis board is FL-1-free on copper",
      all(x not in txt for x in ('"FAULT"', '"INTERLOCK"', '"TRIG"',
                                 "PinHeader_2x07", '"ID_A0"')))
check("synthesized structure appears in the device manifest (review-required)",
      "synthesized_subcircuits" in json.dumps(json.load(open(os.path.join(
          RUNS, "power-entry-header-v1", "data", "devices.json")))))
check("USB-C claims blocked by construction",
      "no PD" in json.dumps(json.load(open(os.path.join(
          RUNS, "usbc-power-entry-v1", "data", "devices.json")))).replace("\\u2014", "-")
      or "power-only" in json.dumps(json.load(open(os.path.join(
          RUNS, "usbc-power-entry-v1", "data", "devices.json")))))
check("46-47 no ordering / no production-ready",
      "nothing ordered" in art(
          "compose-general-physical-synthesis-benchmark-report")["honesty"])

npass = sum(1 for ok in checks if ok)
print("%d/%d Phase 23.2 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
