"""Phase C — materials, vendors, part numbers (BOM enablement), 2026-06-11.

Retires the v4 review finding "no materials/tolerances/fasteners defined":
every part gets a Material (with density, so Mass computes), COTS parts get
Vendor + Part number from the locked BOM (flagship-cots-sourcing-bom.md +
hardware-expansion-spec.md), fabricated parts get the FAB designation, and
analysis bodies (corridors, swept volumes, DUT mock) are excluded from BOMs.

Rules are first-match: exact name, then contains-substring. Unmatched parts
are reported so coverage gaps are visible, then default to FAB aluminum.

Property IDs (probed): Description ...60e, Part number ...60f, Vendor ...612,
Material ...615 (OBJECT w/ DENS property), Exclude from all BOMs ...61e.
Bulk update: POST /metadata/d/{did}/w/{wid}/e/{eid} {"items": [...]} in
batches — keeps the whole pass at ~15 API calls instead of ~300.

LESSONS (first run, all corrected in follow-up passes):
- **Setting Material on a COMPOSITE part propagates to every member**,
  overwriting member materials set earlier in the same bulk call. The 4
  'ASM - *' composites matched the analysis rule and silently flattened
  52 member materials to 'Analysis body (no fab)'. Fix: skip composites
  entirely (bodyType == "composite"); their material stays unset, their
  Exclude-from-BOM stays True. Diff-verify via the bulk metadata GET
  (/metadata/d/../e/../p?depth=2 — one call for all 313 parts).
- Legacy envelope bodies (X Rail, Y Ballscrew, Z Stage, drag chains, ...)
  duplicate the vendor-true EVT parts: excluded from all BOMs with
  pn 'LEGACY ENVELOPE' (53 bodies) or they double-count procurement.
Final state: 309/309 real parts have material+density (Mass computes),
69 bodies excluded from BOMs, 38 distinct vendors.
"""
import time
import warnings

warnings.filterwarnings("ignore")

import sys

sys.path.insert(0, "/Users/jackal-kahwati/EE-lab/tools/onshape")

from urllib.parse import quote

from features import FeatureBuilder
from onshape_client import Client

DID = "02ed72e43f8d925e0c7aa678"
WID = "80299bfade6ea16b1cd86a0e"
EID = "8a871c2acd668dc865dda723"

P_DESC = "57f3fb8efa3416c06701d60e"
P_PARTNO = "57f3fb8efa3416c06701d60f"
P_VENDOR = "57f3fb8efa3416c06701d612"
P_MATERIAL = "57f3fb8efa3416c06701d615"
P_EXCLUDE = "57f3fb8efa3416c06701d61e"

def mat(display, dens):
    return {"id": display, "displayName": display, "libraryName": "EE-lab Materials",
            "properties": [{"name": "DENS", "value": float(dens), "type": "REAL",
                            "units": "kg/m^3", "category": "PHYSICAL",
                            "description": "density", "displayName": "Density"}]}

AL6061 = mat("Aluminum 6061-T6", 2700)
AL5052 = mat("Aluminum 5052 sheet", 2700)
AL6063 = mat("Aluminum 6063 extrusion", 2700)
STEEL = mat("Steel, alloy", 7850)
SS = mat("Stainless 303", 8000)
PMMA = mat("PMMA (smoked acrylic)", 1190)
ABS = mat("ABS / PC", 1060)
ELEC = mat("Electronics assembly (envelope)", 1500)
BRASS = mat("Brass 360", 8500)
RUBBER = mat("Rubber / TPU", 1100)
NONE_ = mat("Analysis body (no fab)", 1)

