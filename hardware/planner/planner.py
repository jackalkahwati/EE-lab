"""Planner orchestrator (Phases 8, 9, 20) — turn a Design Intent Model into a
buildable design, honestly.

  from planner import run
  result = run(prompt)

result keys:
  intent           : the Design Intent Model
  resolutions      : per exact-part-request resolution
  recovery_report  : every substitution the recovery loop made (never silent)
  honest_report    : per requested item -> built / substituted / unsupported + reason
  final_design     : the list of resolved UCS specs to actually build
  ingested         : parts ingested on the fly (not previously in the library)
  overall_status   : fully_supported | generated_with_substitutions | partial | failed
"""
from intent import parse_intent
from resolver import (resolve_part_request, resolve_capability, part_capabilities)
from recovery import recover, recover_interface, recover_fine_pitch_connector
from seeds import build_seeds


def run(prompt, recover_routing=True):
    di = parse_intent(prompt)
    lib = build_seeds()
    seed_mpns = set(lib)

    resolutions, recovery_report, honest, final_design = [], [], [], []
    ingested = []

    def add_to_design(spec):
        if spec and spec["mpn"] not in {s["mpn"] for s in final_design}:
            final_design.append(spec)

    # ---- exact part requests ------------------------------------------------
    for req in di["exact_part_requests"]:
        res = resolve_part_request(req["mpn"], lib)
        resolutions.append(res)
        if res["source"].startswith("ingested") and res["mpn"] not in seed_mpns:
            ingested.append(res["spec"])
        if res["status"] == "supported" and not req["must_substitute"]:
            add_to_design(res["spec"])
            honest.append({"request": req["mpn"], "outcome": "built",
                           "mpn": res["mpn"], "source": res["source"]})
        else:
            intended = req["intended_capabilities"] or res.get("capabilities") or []
            if not intended:
                # A part number the user typed that nothing here understands. With no
                # capability model there is nothing to preserve, so recovery would
                # just hand back an unrelated part (it proposed a DS18B20 for an
                # AMS1117 regulator). Say so instead.
                honest.append({"request": req["mpn"], "outcome": "unsupported",
                               "reason": "not in the seed library and no capability model for it"})
                continue
            rec = recover(res, intended, lib)
            recovery_report.append(rec)
            if rec["recovered"]:
                add_to_design(rec["proposed_spec"])
                honest.append({"request": req["mpn"], "outcome": "substituted",
                               "mpn": rec["proposed"],
                               "preserved": rec["capabilities_preserved"],
                               "lost": rec["capabilities_lost"],
                               "requires_approval": rec["requires_approval"]})
            else:
                honest.append({"request": req["mpn"], "outcome": "unsupported",
                               "reason": rec["blocker"]})

    # ---- required capabilities not yet covered ------------------------------
    def covered():
        c = set()
        for s in final_design:
            c |= set(part_capabilities(s))
        return c

    for cap in di["required_capabilities"]:
        if cap in covered():
            continue
        res = resolve_capability(cap, lib)
        if res["status"] == "supported" and res["spec"]:
            add_to_design(res["spec"])
            honest.append({"request": cap, "outcome": "built", "mpn": res["mpn"],
                           "source": "capability->" + res["mpn"]})
        else:
            honest.append({"request": cap, "outcome": "unsupported",
                           "reason": "; ".join(res["reasons"])})

    # ---- unsupported/risky standalone requests (e.g. Ethernet) --------------
    for risky in di["unsupported_or_risky"]:
        r = risky["request"].lower()
        if "ethernet" in r:
            rec = recover_interface("ethernet", ["networking"], lib)
            recovery_report.append(rec)
            honest.append({"request": "Ethernet",
                           "outcome": "substituted" if rec["recovered"] else "unsupported",
                           "mpn": rec.get("proposed"),
                           "preserved": rec.get("capabilities_preserved"),
                           "lost": rec.get("capabilities_lost"),
                           "requires_approval": rec.get("requires_approval")})

    # ---- routing-capability recovery: fine-pitch USB-C power connector ------
    # The current UCS synth path can't route a fine-pitch USB-C receptacle (VBUS
    # feeds the non-plane +5V rail). When the intent is just 5V/USB-C power,
    # substitute a coarse supported power connector so the board is buildable —
    # reported in full, flagged for approval. USB-C stays on the roadmap.
    if recover_routing:
        usb = next((s for s in final_design
                    if s.get("category", "").startswith("connector.usb")
                    and "USB_C_Receptacle" in (s.get("kicad_footprint") or "")), None)
        if usb and (di["power"].get("source") == "usb_c"
                    or "usb-c" in di["product_goal"].lower()):
            rec = recover_fine_pitch_connector(usb, lib)
            recovery_report.append(rec)
            if rec["recovered"]:
                final_design[:] = [s for s in final_design if s["mpn"] != usb["mpn"]]
                add_to_design(rec["proposed_spec"])
                honest[:] = [h for h in honest if h.get("mpn") != usb["mpn"]]
                honest.append({"request": "USB-C power input", "outcome": "substituted",
                               "mpn": rec["proposed"],
                               "preserved": rec["capabilities_preserved"],
                               "lost": rec["capabilities_lost"], "requires_approval": True})

    # ---- storage right-sizing (design-of-N over the pin-compatible flash family)
    # The resolver picks the family default (128 Mbit). Size it to what the product
    # actually needs: the SMALLEST W25Q that meets the storage requirement, so we
    # don't pay board area/$ for capacity that goes unused. Same SOIC-8 + SPI
    # pinout across the family, so the swap is drop-in. Reported with the sizing
    # assumption, never silent.
    try:
        from subsystems import design_storage_from_intent
        flash = next((s for s in final_design
                      if s.get("category", "").startswith("memory")
                      or str(s.get("mpn", "")).startswith("W25Q")), None)
        if flash:
            sd = design_storage_from_intent(di, final_design)
            chosen = sd.get("chosen")
            if chosen and chosen in lib and chosen != flash["mpn"]:
                final_design[:] = [s for s in final_design if s["mpn"] != flash["mpn"]]
                add_to_design(lib[chosen])
                honest[:] = [h for h in honest if h.get("mpn") != flash["mpn"]]
                honest.append({"request": "storage", "outcome": "built", "mpn": chosen,
                               "source": "right-sized:%s->%s" % (flash["mpn"], chosen),
                               "note": "%s — %s" % (sd["rationale"], sd["assumption"])})
    except Exception:
        pass

    # ---- MCU (a Compose block, not a UCS part) ------------------------------
    if di["mcu"]["family"]:
        honest.append({"request": di["mcu"]["family"] + " MCU", "outcome": "built",
                       "mpn": di["mcu"]["family"], "source": "compose_block:mcu"})

    # ---- overall status -----------------------------------------------------
    any_sub = any(h["outcome"] == "substituted" for h in honest)
    any_unsup = any(h["outcome"] == "unsupported" for h in honest)
    approvals = [h for h in honest if h.get("requires_approval")]
    if any_unsup:
        overall = "partial"
    elif any_sub:
        overall = "generated_with_substitutions"
    else:
        overall = "fully_supported"

    return {
        "intent": di, "resolutions": resolutions,
        "recovery_report": recovery_report, "honest_report": honest,
        "final_design": final_design, "ingested": ingested,
        "requires_approval": approvals, "overall_status": overall,
    }


