"""Failure taxonomy (Phase 1) — classify board-generation failures into a
structured, actionable form the recovery orchestrator can reason over.

Input is whatever evidence a pipeline run produced (DRC json, routing counts, ERC,
synth notes, MCU decision). Output is a list of structured failures, each naming
the affected component / net / footprint, a severity, whether automatic recovery
is allowed, whether a human must approve, and a short explanation. Nothing is
invented — every failure points at real evidence.

  from failure_taxonomy import classify
  failures = classify(result)     # result = {drc, unconnected, erc, routed, ...}
"""
import re

# failure types (stable identifiers the strategy library keys off)
FINE_PITCH_ESCAPE = "fine_pitch_escape"
CLEARANCE = "clearance"
UNCONNECTED = "unconnected_nets"
KEEPOUT_PLACEMENT = "keepout_placement"
ERC = "erc"
FOOTPRINT_MISMATCH = "footprint_mismatch"
MISSING_PASSIVE = "missing_required_passive"
PIN_ALLOCATION = "pin_allocation"
MCU_UNFIT = "mcu_unfit"
HIGH_SPEED_UNSUPPORTED = "high_speed_unsupported"
HIGHSPEED_PAIR_FAIL = "highspeed_pair_fail"      # a routed pair failed length/skew
COMPONENT_UNSUPPORTED = "component_unsupported"
SOURCING = "sourcing"

_FINE_PITCH_FP = re.compile(r"P0\.[1-5]\d*mm|QFN|DFN|WSON|USON|VSSOP|LGA|TSSOP", re.I)
_REF = re.compile(r"\bof ([A-Z]{1,3}\d+)\b")            # "... of U2 ..."
_NET = re.compile(r"\[([^\]]+)\]")                      # "Pad 9 [I2C_SDA]"


def _refs_nets(items):
    refs, nets = set(), set()
    for it in items or []:
        d = it.get("description", "")
        m = _REF.search(d)
        if m:
            refs.add(m.group(1))
        n = _NET.search(d)
        if n:
            nets.add(n.group(1))
    return sorted(refs), sorted(nets)


def _footprint_for(ref, devices):
    for d in devices or []:
        if d.get("ref") == ref:
            return d.get("footprint") or d.get("name")
    return None


