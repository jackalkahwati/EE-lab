"""M2 regression: bare-MCU productization track v1."""
import json
import os
import sys

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui", "public", "runs")


def art(run, name):
    p = os.path.join(RUNS, run, "data", name + ".json")
    return json.load(open(p)) if os.path.exists(p) else None


GA, GB = "bare-rp2040-pico-replacement-v1", "fl1-core6-bare-rp2040-combination-v1"
ra = art(GA, "compose-pico-replacement-board-report")
check("1 Gate A board PASSED 26/26, 0 DRC",
      ra["status"] == "PASSED" and ra["routing"] == "26/26" and ra["drc"] == 0)
check("2 Gate A role complete (12/12 with review)",
      "role_complete_with_review" in ra["role"])
check("3 Gate A includes GPIO breakout on REAL nets",
      "GPIO breakout" in ra["contents"] and "REAL MCU nets" in ra["contents"])
check("4 five escape-engineering fixes recorded",
      len(ra["escape_engineering"]) == 5)
check("5 no Pico-compatible/boot claim",
      "NO boot" in ra["honesty"] and "Pico-compatible" in ra["honesty"])
rb = art(GB, "compose-core6-combination-report")
check("6 Gate B Core-6 PASSED 65/65, 0 DRC",
      rb["status"] == "PASSED" and rb["routing"] == "65/65" and rb["drc"] == 0)
check("7 Gate B role complete (16/16)",
      "role_complete_with_review" in rb["role"])
check("8 18.8 history preserved (55/65 then, 65/65 now)",
      "55/65" in rb["history"])
check("9 modular FL-1 boards remain the fallback",
      "modular FL-1 boards remain" in rb["fallback"])
check("10 blocked claims include FL1_replacement + cost_down",
      "FL1_replacement" in rb["blocked_claims"]
      and "cost_down_verified" in rb["blocked_claims"])
blk = art(GB, "compose-core6-integration-blocker-report")
check("11 blocker report v2: resolved IN SANDBOX, physical absent",
      "RESOLVED IN SANDBOX" in blk["state"] and "physical evidence still "
      "absent" in blk["state"])
packs = art(GA, "compose-m2-pack-updates")
check("12 pico_replacement_pack + fl1_monolith_pack routed_in_sandbox only",
      "routed_in_sandbox" in packs["pico_replacement_pack"]["state"]
      and "routed_in_sandbox" in packs["fl1_monolith_pack"]["state"])
flu = art(GA, "compose-m2-fleet-learning-update")
check("13 fleet: next = M3 physical first article",
      "M3" in flu["next_milestone"])
qfn = art("bare-mcu-qfn56-core-sandbox-v1", "bare-mcu-qfn56-core-sandbox-compose-run")
check("14 QFN sandbox regression re-verified under fanout changes",
      qfn["status"] == "PASSED")
import production_line as pl
check("15 production_ready unreachable",
      pl.readiness_state({}) == "first_article_ready_for_human_approval")
led = art("power-entry-header-2l", "compose-physical-evidence-ledger")
check("16 ledger untouched (empty, nothing ordered)",
      led["artifacts"] == [] and led["order_status"] == "not_ordered")

npass = sum(1 for ok in checks if ok)
print("%d/%d M2 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
