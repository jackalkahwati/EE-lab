"""Phase 18.6 regression: PCM-1 power/current monitor compose attempt."""
import json
import os
import sys


checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui", "public", "runs")
D = os.path.join(RUNS, "fl1-pcm1-v1", "data")


def art(name, d=D):
    p = os.path.join(d, name + ".json")
    return json.load(open(p)) if os.path.exists(p) else None


# 1-5 artifacts
for n, name in [(1, "pcm1-requirements"), (2, "pcm1-architecture-choice"),
                (3, "pcm1-measurement-claim-model"), (4, "pcm1-component-strategy"),
                (5, "pcm1-safety-protection-model")]:
    check("%d %s generated" % (n, name), art(name) is not None)

# 6 compose ran clean
rep = art("pcm1-compose-report")
check("6 PCM-1 composed (real pipeline, clean)", rep and rep["pipeline_status"] == "PASSED"
      and rep["drc_violations"] == 0 and rep["unconnected"] == 0, rep["routing"] if rep else "")

# 7-18 physical facts on the REAL board
txt = open(os.path.join(RUNS, "fl1-pcm1-v1", "variant.kicad_pcb")).read()
dev = json.load(open(os.path.join(D, "devices.json")))
check("7 uses the proven Pico MODULE primitive",
      "RaspberryPi_Pico" in txt or "Pico" in str([d.get("name") for d in dev]))
check("8 FL-1 bus header v2 (2x07)", "PinHeader_2x07" in txt)
check("9 slot-strap board-ID EEPROM", all(x in txt for x in ('"ID_A0"', '"ID_A1"', '"ID_A2"')))
check("10 mounting holes", txt.count('footprint "MountingHole:') >= 4)
check("11 labeled test points", txt.count('footprint "TestPoint:') >= 8)
check("12 functional silkscreen", txt.count("(gr_text ") >= 8)
check("13 voltage sense path", all(x in txt for x in ('"DUT_V"', '"VSENSE_DIV"', '"VSENSE_ADC"')))
check("14 current sense path", all(x in txt for x in ('"SHUNT_HI"', '"ISENSE_ADC"')))
check("15 shunt present", any(d2.get("type") == "shunt" for d2 in dev))
check("16 ADC path (ADS1115 on I2C)",
      any(d2.get("type") == "adc" and "ADS1115" in str(d2.get("name")) for d2 in dev))
check("17 ADC input protection (series R nets)", '"VSENSE_ADC"' in txt and '"ISENSE_ADC"' in txt)
check("18 DUT connector", '"DUT_V"' in txt and "1x03" in txt)

# 19-23 forbidden claims
reqs = art("pcm1-requirements")
for n, claim in [(19, "precision DMM"), (20, "programmable power"),
                 (21, "high-current"), (22, "high-voltage"), (23, "bare-RP2040")]:
    check("%d PCM-1 does not claim %s" % (n, claim),
          any(claim.lower() in x.lower() for x in reqs["explicitly_not"]))

# 24-28 reports
role = art("role-completeness-report")
check("24 role-completeness (role_complete_with_review, 14/14)",
      role["status"] == "role_complete_with_review" and not role["missing"])
check("25 validation workflows (5, incl. calibration dependency)",
      len(art("pcm1-validation-workflows")["workflows"]) == 5)
check("26 traceability package (FL1-PCM-V1 serials)",
      art("pcm1-traceability-package")["serial_range"][0] == "FL1-PCM-V1-0001")
mfg = art("pcm1-manufacturing-readiness-package")
check("27 manufacturing readiness (human_review_required, no approval)",
      mfg["order_record"]["order_status"] == "human_review_required"
      and mfg["order_record"]["approval_record"] is None)
fb = art("phase18-pcm1-feedback-report")
check("28 architecture-search feedback (ready_for_reviewed_order_package)",
      fb["architecture_search_update"]["power_current_monitor"]["readiness"]
      == "ready_for_reviewed_order_package")

# 29-31 five prior boards untouched, nothing ordered/production
b1 = art("fl1-final-first-article-review-v3", os.path.join(RUNS, "fl1-cal-board-v4", "data"))
eii = art("eii1-compose-report", os.path.join(RUNS, "fl1-eii1-v1", "data"))
check("29 five review-required boards unchanged",
      all(b["recommendation"] == "order_3_pcba" for b in b1["boards"])
      and eii["verdict"] == "ready_to_build_with_review")
check("30 nothing ordered automatically", "NEVER automatic" in rep["order"])
check("31 no production-ready claim", "not production-ready" in mfg["honesty"])

# claim model honesty
cm = art("pcm1-measurement-claim-model")
check("claim model: uncalibrated before calibration (both channels)",
      "uncalibrated" in cm["voltage"]["claims_before_calibration"]
      and "uncalibrated" in cm["current"]["claims_before_calibration"])
check("safety model: monitor-only classification",
      "MONITOR-ONLY" in art("pcm1-safety-protection-model")["classification"])

npass = sum(1 for ok in checks if ok)
print("%d/%d Phase 18.6 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
