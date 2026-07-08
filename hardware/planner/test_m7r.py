"""M7R regression: BGA verified-part replay through M3A/M3B hardening."""
import json
import os
import sys

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui", "public",
                 "runs", "fl1-backplane-v1", "data")


def art(name):
    p = os.path.join(D, name + ".json")
    return json.load(open(p)) if os.path.exists(p) else None


rep = art("m7r-bga-replay-report")
check("1 replay report exists, sourced from the quarantine",
      rep is not None and "m7-m12-pre-hardening" in rep["replayed_from"])
vp = rep["verified_part"]
check("2 symbol/ball identity re-verified (121 == 121, accepted)",
      vp["symbol_pins"] == 121 and vp["footprint_balls"] == 121
      and vp["symbol_ball_match"] is True and "ACCEPTED" in vp["state"])
check("3 package registry: BGA_coarse tier 3, advanced gate ON",
      rep["package_registry"]["family"] == "BGA_coarse"
      and rep["package_registry"]["tier"] == 3
      and rep["package_registry"]["advanced_gate"] is True)
pc = rep["per_ball_escape_classification"]["counts"]
check("4 per-ball classification: 40 ring0 + 32 ring1 + 49 interior = 121",
      pc["ring0_escape"] == 40 and pc["ring1_trapped"] == 32
      and pc["interior_no_emitter"] == 49
      and sum(pc.values()) == 121)
check("5 draft estimate DOWNGRADED (outer-two-rings -> ring-0 only)",
      "downgraded" in str(rep["per_ball_escape_classification"]).lower()
      and "ring-1" in rep["per_ball_escape_classification"][
          "draft_estimate_downgraded"])
rv = rep["router_evidence"]
check("6 M3A router evidence: 3/3 bga fixtures through the real toolchain",
      rv["fixtures"] == 3 and rv["passed"] == 3)
check("7 ring-0 routes clean; ring-1 + interior fail HONESTLY",
      rv["ring0_escape"] == "routed_clean"
      and rv["ring1_trapped"] == "failed_honestly"
      and rv["interior"] == "failed_honestly")
check("8 open nets visible on the failures (no hidden residuals)",
      rv["open_nets_visible"] is True)
router = art("m7r-bga-router-evidence")
check("9 router evidence artifact carries full fixture results",
      router is not None and router["fixtures"] == 3
      and all("honesty" in r for r in router["results"]))
check("10 frozen M3A 21-fixture full contract untouched",
      art("flroute-regression-report")["full_suite"]["fixtures"] == 21)
bc = art("m7r-bga-blocked-claims")
check("11 structural blocks: BGA routing/emission, HDI, via-in-pad, FPGA",
      all(c in bc["structural (no engine)"] for c in
          ("BGA routing support", "BGA board emission", "HDI support",
           "via-in-pad support", "FPGA board support")))
check("12 DDR/PCIe/high-speed wired to M3B gates, all blocked",
      all(g["state"] == "blocked" for g in bc["m3b_claim_gates"].values()))
check("13 board generation stays BLOCKED (no escape emitter)",
      rep["sandbox_attempt_allowed"] is False
      and "BLOCKED" in rep["board_generation"]
      and "architecture_only" in rep["verdict"])
check("14 physical ledger untouched; no ordering action",
      rep["physical_ledger"]["artifacts"] == []
      and rep["physical_ledger"]["order_status"] == "not_ordered"
      and rep["no_ordering_action"] is True)

npass = sum(1 for ok in checks if ok)
print("%d/%d M7R checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
