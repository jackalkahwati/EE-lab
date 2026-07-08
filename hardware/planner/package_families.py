"""Phase 23.7 — Package Family Capability System v1.

Package-family intelligence: classify, verify geometry, verify pin mapping,
pick escape/placement/manufacturing strategies, and gate claims — with state
scoped per family/variant/part/footprint/fab-class. Presence is never
verification; one validated part never validates a family; BGA stays
architecture_only until a sandbox proves it.
"""
import os
import re

FP_SHARE = "/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints"

STATES = ("unknown", "footprint_present", "symbol_present",
          "symbol_and_footprint_present", "footprint_verified",
          "pinout_verified", "package_classified", "placement_supported",
          "escape_strategy_defined", "routed_in_sandbox",
          "manufacturing_package_supported_with_review", "physically_validated",
          "repeatedly_validated", "deprecated", "blocked")

# (family, tier, pitch_class, escape, assembly, inspection, evidence-from-runs)
TAXONOMY = [
    ("passive_1206", 1, "coarse", "direct", "easy/hand", "visual", []),
    ("passive_0805", 1, "coarse", "direct", "easy/hand", "visual", []),
    ("passive_0603", 1, "coarse", "direct", "hand-ok", "visual",
     ["power-entry-header-2l (LED 0603)"]),
    ("passive_0402", 1, "fine-ish", "direct", "hand-hard, tombstoning notes",
     "visual/magnified", ["every board (0402 R/C)"]),
    ("passive_0201", 1, "very fine", "direct", "REVIEW-REQUIRED (machine)",
     "AOI", []),
    ("test_pad", 1, "n/a", "direct", "n/a", "visual", ["all boards"]),
    ("header_tht", 1, "2.54", "direct", "hand", "visual", ["all boards"]),
    ("SOT-23", 1, "coarse", "direct", "hand-ok", "visual",
     ["adc-logger-v1 (REF3025)"]),
    ("SOT-223", 1, "coarse", "direct+tab", "hand-ok", "visual",
     ["bare-mcu-qfn56-core-sandbox-v1 (AMS1117)"]),
    ("SOT-89", 1, "coarse", "direct+tab", "hand-ok", "visual", []),
    ("SOIC", 1, "1.27", "gullwing", "hand-ok", "visual",
     ["boards with 24LC02/W25Q16"]),
    ("TSSOP", 1, "0.5-0.65", "gullwing + lane fanout", "hand-hard",
     "magnified", ["ADS1115 boards (0.5mm lane escape proven)"]),
    ("MSOP", 1, "0.5-0.65", "gullwing + lane fanout", "hand-hard",
     "magnified", []),
    ("connector_USB_C_power", 1, "mixed", "connector", "hand-plausible",
     "visual", ["usbc-power-entry-v1/-2l (USB4125 power-only)"]),
    ("connector_JST", 1, "2.0", "connector", "hand", "visual", []),
    ("screw_terminal", 1, "coarse", "connector", "hand", "visual", []),
    ("DFN", 2, "0.4-0.65", "nolead perimeter", "reflow", "magnified/AOI", []),
    ("QFN-16/24/32/48", 2, "0.4-0.65", "nolead perimeter (scoped strategy "
     "exists, UNPROVEN per variant)", "reflow+EP", "AOI", []),
    ("QFN-56", 2, "0.4", "quadrant escape (PROVEN in sandbox)", "reflow+EP "
     "review", "AOI/X-ray review",
     ["bare-mcu-qfn56-core-sandbox-v1 (18/18, 0 DRC)"]),
    ("QFN-64", 2, "0.4-0.5", "quadrant escape candidate (UNPROVEN)",
     "reflow+EP", "AOI/X-ray review", []),
    ("small_LGA_sensor", 2, "0.5-0.8", "lane fanout (0.65 proven)",
     "reflow", "magnified", ["bme280-sandbox-v1 (LGA-8 0.65)"]),
    ("exposed_pad_regulator", 2, "coarse+EP", "direct + thermal pour "
     "(THERMAL CLAIMS BLOCKED)", "reflow", "visual+AOI", []),
    ("power_QFN", 2, "0.5-0.65+EP", "nolead + thermal (BLOCKED: current/"
     "thermal rules missing)", "reflow", "X-ray review", []),
    ("BGA_coarse", 3, ">=0.8", "ball-map escape (MODELED ONLY)", "reflow, "
     "no hand", "X-RAY REQUIRED", []),
    ("BGA_fine", 3, "<0.8", "HDI/microvia likely (BLOCKED)", "advanced",
     "X-ray", []),
    ("WLCSP", 3, "<=0.5", "HDI likely (architecture_only/BLOCKED)",
     "advanced, yield risk", "X-ray", []),
    ("high_density_b2b_connector", 3, "<=0.5", "fine connector (UNPROVEN)",
     "reflow", "magnified/X-ray", []),
    ("RF_package", 3, "varies", "architecture_only (RF unproven)", "varies",
     "varies", []),
]

