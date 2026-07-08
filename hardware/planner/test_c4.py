"""C4 regression: USB full-speed data path."""
import json
import os
import sys

import usb_fs

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "  -> " + detail if detail else ""))


HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, "..", "..", "software", "prompt-to-pcb-ui", "public",
                 "runs", "fl1-backplane-v1", "data")
B = json.load(open(os.path.join(
    D, "usb-full-speed-benchmark-report.json")))["benchmarks"]

check("1 advisory contract BLOCKS today with exact missing primitives "
      "(ESD + router pair proof)",
      B["rp2040_usb_fs_advisory"]["state"] == "blocked"
      and any("esd" in m for m in
              B["rp2040_usb_fs_advisory"]["missing_primitives"])
      and any("dp_dm_pair_routing" in m for m in
              B["rp2040_usb_fs_advisory"]["missing_primitives"]))
check("2 with all primitives: generatable_review_required, never functional",
      B["rp2040_usb_fs_all_primitives"]["state"]
      == "generatable_review_required"
      and "not functional" in B["rp2040_usb_fs_all_primitives"]["honesty"])
c = B["rp2040_usb_fs_all_primitives"]["contract"]
check("3 D+/D- treated as a pair with geometry REQUIREMENTS (review "
      "targets, not claims)",
      c["pair_metadata"]["pair"] == ["USB_DP", "USB_DM"]
      and "not" in c["pair_metadata"]["geometry_requirements"]["note"])
check("4 impedance rides M3B: refused without sourced stackup",
      c["impedance"]["result_status"] == "skipped_missing_input"
      and B["missing_stackup_impedance"]["result_status"]
      == "skipped_missing_input")
check("5 power-only board makes no data claim (M3B finding intact)",
      "NO USB data nets" in B["usbc_power_only_no_data_claim"]["m3b_finding"])
check("6 unsupported connector blocks honestly",
      B["unsupported_connector"]["state"] == "blocked")
check("7 USB-HS and USB3 remain architecture_only via M11R gates",
      B["usb_hs_request"]["path"] == "blocked_by_m11r"
      and B["usb3_request"]["path"] == "blocked_by_m11r")
check("8 compliance/certification/PD/controlled-impedance always blocked",
      all(x in usb_fs.BLOCKED_ALWAYS for x in
          ("USB_compliance", "usb_c_power_delivery",
           "controlled_impedance_claim")))
check("9 validation plan ends before any function claim (enumeration is "
      "FUTURE)",
      any("FUTURE" in s for s in usb_fs.VALIDATION_PLAN)
      and any("no compliance claim" in s for s in usb_fs.VALIDATION_PLAN))
check("10 ESD placement bound to the C1 connector rule",
      "esd_near_connector" in c["esd"]["placement"])

npass = sum(1 for ok in checks if ok)
print("%d/%d C4 checks pass" % (npass, len(checks)))
sys.exit(0 if npass == len(checks) else 1)
