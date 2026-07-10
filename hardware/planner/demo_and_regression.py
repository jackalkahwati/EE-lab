#!/usr/bin/env python3
"""Golden demo + regression suite for the Compose pipeline.

Locks down the win: the existing block pipeline (comms, relay, DC-measure) AND
the new UCS synth + recovery loop (industrial sensor hub) must keep behaving as
recorded. Runs each case through the REAL pipeline on the lab workstation and
checks the routed-net count, DRC violations, unconnected count, ERC, and the
presence of the recovery report / FL-1 Validation Package where expected.

  python3 demo_and_regression.py golden       # run the golden demo only
  python3 demo_and_regression.py regression   # run the full regression suite
  python3 demo_and_regression.py <case>       # run one named case

Needs the Compose server on :4500 and an authenticated cookie jar (COOKIE env or
/tmp/fl-jar3.txt). Each case reads the run's own artifacts from public/runs/<id>.
"""
import base64
import json
import os
import re
import subprocess
import sys
import urllib.parse

import planner

BASE = os.environ.get("COMPOSE_BASE", "http://localhost:4500")
COOKIE = os.environ.get("COOKIE", "/tmp/fl-jar3.txt")
RUNS = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    "..", "..", "software", "prompt-to-pcb-ui", "public", "runs")

GOLDEN_PROMPT = (
    "Build an RP2040-based industrial sensor hub with USB-C power, BME280, "
    "INA219, W25Q SPI flash, MAX3485 RS485, 74HC595 LED driver, SWD programming, "
    "UART debug, and FL-1 validation support.")


def _slim(s):
    return {"mpn": s["mpn"], "category": s["category"],
            "kicad_footprint": s["kicad_footprint"],
            "pins": [{"number": p["number"], "name": p["name"], "etype": p["etype"]}
                     for p in s["pins"]],
            "power": {"pins": s["power"]["pins"], "vcc_min": s["power"].get("vcc_min")},
            "interfaces": s["interfaces"], "support_circuit": s.get("support_circuit", {}),
            "capabilities": s.get("capabilities", [])}


def _synth_design(recover_routing):
    r = planner.run(GOLDEN_PROMPT, recover_routing=recover_routing)
    return {"final_design": [_slim(s) for s in r["final_design"]],
            "intent": {"product_goal": r["intent"]["product_goal"], "mcu": r["intent"]["mcu"]},
            "recovery_report": r["recovery_report"]}


def _compose_spec(blocks, cls):
    return {"blocks": blocks, "boardClass": cls}


def _run(runid, mode, payload, prompt="regression"):
    """Fire the pipeline (SSE) and wait for it to finish; return the raw stream."""
    if mode == "compose":
        arg = "compose=1&spec=" + urllib.parse.quote(
            base64.b64encode(json.dumps(payload).encode()).decode())
    else:
        arg = "synth=1&design=" + urllib.parse.quote(
            base64.b64encode(json.dumps(payload).encode()).decode())
    url = "%s/api/pipeline/run?prompt=%s&runId=%s&%s" % (
        BASE, urllib.parse.quote(prompt), runid, arg)
    p = subprocess.run(["curl", "-sN", "-b", COOKIE, "--max-time", "500", url],
                       capture_output=True, text=True)
    return p.stdout


def _artifacts(runid, stream):
    """Read the run's own artifacts + a couple of facts from the stream."""
    d = os.path.join(RUNS, runid, "data")
    out = {"status": None, "violations": None, "unconnected": None, "erc": None,
           "routed": None, "recovery": False, "fl1": False}
    m = re.findall(r'"status":"([A-Z ]+)"', stream)
    out["status"] = m[-1] if m else None
    r = re.search(r'(\d+) attempted, (\d+) routed, (\d+) failed', stream)
    if r:
        out["routed"] = "%s/%s" % (r.group(2), r.group(1))
    out["erc"] = "PASS" if re.search(r"ERC: 0 errors", stream) else (
        "FAIL" if "ERC:" in stream else None)
    try:
        drc = json.load(open(os.path.join(d, "drc.json")))
        out["violations"] = len([v for v in (drc.get("violations") or [])
                                 if v.get("type") != "solder_mask_bridge"])
        out["unconnected"] = len(drc.get("unconnected_items") or [])
    except Exception:
        pass
    out["recovery"] = os.path.exists(os.path.join(d, "recovery.json"))
    out["fl1"] = os.path.exists(os.path.join(d, "fl1-validation.json"))
    return out