#: first-match rules: (match-kind, pattern, vendor, part number, material, excludeBOM)
RULES = [
    # --- analysis / mock bodies: exclude from BOM ---
    ("prefix", "Corridor - ", "", "ANALYSIS", NONE_, True),
    ("prefix", "Swept", "", "ANALYSIS", NONE_, True),
    ("prefix", "ASM - ", "", "ANALYSIS", NONE_, True),
    ("prefix", "Sample PCB", "", "DUT MOCK", ELEC, True),
    ("prefix", "PCB Component", "", "DUT MOCK", ELEC, True),
    ("prefix", "PCB Connector", "", "DUT MOCK", ELEC, True),
    # --- linear motion COTS (HIWIN-class) ---
    ("contains", "HGR20 Rail", "HIWIN", "HGR20R (600 mm)", STEEL, False),
    ("contains", "HGH20 Carriage Block", "HIWIN", "HGH20CA", STEEL, False),
    ("contains", "HGR15 Rail", "HIWIN", "HGR15R (480 mm)", STEEL, False),
    ("contains", "HGH15 Carriage Block", "HIWIN", "HGH15CA", STEEL, False),
    ("contains", "MGN12 Rail", "HIWIN", "MGN12R (180 mm)", STEEL, False),
    ("contains", "MGN12H Block", "HIWIN", "MGN12H", STEEL, False),
    ("contains", "SFU1605 Ballscrew", "Generic (THK-class)", "SFU1605-C7 (600 mm)", STEEL, False),
    ("contains", "SFU1605 Ballnut", "Generic (THK-class)", "SFU1605 ballnut", STEEL, False),
    ("contains", "SFU1204 Ballscrew", "Generic (THK-class)", "SFU1204-C7", STEEL, False),
    ("contains", "SFU1204 Ballnut", "Generic (THK-class)", "SFU1204 ballnut", STEEL, False),
    ("contains", "BK12", "Generic", "BK12 fixed support", STEEL, False),
    ("contains", "BF12", "Generic", "BF12 floating support", STEEL, False),
    ("contains", "BK10", "Generic", "BK10 fixed support", STEEL, False),
    ("contains", "BF10", "Generic", "BF10 floating support", STEEL, False),
    ("contains", "Jaw Coupling", "Ruland", "GS24 jaw coupling", AL6061, False),
    ("contains", "NEMA23 Motor", "Teknic", "CPM-SDSK-2321S-RLN ClearPath-SD", ELEC, False),
    ("contains", "Motor Shaft", "Teknic", "(ClearPath-SD shaft)", STEEL, False),
    ("contains", "Limit Switch", "Omron", "D2F-L", ELEC, False),
    ("contains", "Screw Journal", "FAB - machine", "EE-FAB-JNL", STEEL, False),
    # --- probe / pogo COTS ---
    ("contains", "Pogo Probe Bushing", "Mill-Max", "0906 receptacle", BRASS, False),
    ("contains", "Pogo Probe", "Mill-Max", "0906 spring probe", BRASS, False),
    # --- cameras / sensors ---
    ("exact", "Fixed Overhead Camera", "Basler", "a2A4504-18ucBAS", ELEC, False),
    ("prefix", "Overhead Camera Lens", "Edmund Optics", "16 mm C-mount", ELEC, False),
    ("exact", "Overhead Camera Barrel", "Edmund Optics", "16 mm C-mount", ELEC, False),
    ("exact", "IR Camera (FLIR Lepton 3.5)", "FLIR / GroupGets", "Lepton 3.5 + PureThermal 3", ELEC, False),
    ("exact", "IR Camera Lens", "FLIR", "(Lepton lens)", ELEC, False),
    # --- fans / thermal ---
    ("contains", "Exhaust Fan 120mm", "ebm-papst", "4414 FNH (120 mm, 24 V)", ELEC, False),
    ("contains", "Exhaust Fan Hub", "ebm-papst", "(fan hub)", ELEC, False),
    # --- instruments / electronics bay ---
    ("contains", "PicoScope", "Pico Technology", "PicoScope 5444D", ELEC, False),
    ("contains", "Saleae", "Saleae", "Logic Pro 16", ELEC, False),
    ("contains", "MCC USB-2416", "Measurement Computing", "USB-2416", ELEC, False),
    ("contains", "LabJack", "LabJack", "T7-OEM", ELEC, False),
    ("contains", "SPD1305X", "Siglent", "SPD1305X", ELEC, False),
    ("contains", "SDL1030X", "Siglent", "SDL1030X", ELEC, False),
    ("contains", "DP832", "Rigol", "DP832", ELEC, False),
    ("contains", "DMM6500", "Keithley", "DMM6500", ELEC, False),
    ("contains", "Joulescope", "Joulescope", "JS220", ELEC, False),
    ("contains", "Galil", "Galil", "DMC-4133", ELEC, False),
    ("contains", "Mean Well", "Mean Well", "NDR-240-24", ELEC, False),
    ("contains", "Omron G9SE", "Omron", "G9SE-201", ELEC, False),
    ("contains", "DIN Ethernet Switch", "Phoenix Contact", "FL SWITCH 1008N", ELEC, False),
    ("contains", "Industrial Control PC", "OnLogic", "MK100 (i7/32GB/1TB)", ELEC, False),
    ("contains", "Powered USB Hub", "StarTech", "ST7300USBME", ELEC, False),
    ("contains", "DIN Rail Strip", "Phoenix Contact", "NS 35/7.5 DIN rail", STEEL, False),
    ("contains", "Probe Protection", "EE-lab", "PCBA Rev A (protection)", ELEC, False),
    ("contains", "Vacuum Cable Gland", "Generic", "M20 cable gland", ABS, False),
    ("contains", "IEC C14", "Schurter", "6100.3300 IEC C14", ELEC, False),
    ("contains", "RJ45 Connector", "Amphenol", "bulkhead RJ45", ELEC, False),
    ("contains", "USB-C Connector", "Amphenol", "bulkhead USB-C", ELEC, False),
    ("contains", "DUT IF - ", "Various", "(DUT interface connector)", ELEC, False),
    ("exact", "DUT Interface Bulkhead", "FAB - machine", "EE-FAB-DUTIF", AL6061, False),
    # --- fasteners / hardware ---
    ("contains", "Rear Panel Screw", "McMaster-Carr", "M4x10 SHCS 91292A", SS, False),
    ("contains", "Leveling Foot", "McMaster-Carr", "23015T74 leveling mount", RUBBER, False),
    ("contains", "Fixture Locating Pin", "McMaster-Carr", "98381A dowel O8", SS, False),
    ("contains", "Cartridge Dowel Pin", "McMaster-Carr", "91585A O3 dowel", SS, False),
    ("contains", "Probe Guide Pin", "McMaster-Carr", "98381A dowel O5", SS, False),
    ("contains", "Hard Stop Collar", "McMaster-Carr", "6435K shaft collar", STEEL, False),
    ("contains", "Preload Spring", "Lee Spring", "LC-026 compression", STEEL, False),
    ("contains", "Fastener", "McMaster-Carr", "SHCS assorted", SS, False),
    # --- glass / cosmetics ---
    ("contains", "Glass", "FAB - cut", "EE-FAB-GLZ smoked PMMA", PMMA, False),
    ("contains", "Side Shell", "FAB - molded (DVT: sheet)", "EE-FAB-SHL", AL5052, False),
    ("exact", "Top Slab", "FAB - machined", "EE-FAB-TOP", AL6061, False),
    ("contains", "Plinth Fascia", "FAB - sheet", "EE-FAB-FSC", AL5052, False),
    ("contains", "Rear Matte Black Panel", "FAB - sheet", "EE-FAB-RPNL", AL5052, False),
    ("contains", "Enclosure Base Pan", "FAB - sheet", "EE-FAB-BPAN", AL5052, False),
    ("prefix", "Trim - ", "FAB - sheet", "EE-FAB-TRIM", AL5052, False),
    ("contains", "Accent Light Strip", "Generic", "LED strip 24V", ELEC, False),
    ("contains", "Chamber Light Bar", "Generic", "LED bar 24V", ELEC, False),
    ("prefix", "Power ", "EE-lab", "(power cluster cosmetic)", ABS, False),
    ("contains", "Logo Emblem", "FAB - print", "EE-FAB-EMB", ABS, False),
    ("contains", "Rear Vent Baffle", "FAB - sheet", "EE-FAB-BAF", AL5052, False),
    ("prefix", "Enclosure Post", "FAB - extrusion", "EE-FAB-POST", AL6063, False),
    ("prefix", "Label", "", "label", ABS, False),
    ("contains", "Label Plate", "", "label", ABS, False),
    # --- fabricated structure (catch the rest of the load path) ---
    ("exact", "Base Frame", "FAB - extrusion", "EE-FAB-FRM 4040", AL6063, False),
    ("exact", "Instrument Deck", "FAB - sheet", "EE-FAB-DECK", AL5052, False),
    ("exact", "Equipment Tray", "FAB - sheet", "EE-FAB-TRAY", AL5052, False),
    ("exact", "PCB Fixture Plate", "FAB - machined", "EE-FAB-FIXP", AL6061, False),
    ("contains", "Fixture Standoff", "FAB - machined", "EE-FAB-STDF", AL6061, False),
    ("contains", "Vacuum Port Boss", "FAB - machined", "EE-FAB-VAC", AL6061, False),
    ("contains", "Adjustable Clamp", "FAB - machined", "EE-FAB-CLMP", AL6061, False),
    ("contains", "Clamp Knob", "McMaster-Carr", "6121K knob M6", ABS, False),
    ("contains", "Cartridge Park Rack", "FAB - machined", "EE-FAB-RACK", AL6061, False),
    ("contains", "Cartridge Cradle", "FAB - machined", "EE-FAB-CRDL", AL6061, False),
    ("exact", "Probe Mount Arm", "FAB - machined", "EE-FAB-ARM", AL6061, False),
    ("contains", "Probe Cartridge", "EE-lab", "PCBA Rev A (cartridge)", ELEC, False),
    ("exact", "Probe Head", "FAB - machined", "EE-FAB-PHD", AL6061, False),
    ("contains", "Camera Bracket", "FAB - machined", "EE-FAB-CAMBKT", AL6061, False),
    ("contains", "Camera", "FAB - machined", "EE-FAB-CAM", AL6061, False),
]

