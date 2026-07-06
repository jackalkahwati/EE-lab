"""Fine-pitch escape model (Phase 13, gate A).

First-class model of how hard it is to ESCAPE (fan out) each fine-pitch package
on a board, independent of whether the global router then succeeds. The real
FL-1 blocker is not shared-bus topology, it is getting 4 signals out of a
0.5mm-pitch TSSOP-10. This model names that difficulty per component so the
router, the benchmarks, and signoff all agree on it.

Difficulty classes:
  easy_escape        >= 0.8mm pitch, or <= 2 signal escapes on the busy side
  moderate_escape    0.5-0.65mm pitch with <= 2 escapes per side
  dense_escape       0.5mm pitch with 3-4 escapes per side (the ADS1115 case)
  unsupported_escape BGA, or < 0.4mm pitch, or > 4 escapes per side

Nothing here fakes a route. It reads footprint geometry + the wired nets and
reports difficulty + the exact blocker a dense case will hit.
"""
import json
import re

# grid pitch flroute uses = (track_width + clearance) * 1.15; a fine-pitch part
# escapes cleanly only when adjacent pad pitch comfortably exceeds this so two
# escapes land in distinct, non-contending grid cells.
DEFAULT_TRACK = 0.2
DEFAULT_CLEAR = 0.2


def _pitch_mm(fp):
    """Pin pitch from a footprint name (P0.5mm -> 0.5). None if not encoded."""
    m = re.search(r"P(\d+\.?\d*)mm", fp or "")
    if m:
        return float(m.group(1))
    # SOIC/SOT default pitches when the name omits P#
    up = (fp or "").upper()
    if "SOT-23" in up or "SOT23" in up:
        return 0.95
    if "SOIC" in up:
        return 1.27
    return None


def _package(fp):
    up = (fp or "").upper()
    for pkg in ("BGA", "QFN", "DFN", "WSON", "USON", "TSSOP", "SSOP", "VSSOP",
                "MSOP", "LGA", "SOIC", "SOP", "SOT-23", "SOT23", "SOT", "TQFP",
                "LQFP", "QFP", "DIP"):
        if pkg.replace("-", "") in up.replace("-", ""):
            return pkg
    return "unknown"


def grid_pitch(track=DEFAULT_TRACK, clearance=DEFAULT_CLEAR):
    return round((track + clearance) * 1.15, 3)


def classify(pitch, escapes_busy_side, package):
    """Difficulty from pitch + the number of signals that must escape the busiest
    side + the package family."""
    if package == "BGA":
        return "unsupported_escape", "BGA fanout not implemented (needs via-in-pad + inner signal layers)"
    if pitch is None:
        return "moderate_escape", "pin pitch unknown from footprint name — treated as moderate"
    if pitch < 0.4:
        return "unsupported_escape", "< 0.4mm pitch exceeds router grid resolution"
    gp = grid_pitch()
    if pitch >= 0.8:
        return "easy_escape", None                     # coarse pitch, escapes have room
    if escapes_busy_side <= 1:
        return "moderate_escape", None                 # one escape per side clears even fine pitch
    if pitch >= 0.65 and escapes_busy_side <= 2:
        return "moderate_escape", None
    if pitch >= 0.5 and escapes_busy_side <= 4:
        # the ADS1115 case: >=2 ADJACENT escapes at 0.5mm pitch. The grid pitch
        # (~%.2fmm) is close to the pad pitch, so adjacent escapes contend for
        # grid cells and can short at the pad exit.
        return "dense_escape", ("%d adjacent escapes at %.2fmm pitch vs %.2fmm router "
                                "grid: escapes contend for grid cells at the pad exit "
                                "(blocked_by_grid_resolution risk)"
                                % (escapes_busy_side, pitch, gp))
    return "unsupported_escape", ("%d escapes on one side at %.2fmm pitch exceeds "
                                  "single-layer fanout" % (escapes_busy_side, pitch))


def _escape_pins(spec, netmap):
    """Signal pins that need to be ROUTED out (not plane-served power/ground).
    Returns [(pad, name, net)]. netmap: {pad: net}."""
    out = []
    for p in spec.get("pins", []):
        num = p["number"]
        net = (netmap or {}).get(num)
        if not net:
            continue
        if net in ("GND", "+3V3", "+5V", "+1V8", "VCC", "AGND") and p["etype"] in ("power_in", "ground"):
            continue  # plane / via-served, not a lateral escape
        if p["etype"] in ("ground",) or net == "GND":
            continue
        out.append((num, p["name"], net))
    return out