def classify(result):
    """result keys (all optional): drc (kicad drc json), unconnected (int),
    routed (str "n/m"), erc (list|None), devices (list), synth_notes (list),
    mcu (dict), fine_pitch_refs (list)."""
    failures = []
    devices = result.get("devices", [])
    fine_fps = set(result.get("fine_pitch_refs", []))

    # ---- DRC violations ----
    drc = result.get("drc") or {}
    for v in drc.get("violations", []):
        desc = v.get("description", "")
        if v.get("type") == "solder_mask_bridge":
            continue
        refs, nets = _refs_nets(v.get("items", []))
        is_clearance = "clearance" in desc.lower()
        # a clearance violation whose ref sits on a fine-pitch land, between two
        # different nets, is a FINE-PITCH ESCAPE problem (not generic clearance)
        fine = False
        for r in refs:
            fp = _footprint_for(r, devices) or ""
            if _FINE_PITCH_FP.search(fp) or r in fine_fps:
                fine = True
        deficit = None
        req = re.search(r"clearance\s+([\d.]+)\s*mm", desc)
        act = re.search(r"actual\s+([\d.]+)\s*mm", desc)
        if req and act:
            deficit = round(float(req.group(1)) - float(act.group(1)), 4)
        if is_clearance and fine:
            failures.append({
                "type": FINE_PITCH_ESCAPE, "severity": "high",
                "components": refs, "nets": nets,
                "footprint": next((_footprint_for(r, devices) for r in refs), None),
                "deficit_mm": deficit,
                "auto_recovery": True, "requires_approval": False,
                "evidence": desc,
                "explanation": "a signal escaping a fine-pitch land clears an "
                               "adjacent-net feature by less than the fab minimum",
            })
        elif is_clearance:
            failures.append({
                "type": CLEARANCE, "severity": "high", "components": refs,
                "nets": nets, "deficit_mm": deficit, "auto_recovery": True,
                "requires_approval": False, "evidence": desc,
                "explanation": "two features of different nets are too close",
            })
        else:
            failures.append({
                "type": CLEARANCE, "severity": "medium", "components": refs,
                "nets": nets, "auto_recovery": True, "requires_approval": False,
                "evidence": desc, "explanation": desc[:80]})

    # ---- unconnected nets (routing incomplete) ----
    unconn = result.get("unconnected", 0)
    if unconn:
        items = drc.get("unconnected_items", [])
        refs, nets = _refs_nets(items)
        # unconnected near a module with a big keepout -> keepout placement problem
        keepout = any("WROOM" in (_footprint_for(r, devices) or "") or
                      "MDBT50Q" in (_footprint_for(r, devices) or "") for r in refs)
        failures.append({
            "type": KEEPOUT_PLACEMENT if keepout else UNCONNECTED,
            "severity": "high", "components": refs, "nets": nets,
            "count": unconn, "auto_recovery": True, "requires_approval": False,
            "evidence": "%d unconnected pad-pair(s)" % unconn,
            "explanation": ("a module's antenna keepout crowds the routing"
                            if keepout else "the router could not close every net"),
        })

    # ---- ERC ----
    erc = result.get("erc")
    if isinstance(erc, list) and erc:
        failures.append({"type": ERC, "severity": "high", "components": [],
                         "nets": [], "auto_recovery": False, "requires_approval": True,
                         "evidence": "; ".join(str(e) for e in erc[:3]),
                         "explanation": "electrical-rules errors need design review"})

    # ---- synth notes (dropped parts, footprint issues) ----
    for note in result.get("synth_notes", []):
        reason = note.get("reason", "") if isinstance(note, dict) else str(note)
        mpn = note.get("mpn", "") if isinstance(note, dict) else ""
        t = FOOTPRINT_MISMATCH if "footprint" in reason.lower() else COMPONENT_UNSUPPORTED
        failures.append({"type": t, "severity": "high", "components": [mpn],
                        "nets": [], "auto_recovery": True, "requires_approval": False,
                        "evidence": reason, "explanation": "a component could not be placed"})

    # ---- high-speed differential pairs that failed length/skew compliance ----
    hs = result.get("highspeed") or {}
    for r in hs.get("routes", []):
        if r.get("required") and r.get("status") not in ("routed_and_checked", None):
            failures.append({
                "type": HIGHSPEED_PAIR_FAIL, "severity": "high",
                "components": [], "nets": [r.get("positive"), r.get("negative")],
                "auto_recovery": True, "requires_approval": False,
                "evidence": "; ".join(r.get("compliance_fails", [])) or r.get("reason", ""),
                "explanation": "a required %s pair did not meet length/skew — never "
                               "auto-relax a required high-speed constraint" % r.get("interface", ""),
            })

    # ---- MCU / pin allocation ----
    mcu = result.get("mcu") or {}
    if mcu.get("conflicts"):
        failures.append({"type": PIN_ALLOCATION, "severity": "high",
                        "components": [mcu.get("mcu")], "nets": [],
                        "auto_recovery": True, "requires_approval": False,
                        "evidence": "%d pin conflict(s)" % mcu["conflicts"],
                        "explanation": "the MCU could not satisfy every pin request"})
    if mcu.get("needs_recovery"):
        failures.append({"type": MCU_UNFIT, "severity": "high",
                        "components": [mcu.get("requested")], "nets": [],
                        "auto_recovery": True, "requires_approval": True,
                        "evidence": mcu.get("blocker", ""),
                        "explanation": "the requested MCU cannot meet the design"})
    return failures


def summarize(failures):
    return {
        "count": len(failures),
        "types": sorted({f["type"] for f in failures}),
        "auto_recoverable": sum(1 for f in failures if f["auto_recovery"]),
        "needs_approval": sum(1 for f in failures if f["requires_approval"]),
        "highest_severity": ("high" if any(f["severity"] == "high" for f in failures)
                             else "medium" if failures else "none"),
    }