# case -> (mode, payload_fn, expectation_fn(art) -> (ok, why))
def _exp_clean_block(a):
    ok = a["status"] == "PASSED" and a["violations"] == 0 and a["unconnected"] == 0
    return ok, "PASSED 0/0" if ok else "expected PASSED 0/0, got %s" % a

def _exp_dcm(a):
    # known state: geometry stitch clears the stitch vias; the remaining flroute
    # track-clearance issue (Fix B) leaves <=1 hard violation, 0 unconnected.
    ok = a["unconnected"] == 0 and (a["violations"] or 0) <= 1
    return ok, ("known state (%s viol, 0 unconn)" % a["violations"]) if ok \
        else "expected 0 unconnected + <=1 violation, got %s" % a

def _exp_recovery(a):
    ok = (a["status"] == "PASSED" and a["violations"] == 0 and a["unconnected"] == 0
          and a["recovery"] and a["fl1"])
    return ok, "PASSED 0/0 + recovery + FL-1 pkg" if ok else \
        "expected PASSED 0/0 with recovery + FL-1, got %s" % a

def _exp_strict(a):
    # strict USB-C, no substitution: must fail honestly (or need approval), never
    # a silent clean pass.
    ok = a["status"] != "PASSED"
    return ok, "failed honestly (%s)" % a["status"] if ok else \
        "expected honest failure, got PASSED (would be a silent pass)"

CASES = {
    "comms": ("compose", lambda: _compose_spec(["power", "mcu", "can bus comms"],
              "fl1-comms-head-can"), _exp_clean_block),
    "relay": ("compose", lambda: _compose_spec(["power", "mcu", "relay probe matrix"],
              "fl1-relay-matrix"), _exp_clean_block),
    "dc-measure": ("compose", lambda: _compose_spec(["power", "mcu", "current sense instrument"],
                   "fl1-dc-measure"), _exp_dcm),
    "ucs-hub-recovery": ("synth", lambda: _synth_design(recover_routing=True), _exp_recovery),
    "ucs-hub-strict": ("synth", lambda: _synth_design(recover_routing=False), _exp_strict),
}


def run_case(name):
    mode, payload_fn, exp_fn = CASES[name]
    runid = "regr-" + name
    stream = _run(runid, mode, payload_fn(), prompt="regression " + name)
    art = _artifacts(runid, stream)
    ok, why = exp_fn(art)
    print("  [%s] %-18s route=%s viol=%s unconn=%s erc=%s status=%s rec=%s fl1=%s"
          % ("PASS" if ok else "FAIL", name, art["routed"], art["violations"],
             art["unconnected"], art["erc"], art["status"], art["recovery"], art["fl1"]))
    if not ok:
        print("        -> %s" % why)
    return ok


def main():
    what = sys.argv[1] if len(sys.argv) > 1 else "regression"
    if what == "golden":
        print("GOLDEN DEMO: industrial sensor hub (with recovery)")
        ok = run_case("ucs-hub-recovery")
        print("golden demo:", "OK" if ok else "FAILED")
        sys.exit(0 if ok else 1)
    if what in CASES:
        sys.exit(0 if run_case(what) else 1)
    print("REGRESSION SUITE (%d cases) — each runs the real pipeline" % len(CASES))
    results = {name: run_case(name) for name in CASES}
    npass = sum(results.values())
    print("\n%d/%d cases pass" % (npass, len(results)))
    sys.exit(0 if npass == len(results) else 1)


if __name__ == "__main__":
    main()