def model_component(spec, netmap=None):
    """Fine-pitch escape entry for one component (None if not fine-pitch)."""
    fp = spec.get("kicad_footprint", "")
    pitch = _pitch_mm(fp)
    pkg = _package(fp)
    pad_count = len(spec.get("pins", []))
    # only fine-pitch parts are interesting: <= 0.65mm pitch, or BGA/QFN
    if pkg not in ("BGA", "QFN", "DFN", "WSON", "USON") and (pitch is None or pitch > 0.65):
        return None
    escapes = _escape_pins(spec, netmap)
    # split escapes across the two long sides of a dual-row package: worst case
    # is all on one side, but I2C+analog on an ADC usually splits ~half/half
    per_side = max(1, (len(escapes) + 1) // 2) if pkg in ("TSSOP", "SSOP", "VSSOP",
                  "MSOP", "SOIC", "SOP", "SOT-23", "SOT23", "SOT") else len(escapes)
    difficulty, blocker = classify(pitch, per_side, pkg)
    return {
        "ref": spec.get("_ref") or spec.get("mpn"),
        "mpn": spec.get("mpn"),
        "package": pkg,
        "footprint": fp.split(":")[-1] if fp else None,
        "pin_pitch_mm": pitch,
        "pad_count": pad_count,
        "required_escape_pins": [{"pad": n, "name": nm, "net": net} for n, nm, net in escapes],
        "escape_count": len(escapes),
        "escapes_busy_side": per_side,
        "preferred_layer": "F.Cu (top), via to B.Cu once spread",
        "route_width_mm": DEFAULT_TRACK,
        "clearance_mm": DEFAULT_CLEAR,
        "grid_pitch_mm": grid_pitch(),
        "grid_requirement_mm": round(pitch / 2, 3) if pitch else None,
        "via_requirement": "dogbone via does NOT fit between %.2fmm-pitch pads; "
                           "escape on surface then via once spread" % pitch if pitch else "n/a",
        "fanout_type": ("surface_fanout" if difficulty in ("easy_escape", "moderate_escape")
                        else "surface_fanout_contended" if difficulty == "dense_escape"
                        else "unsupported"),
        "expected_difficulty": difficulty,
        "blocker": blocker,
    }


def build_model(design, netmaps=None):
    """Model every fine-pitch component in a design. netmaps: {mpn: {pad: net}}."""
    specs = [s for s in design.get("final_design", []) if s.get("pins")]
    comps = []
    for s in specs:
        nm = (netmaps or {}).get(s.get("mpn"))
        entry = model_component(s, nm)
        if entry:
            comps.append(entry)
    worst = "easy_escape"
    order = ["easy_escape", "moderate_escape", "dense_escape", "unsupported_escape"]
    for c in comps:
        if order.index(c["expected_difficulty"]) > order.index(worst):
            worst = c["expected_difficulty"]
    return {"version": "v1", "fine_pitch_component_count": len(comps),
            "worst_case": worst, "grid_pitch_mm": grid_pitch(), "components": comps}


def to_markdown(model):
    lines = ["# Fine-pitch escape model", "",
             "Version %s - %d fine-pitch component(s), worst case **%s**, router grid %.2fmm."
             % (model["version"], model["fine_pitch_component_count"], model["worst_case"],
                model["grid_pitch_mm"]), ""]
    for c in model["components"]:
        lines.append("## %s (%s, %s)" % (c["mpn"], c["package"], c["footprint"]))
        lines.append("- pin pitch: %s mm - pads: %d" % (c["pin_pitch_mm"], c["pad_count"]))
        lines.append("- escapes needed (%d): %s" % (c["escape_count"],
                     ", ".join("%s=%s" % (e["name"], e["net"]) for e in c["required_escape_pins"])))
        lines.append("- busiest side: %d escapes - fanout: %s" % (c["escapes_busy_side"], c["fanout_type"]))
        lines.append("- **difficulty: %s**" % c["expected_difficulty"])
        if c["blocker"]:
            lines.append("- blocker: %s" % c["blocker"])
        lines.append("")
    return "\n".join(lines)


if __name__ == "__main__":
    import sys
    design = json.load(open(sys.argv[1]))
    model = build_model(design)
    print(json.dumps(model, indent=1))