DEFAULT = ("FAB - machined", "EE-FAB-MISC", AL6061, False)

def classify(name):
    for kind, pat, vendor, pn, m, excl in RULES:
        if (kind == "exact" and name == pat) or \
           (kind == "prefix" and name.startswith(pat)) or \
           (kind == "contains" and pat in name):
            return vendor, pn, m, excl
    return None

if __name__ != "__main__":
    raise SystemExit  # guard: importable for RULES/classify without re-running

c = Client()
fb = FeatureBuilder(c, DID, WID, EID)
parts = fb.parts()  # pid -> name

items, unmatched = [], []
for pid, name in parts.items():
    hit = classify(name)
    if hit is None:
        unmatched.append(name)
        hit = DEFAULT
    vendor, pn, m, excl = hit
    props = [
        {"propertyId": P_MATERIAL, "value": m},
        {"propertyId": P_PARTNO, "value": pn},
        {"propertyId": P_EXCLUDE, "value": excl},
    ]
    if vendor:
        props.append({"propertyId": P_VENDOR, "value": vendor})
    items.append({"partId": pid, "properties": props})

print("parts: {}, unmatched -> FAB default: {}".format(len(items), len(unmatched)))
for n in sorted(unmatched):
    print("   default:", n)

BATCH = 40
for i in range(0, len(items), BATCH):
    batch = items[i:i + BATCH]
    c._request("POST", "/api/v6/metadata/d/{}/w/{}/e/{}".format(DID, WID, EID),
               json={"items": [
                   {"href": "https://cad.onshape.com/api/v6/metadata/d/{}/w/{}/e/{}/p/{}".format(
                       DID, WID, EID, quote(it["partId"], safe="")),
                    "properties": it["properties"]} for it in batch]})
    print("batch {}-{} applied".format(i, i + len(batch) - 1), flush=True)
    time.sleep(1.5)

# spot verification
import random
sample = random.Random(7).sample(list(parts), 4)
for pid in sample:
    r = c._request("GET", "/api/v6/metadata/d/{}/w/{}/e/{}/p/{}".format(
        DID, WID, EID, quote(pid, safe="")))
    got = {p["name"]: p.get("value") for p in r["properties"]
           if p.get("name") in ("Name", "Part number", "Vendor", "Material")}
    matname = (got.get("Material") or {}).get("displayName") if got.get("Material") else None
    print("VERIFY {}: pn={!r} vendor={!r} material={!r}".format(
        got.get("Name"), got.get("Part number"), got.get("Vendor"), matname))

print("PHASE C COMPLETE", flush=True)
