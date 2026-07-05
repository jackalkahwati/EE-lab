"""Manufacturability layer — turn a routed board into an ORDER-READY PCBA package.

Reads the real KiCad board + sidecars (devices.json = ref→MPN, bom.json = the
LCSC-matched BOM, recovery.json = substitutions) and emits, all from REAL data:

  pick_and_place.csv   ref, value, footprint, MPN, X, Y, rotation, side,
                       package, placement (SMT / DNP) — real KiCad coordinates.
  bom.csv              assembly BOM: ref, qty, value, manufacturer, MPN,
                       distributor PN (LCSC), footprint, package, sourcing
                       status, confidence, substitution status.
  sourcing-report.json per-line exact / equivalent / fallback / missing +
                       whether LIVE sourcing was available (honest).
  substitutions.json   the recovery-loop substitutions (if any).
  assembly-readiness.json / .md   ready? + missing / DNP / fine-pitch /
                       hand-solder-risk / substituted parts + house notes.

HONESTY: this never invents a placement (coordinates come from the board) and
never fakes supplier data. Live DigiKey/Mouser sourcing is attempted only if
credentials work; otherwise every line is labelled "fallback" and the report
says live sourcing was unavailable.

  <kicad-python3> gen_assembly.py <board.kicad_pcb> <out_dir> [devices.json bom.json recovery.json]
"""
import csv
import json
import os
import re
import sys

import pcbnew

board_path, out_dir = sys.argv[1], sys.argv[2]
dev_path = sys.argv[3] if len(sys.argv) > 3 else os.path.join(out_dir, "devices.json")
bom_path = sys.argv[4] if len(sys.argv) > 4 else os.path.join(out_dir, "bom.json")
rec_path = sys.argv[5] if len(sys.argv) > 5 else os.path.join(out_dir, "recovery.json")


def _load(p, default):
    try:
        return json.load(open(p))
    except Exception:
        return default


devices = _load(dev_path, [])
bom = _load(bom_path, [])
recovery = _load(rec_path, [])
if not isinstance(recovery, list):
    recovery = [recovery] if recovery else []

# ref -> MPN (last write wins; devices.json can have a bare + a named entry)
ref_mpn = {}
for d in devices:
    if d.get("ref") and (d.get("name") or d.get("mpn")):
        ref_mpn[d["ref"]] = d.get("name") or d.get("mpn")

# small MPN -> manufacturer map for the seed parts (honest "unknown" otherwise)
MANUF = {
    "RP2040": "Raspberry Pi", "BME280": "Bosch", "INA219": "Texas Instruments",
    "W25Q128JVSIQ": "Winbond", "MAX3485": "Analog Devices", "74HC595": "Texas Instruments",
    "MCP2515": "Microchip", "MCP23017": "Microchip", "DS3231": "Analog Devices",
    "LIS3DH": "STMicroelectronics", "DRV8833": "Texas Instruments", "WS2812B": "Worldsemi",
    "MCP73831": "Microchip", "TPS62162": "Texas Instruments", "AP2112K-3.3": "Diodes Inc",
    "MX126-5.0-02P": "MaiXu", "SN65HVD230": "Texas Instruments",
}

FINE_PITCH = re.compile(r"P0\.[1-6]\d*mm|QFN|DFN|WSON|USON|VSSOP|VQFN|UQFN|LGA|SON_|BGA|"
                        r"USB_C_Receptacle", re.I)
NO_PLACE = re.compile(r"Fiducial|MountingHole|TestPoint", re.I)


def _pkg(fp_name):
    # human package from the footprint library item name
    m = re.match(r"([A-Za-z]+-?\d+\w*|SOIC-\d+|TSSOP-\d+|QFN-\d+|SOT-\d+|LGA-\d+|"
                 r"WSON-\d+|C_\d+|R_\d+|PinHeader\w*)", fp_name)
    return m.group(1) if m else fp_name.split("_")[0]


# ---- Phase 1: pick-and-place from REAL board coordinates --------------------
b = pcbnew.LoadBoard(board_path)
edges = b.GetBoardEdgesBoundingBox()
x0, y0 = pcbnew.ToMM(edges.GetLeft()), pcbnew.ToMM(edges.GetTop())

pnp_rows = []
for fp in b.GetFootprints():
    ref = fp.GetReference()
    fpname = str(fp.GetFPID().GetLibItemName())
    pos = fp.GetPosition()
    val = fp.GetValue()
    dnp = bool(NO_PLACE.search(fpname) or NO_PLACE.search(ref)
               or (hasattr(fp, "IsDNP") and fp.IsDNP()))
    pnp_rows.append({
        "Ref": ref, "Val": val, "Footprint": fpname,
        "MPN": ref_mpn.get(ref, ""),
        "PosX_mm": round(pcbnew.ToMM(pos.x) - x0, 3),
        "PosY_mm": round(pcbnew.ToMM(pos.y) - y0, 3),
        "Rotation": fp.GetOrientationDegrees(),
        "Side": "bottom" if fp.IsFlipped() else "top",
        "Package": _pkg(fpname),
        "Placement": "DNP" if dnp else "SMT",
    })