CLASS_PATTERNS = [
    (r"R_1206|C_1206", "passive_1206"), (r"R_0805|C_0805", "passive_0805"),
    (r"R_0603|C_0603|LED_0603", "passive_0603"),
    (r"R_0402|C_0402", "passive_0402"), (r"R_0201|C_0201", "passive_0201"),
    (r"TestPoint", "test_pad"), (r"PinHeader", "header_tht"),
    (r"SOT-23", "SOT-23"), (r"SOT-223", "SOT-223"), (r"SOT-89", "SOT-89"),
    (r"SOIC-", "SOIC"), (r"TSSOP-", "TSSOP"), (r"MSOP-", "MSOP"),
    (r"USB_C_Receptacle", "connector_USB_C_power"), (r"JST_", "connector_JST"),
    (r"TerminalBlock|ScrewTerminal", "screw_terminal"),
    (r"QFN-56", "QFN-56"), (r"QFN-64", "QFN-64"),
    (r"QFN-(16|24|32|48)", "QFN-16/24/32/48"), (r"DFN|WSON|SON", "DFN"),
    (r"LGA-\d", "small_LGA_sensor"), (r"WLCSP|CSP", "WLCSP"),
    (r"BGA", "BGA_by_pitch"), (r"Crystal", "passive_1206"),
    (r"MountingHole", "test_pad"), (r"Fiducial", "test_pad"),
    (r"SolderJumper", "test_pad"), (r"Jumper", "test_pad"),
    (r"RaspberryPi_Pico", "module"),
]


def classify(footprint_name, geometry=None):
    """geometry (optional): {pad_count, pitch_mm} from real parsing — geometry
    beats name when they conflict."""
    fam = "unknown"
    for pat, f in CLASS_PATTERNS:
        if re.search(pat, footprint_name):
            fam = f
            break
    conf = "name-match"
    if fam == "BGA_by_pitch":
        if geometry and geometry.get("pitch_mm"):
            fam = "BGA_coarse" if geometry["pitch_mm"] >= 0.8 else "BGA_fine"
            conf = "geometry"
        else:
            fam = "BGA_coarse"
            conf = "candidate_only (pitch unparsed)"
    if geometry and geometry.get("pitch_mm") and fam in ("TSSOP", "MSOP",
                                                         "QFN-56", "DFN"):
        conf = "name+geometry"
    tier = next((t for f, t, *_ in TAXONOMY if f == fam), None)
    if fam == "module":
        tier = 1
    return {"family": fam, "tier": tier, "confidence": conf,
            "advanced_gate": tier == 3,
            "blocked_claims": (["all advanced claims until sandbox evidence"]
                               if tier == 3 else [])}


def parse_footprint(path):
    """REAL geometry from a .kicad_mod: pads, pitch, layers, EP."""
    t = open(path).read()
    smd = re.findall(r'\(pad "([^"]+)" smd \S+\s*\(at ([-0-9.]+) ([-0-9.]+)', t)
    tht = re.findall(r'\(pad "([^"]+)" thru_hole', t)
    # pitch = the MODAL neighbor spacing across both axes (min-diff breaks on
    # 4-sided packages where row/column/EP coordinates interleave, and float
    # dust below 0.01 must not flip a coarse BGA into "fine")
    from collections import Counter
    diffs = Counter()
    for axis in (0, 1):
        vals = sorted(set(round(float(t[1 + axis]), 3) for t in smd))
        for a, b in zip(vals, vals[1:]):
            d = round(b - a, 2)
            if d >= 0.1:
                diffs[d] += 1
    pitch = diffs.most_common(1)[0][0] if diffs else None
    names = [n for n, *_ in smd] + list(tht)
    return {"pad_count": len(set(names)), "smd": len(smd), "tht": len(tht),
            "pitch_mm": pitch, "has_courtyard": "F.CrtYd" in t,
            "has_silk": "F.SilkS" in t, "has_paste": "F.Paste" in t,
            "has_fab": "F.Fab" in t,
            "exposed_pad": any(n.isdigit() and int(n) > 48 for n in names)
                           or "EP" in names or "PAD" in names}