# ---- human-readable demo output ---------------------------------------------
def _print(result):
    di = result["intent"]
    print("=" * 74)
    print("DESIGN INTENT MODEL")
    print("=" * 74)
    print("  goal:", di["product_goal"])
    print("  MCU:", di["mcu"]["family"], "| programming:", di["mcu"]["programming"])
    print("  power:", di["power"]["source"], "| rails:", di["power"]["rails"])
    print("  required capabilities:", ", ".join(di["required_capabilities"]))
    print("  exact part requests:")
    for e in di["exact_part_requests"]:
        flag = " [must substitute if unsupported]" if e["must_substitute"] else ""
        print("    - %s%s" % (e["mpn"], flag))
    print("  buses:", ", ".join(di["buses"]))
    print("  FL-1 validation:", di["fl1_validation"]["required"])
    print("  flagged unsupported/risky:", [r["request"] for r in di["unsupported_or_risky"]])

    print("\n" + "=" * 74)
    print("RECOVERY / SUBSTITUTION REPORT (nothing silent)")
    print("=" * 74)
    if not result["recovery_report"]:
        print("  (no substitutions needed)")
    for r in result["recovery_report"]:
        print("  %s -> %s [%s]" % (r["original_request"], r["proposed"], r["substitution_type"]))
        print("    blocker:", r["blocker"])
        print("    preserved:", r["capabilities_preserved"])
        print("    LOST:", r["capabilities_lost"],
              "  requires approval:", r["requires_approval"], " conf:", r["confidence"])

    print("\n" + "=" * 74)
    print("HONEST BUILD REPORT (per requested item)")
    print("=" * 74)
    for h in result["honest_report"]:
        line = "  [%-11s] %s" % (h["outcome"].upper(), h["request"])
        if h.get("mpn") and h["mpn"] != h["request"]:
            line += " -> " + str(h["mpn"])
        if h.get("lost"):
            line += "  (lost: %s)" % ", ".join(h["lost"])
        if h.get("reason"):
            line += "  reason: " + h["reason"]
        print(line)

    print("\n" + "=" * 74)
    print("PROVENANCE / CONFIDENCE (ingested + substituted parts)")
    print("=" * 74)
    for s in result["final_design"]:
        crit = {k: v for k, v in (s.get("confidence") or {}).items()}
        prov = s.get("provenance", {})
        print("  %-16s status:%-10s pins:%s(%s) fp:%s(%s) iface:%s(%s)" % (
            s["mpn"], s["support_status"],
            prov.get("pins", "?"), crit.get("pins", "?"),
            prov.get("kicad_footprint", "?"), crit.get("kicad_footprint", "?"),
            prov.get("interfaces", "?"), crit.get("interfaces", "?")))

    print("\n" + "=" * 74)
    print("FINAL BUILDABLE DESIGN:", len(result["final_design"]), "components |",
          "overall:", result["overall_status"].upper())
    print("=" * 74)
    for s in result["final_design"]:
        print("  %-16s %-26s %s" % (s["mpn"], s["category"],
              ",".join(i["type"] for i in s["interfaces"])))
    if result["ingested"]:
        print("  ingested on the fly:", [s["mpn"] for s in result["ingested"]])
    if result["requires_approval"]:
        print("  NEEDS HUMAN APPROVAL:", [h["request"] for h in result["requires_approval"]])


DEMO_PROMPT = (
    "Build an RP2040-based industrial sensor hub with USB-C power, BME280, "
    "INA219, W25Q SPI flash, MAX3485 RS485, MCP2515 CAN controller, 74HC595 LED "
    "driver, one unsupported "
    "environmental sensor that must be substituted if needed, SWD programming, "
    "UART debug, and FL-1 validation support.")

if __name__ == "__main__":
    import sys
    prompt = " ".join(sys.argv[1:]) or DEMO_PROMPT
    _print(run(prompt))