with open(os.path.join(out_dir, "pick_and_place.csv"), "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(pnp_rows[0].keys()) if pnp_rows else
                       ["Ref", "Val", "Footprint", "MPN", "PosX_mm", "PosY_mm",
                        "Rotation", "Side", "Package", "Placement"])
    w.writeheader()
    w.writerows(pnp_rows)

placed = sum(1 for r in pnp_rows if r["Placement"] == "SMT")
dnp = len(pnp_rows) - placed

# ---- Phase 2 + 3: assembly BOM + sourcing status (honest fallback) ----------
# We do NOT have working live sourcing (DigiKey returned no data), so every line
# is a fallback: the part identity (MPN) is real where known, but price/stock are
# estimates. This is stated plainly in the sourcing report.
LIVE = False  # flip to True only when a live supplier call actually returns data

def _fp_for_bom_ref(refs):
    for fp in b.GetFootprints():
        if fp.GetReference() in refs:
            return str(fp.GetFPID().GetLibItemName())
    return ""

bom_rows = []
sourcing_lines = []
for line in bom:
    refstr = line.get("ref", "")
    refs = [r.strip() for r in re.split(r"[,…]", refstr) if r.strip() and not r.strip().isdigit()]
    mpn = next((ref_mpn[r] for r in refs if r in ref_mpn), "")
    fpname = _fp_for_bom_ref(refs)
    fine = bool(FINE_PITCH.search(fpname))
    lcsc = line.get("lcsc", "") if line.get("lcsc") not in ("—", None) else ""
    part = line.get("part", "")
    # sourcing status, honest:
    if NO_PLACE.search(part) or NO_PLACE.search(fpname):
        status, conf = "not_placed", 1.0
    elif mpn:
        status, conf = ("library_match" if lcsc else "known_mpn"), 0.7
    elif lcsc:
        status, conf = "library_match", 0.6
    else:
        status, conf = "fallback_estimate", 0.4
    manuf = MANUF.get(mpn, "" if not mpn else "unknown")
    bom_rows.append({
        "Refs": refstr, "Qty": line.get("qty", len(refs) or 1),
        "Value": part, "Manufacturer": manuf, "MPN": mpn,
        "DistributorPN_LCSC": lcsc, "Footprint": fpname, "Package": _pkg(fpname),
        "SourcingStatus": status, "Confidence": conf,
        "Substituted": "yes" if mpn in {r.get("proposed") for r in recovery} else "no",
    })
    sourcing_lines.append({
        "refs": refstr, "part": part, "mpn": mpn, "lcsc": lcsc,
        # exact = live-verified (never true here); equivalent = library part;
        # fallback = estimate; missing = nothing found.
        "match": ("not_placed" if status == "not_placed"
                  else "equivalent" if lcsc
                  else "fallback" if (mpn or part) else "missing"),
        "confidence": conf, "live": False,
    })

# The LCSC keyword index is best-effort and sometimes maps SEVERAL distinct
# parts to the same LCSC number — that is NOT a real match, so never let it read
# as an "equivalent" source. Detect shared LCSC numbers and downgrade those lines
# to fallback with a data-quality note (honest > impressive).
lcsc_parts = {}
for l in sourcing_lines:
    if l["lcsc"]:
        lcsc_parts.setdefault(l["lcsc"], set()).add(l["mpn"] or l["part"])
unreliable = {k for k, v in lcsc_parts.items() if len(v) > 1}
for l in sourcing_lines:
    if l["lcsc"] in unreliable:
        l["match"] = "fallback"
        l["lcsc_reliable"] = False
        l["note"] = "LCSC keyword match shared across parts — unreliable, verify before order"
for r in bom_rows:
    if r["DistributorPN_LCSC"] in unreliable:
        r["SourcingStatus"] = "fallback_estimate"
        r["Confidence"] = min(r["Confidence"], 0.4)