def verify_footprint_v2(path, expected_pads=None, family=None):
    g = parse_footprint(path)
    problems = []
    if expected_pads is not None and g["pad_count"] != expected_pads:
        problems.append("pad count %d != expected %d — BLOCKS"
                        % (g["pad_count"], expected_pads))
    if not g["has_courtyard"]:
        problems.append("missing courtyard — review-required")
    if not g["has_silk"] and family not in ("test_pad",):
        problems.append("no silk (pin-1 marker unverifiable) — review-required")
    blocked = any("BLOCKS" in p for p in problems)
    return {"state": "blocked" if blocked else "footprint_verified",
            "geometry": g, "problems": problems}


def verify_mapping(symbol_pins, footprint_pad_names):
    """symbol_pins: [{number, name, etype}]. Active-IC safety rules."""
    nums = {p["number"] for p in symbol_pins}
    pads = set(footprint_pad_names)
    problems, high_risk = [], []
    missing = nums - pads
    extra = pads - nums
    if missing:
        problems.append("symbol pins with no pad: %s — BLOCKS" % sorted(missing))
    if extra:
        problems.append("pads with no symbol pin: %s (review: NC or EP?)"
                        % sorted(extra)[:5])
    pwr = [p for p in symbol_pins if p.get("etype") == "power_in"]
    if not pwr:
        high_risk.append("no power_in pins identified — POWER AMBIGUITY "
                         "BLOCKS active-IC layout")
    state = ("mapping_blocked" if missing or high_risk else
             "mapping_quarantined" if problems else "mapping_verified")
    return {"state": state, "problems": problems, "high_risk": high_risk}


STRATEGIES = {
    "simple_passive_strategy": ["passive_1206", "passive_0805", "passive_0603",
                                "passive_0402", "passive_0201", "test_pad"],
    "simple_sot_strategy": ["SOT-23", "SOT-223", "SOT-89"],
    "gullwing_ic_strategy": ["SOIC", "TSSOP", "MSOP"],
    "nolead_perimeter_strategy": ["DFN", "QFN-16/24/32/48", "QFN-56", "QFN-64"],
    "small_lga_sensor_strategy": ["small_LGA_sensor"],
    "connector_strategy": ["header_tht", "connector_USB_C_power",
                           "connector_JST", "screw_terminal",
                           "high_density_b2b_connector"],
    "exposed_pad_power_strategy": ["exposed_pad_regulator", "power_QFN"],
    "bga_strategy_candidate": ["BGA_coarse", "BGA_fine"],
    "wlcsp_strategy_candidate": ["WLCSP"],
}


def bga_model(footprint_path):
    """Parse a REAL BGA ball map; the model is honest: MODELED, not supported."""
    t = open(footprint_path).read()
    balls = re.findall(r'\(pad "([A-Z]+\d+)" smd circle\s*\(at ([-0-9.]+) ([-0-9.]+)', t)
    xs = sorted(set(round(float(x), 2) for _n, x, _y in balls))
    rows = sorted(set(re.match(r"[A-Z]+", n).group() for n, *_ in balls))
    # modal spacing (an off-grid corner ball must not shrink the pitch)
    from collections import Counter
    dc = Counter(round(b - a, 2) for a, b in zip(xs, xs[1:]) if b - a > 0.05)
    pitch = dc.most_common(1)[0][0]
    perimeter = len(balls) < len(rows) ** 2  # gaps => perimeter/partial array
    return {"footprint": os.path.basename(footprint_path),
            "ball_count": len(balls), "pitch_mm": pitch,
            "rows": rows, "grid_cols": len(xs),
            "array_style": "perimeter/partial" if perimeter else "full",
            "escape_feasibility": "coarse 0.8mm 2-ring perimeter: dogbone "
                                  "escape plausibly fits 4-6 layers; interior "
                                  "balls (if full array) need via channels",
            "via_in_pad_required": pitch < 0.8,
            "hdi_required": pitch < 0.65,
            "state": "bga_modeled + ball_map_parsed + "
                     "escape_feasibility_estimated",
            "verdict": "architecture_only",
            "exact_gap": "no VERIFIED BGA component primitive exists (no "
                         "symbol+pinout evidence for any BGA part in the "
                         "library stack) — footprint geometry parses fine; a "
                         "sandbox needs a real part first",
            "blocked_claims": ["BGA routing support", "DDR", "PCIe",
                               "high-speed", "X-ray/assembly/yield",
                               "HDI/microvia"]}
