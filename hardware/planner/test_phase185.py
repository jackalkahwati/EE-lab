"""Phase 18.5 regression: EII-1 compose attempt."""
import json
import os
import sys


checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui", "public", "runs")
D = os.path.join(RUNS, "fl1-eii1-v1", "data")


def art(name, d=D):
    p = os.path.join(d, name + ".json")
    return json.load(open(p)) if os.path.exists(p) else None


# 1-4 artifacts
for n, name in [(1, "eii1-requirements"), (2, "eii1-interface-architecture"),
                (3, "eii1-component-strategy"), (4, "eii1-safety-protection-model")]:
    check("%d %s generated" % (n, name), art(name) is not None)

# 5 compose attempt ran + honest verdict
rep = art("eii1-compose-report")
check("5 EII-1 composed (real pipeline)", rep and rep["pipeline_status"] == "PASSED"
      and rep["drc_violations"] == 0 and rep["unconnected"] == 0, rep["routing"] if rep else "")

# 6-11 physical role facts on the REAL board
txt = open(os.path.join(RUNS, "fl1-eii1-v1", "variant.kicad_pcb")).read()
dev = json.load(open(os.path.join(D, "devices.json")))
check("6 FL-1 bus header v2 (2x07)", "PinHeader_2x07" in txt)
check("7 slot-strap board-ID EEPROM", all(x in txt for x in ('"ID_A0"', '"ID_A1"', '"ID_A2"')))
check("8 mounting holes", txt.count('footprint "MountingHole:') >= 4)
check("9 labeled test points", txt.count('footprint "TestPoint:') >= 4)
check("10 functional silkscreen", txt.count("(gr_text ") >= 5)
safety = art("eii1-safety-protection-model")
check("11 safe-default output behavior (boot high-Z)",
      "high-Z" in safety["trigger_output"]["default"] or "INPUTS" in safety["safe_default"])

# 12-15 no instrument claims
reqs = art("eii1-requirements")
for n, claim in [(12, "DMM"), (13, "oscilloscope"), (14, "function generator"), (15, "RF")]:
    check("%d EII-1 does not claim %s capability" % (n, claim),
          any(claim.lower() in x.lower() for x in reqs["explicitly_not"]))

# 16-19 reports
role = art("role-completeness-report")
check("16 role-completeness checked (role_complete_with_review)",
      role["status"] == "role_complete_with_review" and not role["missing"])
check("17 validation workflows generated", len(art("eii1-validation-workflows")["workflows"]) == 4)
check("18 traceability package (FL1-EII-V1 serials)",
      art("eii1-traceability-package")["serial_range"][0] == "FL1-EII-V1-0001")
mfg = art("eii1-manufacturing-readiness-package")
check("19 manufacturing readiness (human_review_required, no approval)",
      mfg["order_record"]["order_status"] == "human_review_required"
      and mfg["order_record"]["approval_record"] is None)

# 20 feedback into Phase 18
fb = art("phase18-eii1-feedback-report")
check("20 architecture-search feedback (ready_for_reviewed_order_package)",
      fb["architecture_search_update"]["external_instrument_interface"]["readiness"]
      == "ready_for_reviewed_order_package")

# 21-23 Batch 1 untouched, nothing ordered/production
b1 = art("fl1-final-first-article-review-v3", os.path.join(RUNS, "fl1-cal-board-v4", "data"))
check("21 Batch 1 unchanged (all four order_3_pcba)",
      all(b["recommendation"] == "order_3_pcba" for b in b1["boards"]))
check("22 nothing ordered automatically", "NEVER automatic" in rep["order"])
check("23 no production-ready claim", "not production-ready" in mfg["honesty"])

npass = sum(1 for ok in checks if ok)
print("%d/%d Phase 18.5 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