with open(os.path.join(out_dir, "bom.csv"), "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(bom_rows[0].keys()) if bom_rows else ["Refs"])
    w.writeheader()
    w.writerows(bom_rows)

sourcing_report = {
    "version": 1, "generator": "firstlight-compose",
    "live_sourcing": {
        "available": LIVE,
        "note": ("live supplier data" if LIVE else
                 "live DigiKey/Mouser/LCSC sourcing unavailable in this run "
                 "(no working supplier API); part identities are real where "
                 "known, prices/stock are fallback estimates"),
        "suppliers_configured": ["DigiKey" if os.environ.get("DIGIKEY_CLIENT_ID") else None,
                                 "LCSC-index"],
    },
    "lines": sourcing_lines,
    "data_quality": {
        "unreliable_lcsc": sorted(unreliable),
        "note": ("%d LCSC number(s) matched more than one distinct part and were "
                 "downgraded to fallback — the LCSC keyword index is best-effort, "
                 "not a verified distributor match." % len(unreliable))
        if unreliable else "no shared/unreliable LCSC matches detected",
    },
    "summary": {
        "total_lines": len(sourcing_lines),
        "equivalent": sum(1 for l in sourcing_lines if l["match"] == "equivalent"),
        "fallback": sum(1 for l in sourcing_lines if l["match"] == "fallback"),
        "missing": sum(1 for l in sourcing_lines if l["match"] == "missing"),
    },
}
json.dump(sourcing_report, open(os.path.join(out_dir, "sourcing-report.json"), "w"), indent=1)

# ---- Phase 4: substitutions (from the recovery loop) ------------------------
subs = [{
    "original": r.get("original_request") or r.get("replaces"),
    "substitute": r.get("proposed"),
    "preserved": r.get("capabilities_preserved", []),
    "lost": r.get("capabilities_lost", []),
    "requires_approval": r.get("requires_approval", False),
    "footprint_compatible": False,  # recovery subs change the part; NOT drop-in
} for r in recovery if r.get("proposed")]
json.dump(subs, open(os.path.join(out_dir, "substitutions.json"), "w"), indent=1)

# ---- Phase 5: assembly readiness -------------------------------------------
fine_refs = [r["Ref"] for r in pnp_rows if FINE_PITCH.search(r["Footprint"])]
missing = [l["refs"] for l in sourcing_lines if l["match"] == "missing"]
fallback_parts = [l["refs"] for l in sourcing_lines if l["match"] == "fallback"]
hand_solder_ok = len(fine_refs) == 0
ready = len(missing) == 0  # buildable if nothing is truly unsourced

readiness = {
    "version": 1, "generator": "firstlight-compose",
    "ready_for_assembly": ready,
    "board": {"components_placed": placed, "dnp": dnp,
              "size_mm": [round(pcbnew.ToMM(edges.GetWidth()), 1),
                          round(pcbnew.ToMM(edges.GetHeight()), 1)]},
    "missing_parts": missing,
    "unavailable_parts": [],   # requires live sourcing to determine
    "low_stock_parts": [],     # requires live sourcing to determine
    "dnp_parts": [r["Ref"] for r in pnp_rows if r["Placement"] == "DNP"],
    "fine_pitch_parts": fine_refs,
    "hand_solder_compatible": hand_solder_ok,
    "hand_solder_risk": "low" if hand_solder_ok else "high (fine-pitch parts need SMT reflow)",
    "special_handling": fine_refs,
    "substituted_parts": [s["substitute"] for s in subs],
    "sourcing_confidence": round(sum(l["confidence"] for l in sourcing_lines)
                                 / max(1, len(sourcing_lines)), 2),
    "notes": [
        "Live supplier stock/price is NOT available in this run — verify sourcing "
        "with DigiKey/LCSC before ordering." if not LIVE else "live sourcing used.",
        "%d fine-pitch part(s) require SMT reflow assembly." % len(fine_refs)
        if fine_refs else "All parts are hand-solder / SMT compatible.",
        "%d substitution(s) from the recovery loop — review before production."
        % len(subs) if subs else "No substitutions.",
    ],
    "recommended_assembly": ("SMT assembly house (fine-pitch reflow)" if fine_refs
                             else "hand-solder or SMT — either works"),
}
json.dump(readiness, open(os.path.join(out_dir, "assembly-readiness.json"), "w"), indent=1)

# markdown version
md = ["# Assembly Readiness\n",
      "**Ready for assembly:** %s\n" % ("YES" if ready else "NO — missing parts"),
      "- Components placed: %d  ·  DNP: %d  ·  Board: %s x %s mm"
      % (placed, dnp, *readiness["board"]["size_mm"]),
      "- Sourcing confidence: %.2f" % readiness["sourcing_confidence"],
      "- Hand-solder: %s (%s)" % (hand_solder_ok, readiness["hand_solder_risk"]),
      "- Recommended: %s\n" % readiness["recommended_assembly"]]
if fine_refs:
    md.append("### Fine-pitch parts (SMT reflow)\n" + ", ".join(fine_refs) + "\n")
if subs:
    md.append("### Substitutions (review before production)")
    for s in subs:
        md.append("- **%s → %s** (lost: %s)" % (s["original"], s["substitute"],
                  ", ".join(s["lost"]) or "none"))
    md.append("")
md.append("### Sourcing\n" + readiness["notes"][0] + "\n")
md.append("| Refs | Part | MPN | LCSC | Match | Conf |")
md.append("|---|---|---|---|---|---|")
for l in sourcing_lines:
    md.append("| %s | %s | %s | %s | %s | %.1f |" % (
        l["refs"], l["part"], l["mpn"] or "—", l["lcsc"] or "—", l["match"], l["confidence"]))
open(os.path.join(out_dir, "assembly-readiness.md"), "w").write("\n".join(md) + "\n")

print("ASSEMBLY placed=%d dnp=%d fine_pitch=%d ready=%s subs=%d"
      % (placed, dnp, len(fine_refs), ready, len(subs)))
sys.stdout.flush()
