"""Restricted exact-native BME280 adapter. The parent MUST contain this process.

prepare --input JOB/native-input.json --output-dir JOB
import  --input JOB/native-input.json --output-dir JOB --ses JOB/board.ses
finish  --input JOB/native-input.json --output-dir JOB --ses JOB/board.ses
inspect --input JOB/native-input.json --output-dir JOB --ses JOB/board.ses
drc-api --input JOB/native-input.json --output-dir JOB  (diagnostic only)

Import, finish, and inspect MUST run in separate processes. KiCad 10 segfaults
when LoadBoard follows SES import or zone fill/save in the same interpreter.

Input version 1 is trusted, validated parent data, never raw model output:
parts [{ref,catalogId,value?}], catalog {catalogId: {footprint:
{libraryPath,name,sha256}, models:[{path,sha256,sourceReference,offsetMm,
scale,rotationDeg}], padNumbers:[str]}}, nets [{name,pins:[{ref,pad}]}],
board {widthMm:24,heightMm:18,layers:2}, optional placement (fixed below).
assetRoots lists the reviewed absolute footprint/model roots allowed by parent.

No subprocesses, discovery, implicit nets, rerouting, DRC, or fallback.
Only bounded, native-geometry-checked GND fanout and one reviewed escape each
for SDA and SCL are added. Reserved copper must survive routing without restoration.
A normal zero process exit AND validated output files are required. DRC stays
unknown here; only the parent's final saved-board CLI DRC can establish a pass.
Importing this module does not import pcbnew (pure/mocked tests stay non-native).
"""
import argparse
from fractions import Fraction
import hashlib
import json
import math
from pathlib import Path
import re
import stat
import sys


VERSION = 1
BOARD = {"widthMm": 24, "heightMm": 18, "layers": 2}
PARTS = {"U1": "bme280", "J1": "header-1x04", "C1": "cap-100nf-0402",
         "C2": "cap-100nf-0402", "R1": "res-4k7-0402", "R2": "res-4k7-0402"}
FOOTPRINTS = {
    "bme280": ("Package_LGA.pretty", "Bosch_LGA-8_2.5x2.5mm_P0.65mm_ClockwisePinNumbering"),
    "header-1x04": ("Connector_PinHeader_2.54mm.pretty", "PinHeader_1x04_P2.54mm_Vertical"),
    "cap-100nf-0402": ("Capacitor_SMD.pretty", "C_0402_1005Metric"),
    "res-4k7-0402": ("Resistor_SMD.pretty", "R_0402_1005Metric"),
}
VALUES = {"U1": "BME280", "J1": "1x04 2.54mm vertical header", "C1": "100nF", "C2": "100nF",
          "R1": "4.7k", "R2": "4.7k"}
NETS = {
    "3V3": {"U1.6", "U1.8", "U1.2", "J1.1", "C1.1", "C2.1", "R1.1", "R2.1"},
    "GND": {"U1.1", "U1.7", "U1.5", "J1.2", "C1.2", "C2.2"},
    "SDA": {"U1.3", "J1.3", "R1.2"}, "SCL": {"U1.4", "J1.4", "R2.2"},
}
PLACEMENT = {"U1": (14, 9, 0), "J1": (3, 5.19, 0),
             "C1": (12.7, 11.6, -90), "C2": (14.7, 11.6, -90),
             "R1": (17, 6.3, 0), "R2": (17, 8, 0)}
LABELS = {"U1": (14, 6.6), "J1": (3, 3), "C1": (12.4, 13.4),
          "C2": (15, 13.4), "R1": (19.1, 6.3), "R2": (19.1, 8)}
MAX_JSON = 1024 * 1024
MAX_ASSET = 32 * 1024 * 1024
RESERVED_NETS = frozenset(("GND", "SDA", "SCL"))
SDA_ESCAPE_NM = 800000  # One fixed north escape, never a wider routing search.
SCL_ESCAPE_NM = 650000  # One fixed east escape; all existing GND/SDA stay foreign.


class NativeError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise NativeError(message)


def no_links(path):
    path = Path(path)
    require(path.is_absolute() and ".." not in path.parts, "absolute non-traversing path required")
    for ancestor in [path] + list(path.parents):
        require(not ancestor.is_symlink(), "symlink path rejected")
    return path


def safe_file(path, limit, roots=None):
    path = no_links(path)
    if roots is not None:
        require(any(path.is_relative_to(root) for root in roots), "file outside reviewed roots")
    info = path.stat()
    require(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= limit, "file missing, empty, nonregular or oversized")
    return path


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate JSON key")
        result[key] = value
    return result


def read_json(path):
    return json.loads(safe_file(path, MAX_JSON).read_text(), object_pairs_hook=unique_object,
                      parse_constant=lambda _: (_ for _ in ()).throw(NativeError("nonfinite JSON")))


def write_json(path, value):
    # Exclusive writes deliberately prohibit silently replacing an earlier attempt.
    with no_links(path).open("x") as stream:
        json.dump(value, stream, indent=2, sort_keys=True, allow_nan=False)
        stream.write("\n")


def write_plan_diagnostic(output, value):
    payload = (json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n").encode("utf-8")
    require(len(payload) <= 262144, "ground diagnostic exceeds size bound")
    with no_links(output / "ground-plan-diagnostic.json").open("xb") as stream:
        stream.write(payload)


STAGES = frozenset(("import-start", "import-evidence-written", "fill-evidence-written", "inspect-start", "finish-start", "prepared-verified", "board-loaded", "before-import", "after-import",
                    "imported-saved", "imported-reloaded", "imported-identity-verified", "zones-created",
                    "before-connectivity-build", "after-connectivity-build", "before-zone-fill", "after-zone-fill",
                    "ground-measured", "ground-stitched", "before-final-fill", "after-final-fill",
                    "filled", "final-saved", "final-reloaded", "final-identity-verified", "evidence-written"))


def stage(output, label):
    require(label in STAGES, "unknown native journal stage")
    path = no_links(output / "native-stage.jsonl")
    if path.exists():
        safe_file(path, 8192)
    with path.open("a") as stream:
        stream.write(json.dumps({"version": VERSION, "stage": label}) + "\n")
        stream.flush()


def vector(value, expected, label):
    require(isinstance(value, list) and len(value) == 3 and all(
        type(n) in (int, float) and math.isfinite(n) for n in value), label + " invalid")
    require(all(abs(a - b) < 1e-8 for a, b in zip(value, expected)), label + " differs from reviewed model")


def validate_input(data):
    require(isinstance(data, dict) and data.get("version") == VERSION, "unsupported native input version")
    require(set(data) <= {"version", "parts", "catalog", "nets", "board", "placement", "assetRoots"},
            "unexpected native input fields")
    require(data.get("board") == BOARD, "requires fixed 24x18mm two-layer board")
    parts = data.get("parts")
    require(isinstance(parts, list) and len(parts) == 6, "requires six reviewed parts")
    refs = {}
    for part in parts:
        require(isinstance(part, dict) and set(part) <= {"ref", "catalogId", "value"}, "invalid part fields")
        ref = part.get("ref")
        require(isinstance(ref, str) and ref in PARTS and ref not in refs and part.get("catalogId") == PARTS[ref],
                "unexpected, duplicate or substituted part")
        require("value" not in part or part["value"] == VALUES[ref], "part value substitution")
        refs[ref] = part
    nets = data.get("nets")
    require(isinstance(nets, list) and len(nets) == 4, "requires four canonical nets")
    seen = set()
    for net in nets:
        require(isinstance(net, dict) and set(net) == {"name", "pins"}, "invalid canonical net")
        name = net["name"]
        require(isinstance(name, str) and name in NETS and name not in seen, "unknown or duplicate canonical net")
        seen.add(name)
        pins = net["pins"]
        require(isinstance(pins, list), "invalid canonical pins")
        endpoints = []
        for pin in pins:
            require(isinstance(pin, dict) and set(pin) == {"ref", "pad"} and
                    isinstance(pin["ref"], str) and isinstance(pin["pad"], str), "invalid canonical endpoint")
            endpoints.append(pin["ref"] + "." + pin["pad"])
        require(len(set(endpoints)) == len(endpoints) and set(endpoints) == NETS[name],
                "canonical electrical topology mismatch: " + name)
    placement = data.get("placement")
    if placement is not None:
        require(isinstance(placement, list) and len(placement) == 6, "invalid placement")
        positions = {}
        for item in placement:
            require(isinstance(item, dict) and set(item) == {"ref", "xMm", "yMm", "rotationDeg"}, "invalid placement fields")
            ref = item["ref"]
            require(isinstance(ref, str) and ref in PLACEMENT and ref not in positions, "duplicate or unknown placement")
            positions[ref] = (item["xMm"], item["yMm"], item["rotationDeg"])
        require(positions == PLACEMENT, "only deterministic reviewed placement is supported")
    roots = data.get("assetRoots")
    require(isinstance(roots, list) and 1 <= len(roots) <= 8 and all(isinstance(x, str) for x in roots),
            "reviewed assetRoots required")
    roots = [no_links(x) for x in roots]
    require(all(p.is_dir() and p != Path("/") for p in roots), "invalid asset root")
    catalog = data.get("catalog")
    require(isinstance(catalog, dict) and set(catalog) == set(FOOTPRINTS), "catalog identity mismatch")
    for catalog_id, asset in catalog.items():
        require(isinstance(asset, dict), "invalid asset")
        fp = asset.get("footprint")
        library, name = FOOTPRINTS[catalog_id]
        require(isinstance(fp, dict) and isinstance(fp.get("libraryPath"), str) and
                Path(fp["libraryPath"]).name == library and fp.get("name") == name, "footprint identity mismatch")
        check_asset(Path(fp["libraryPath"]) / (name + ".kicad_mod"), fp.get("sha256"), roots)
        expected_pads = [str(n) for n in range(1, 9 if catalog_id == "bme280" else 5 if catalog_id == "header-1x04" else 3)]
        require(asset.get("padNumbers") == expected_pads, "catalog pad numbers mismatch")
        models = asset.get("models")
        require(isinstance(models, list) and len(models) == 1 and isinstance(models[0], dict), "one exact STEP model required")
        model = models[0]
        require(isinstance(model.get("path"), str) and Path(model["path"]).name == name + ".step", "model identity mismatch")
        source = "${KICAD10_3DMODEL_DIR}/" + library.replace(".pretty", ".3dshapes") + "/" + name + ".step"
        require(model.get("sourceReference") == source, "source model reference mismatch")
        check_asset(model["path"], model.get("sha256"), roots)
        offset = [0.01500000025, -0.03500000059, 0] if catalog_id == "bme280" else [0, 0, 0]
        vector(model.get("offsetMm"), offset, "offset")
        vector(model.get("scale"), [1, 1, 1], "scale")
        vector(model.get("rotationDeg"), [0, 0, 0], "rotation")
    return data


def check_asset(path, sha256, roots):
    require(isinstance(sha256, str) and re.fullmatch(r"[a-f0-9]{64}", sha256), "invalid asset hash")
    require(digest(safe_file(path, MAX_ASSET, roots)) == sha256, "asset hash mismatch")


def xy(point):
    return [int(point.x), int(point.y)]


def xyz(point):
    return [round(float(getattr(point, axis)), 8) for axis in ("x", "y", "z")]


def model_identity(model):
    return {"path": str(model.m_Filename), "offsetMm": xyz(model.m_Offset),
            "scale": xyz(model.m_Scale), "rotationDeg": xyz(model.m_Rotation),
            "show": bool(model.m_Show), "opacity": round(float(model.m_Opacity), 8)}


def identity(board):
    """Persisted native geometry, not reconstructed rectangles or package guesses."""
    footprints = []
    for fp in board.GetFootprints():
        pads = []
        for pad in fp.Pads():
            pads.append({"number": str(pad.GetNumber()), "net": str(pad.GetNetname()),
                         "positionNm": xy(pad.GetPosition()), "sizeNm": xy(pad.GetSize()),
                         "offsetNm": xy(pad.GetOffset()), "rotationDeg": round(float(pad.GetOrientationDegrees()), 6),
                         "shape": int(pad.GetShape()), "attribute": int(pad.GetAttribute()),
                         "layers": sorted(int(layer) for layer in pad.GetLayerSet().Seq()),
                         "drillNm": xy(pad.GetDrillSize()), "drillShape": int(pad.GetDrillShape()),
                         "roundrectRatio": round(float(pad.GetRoundRectRadiusRatio()), 8)})
        footprints.append({"ref": str(fp.GetReference()), "value": str(fp.GetValue()),
                           "footprintId": str(fp.GetFPIDAsString()),
                           "positionNm": xy(fp.GetPosition()), "rotationDeg": round(float(fp.GetOrientationDegrees()), 6),
                           "layer": int(fp.GetLayer()), "pads": sorted(pads, key=lambda p: p["number"]),
                           "models": [model_identity(m) for m in fp.Models()]})
    return {"layers": int(board.GetCopperLayerCount()), "footprints": sorted(footprints, key=lambda f: f["ref"])}


def assert_identity(before, after):
    require(before == after, "native pad/net/model/placement identity changed")


def check_topology(board):
    actual = {name: set() for name in NETS}
    refs = set()
    for fp in board.GetFootprints():
        ref = str(fp.GetReference())
        require(ref in PARTS and ref not in refs, "saved board footprint identity mismatch")
        refs.add(ref)
        for pad in fp.Pads():
            net = str(pad.GetNetname())
            endpoint = ref + "." + str(pad.GetNumber())
            require(net in actual and endpoint not in actual[net], "unknown or duplicated native pad/net")
            actual[net].add(endpoint)
    require(refs == set(PARTS) and actual == NETS, "saved board canonical topology mismatch")
    require(board.GetCopperLayerCount() == 2, "saved board layer count changed")


def close_decouplers(board, pcbnew):
    pads = {str(f.GetReference()) + "." + str(p.GetNumber()): p for f in board.GetFootprints() for p in f.Pads()}
    measurements = []
    for cap, supply in (("C1.1", "U1.8"), ("C2.1", "U1.6")):
        a, b = pads[cap], pads[supply]
        ground = pads[cap.split(".")[0] + ".2"]
        require(all(p.IsOnLayer(pcbnew.F_Cu) for p in (a, b, ground)), "decoupler not on front copper")
        pa, pb = a.GetPosition(), b.GetPosition()
        distance = math.hypot(pa.x - pb.x, pa.y - pb.y) / 1e6
        require(distance <= 2, "decoupler supply pad exceeds 2mm engineering constraint")
        measurements.append({"capacitorPad": cap, "supplyPad": supply, "distanceMm": round(distance, 6), "maxMm": 2})
    return measurements


def check_pad_clearance(board, pcbnew):
    # Same effective-shape API as tools/kicad/kicad_geom.CopperIndex; no bbox approximation.
    pads = [p for fp in board.GetFootprints() for p in fp.Pads()]
    for i, a in enumerate(pads):
        for b in pads[i + 1:]:
            if a.GetNetCode() == b.GetNetCode():
                continue
            for layer in (pcbnew.F_Cu, pcbnew.B_Cu):
                if a.IsOnLayer(layer) and b.IsOnLayer(layer):
                    require(not shapes_collide(pcbnew, a.GetEffectiveShape(layer), b.GetEffectiveShape(layer), pcbnew.FromMM(0.15)),
                            "placement has other-net pad clearance collision")


def inset_dsn(text, inset_um=650):
    """Restricted rectangular boundary recipe from export_dsn, without fanout."""
    require(re.search(r"\(resolution\s+um\s+10\s*\)", text) is not None,
            "unexpected DSN units/resolution; cannot apply reviewed inset")
    matches = list(re.finditer(r"\(boundary\s*\(path\s+pcb\s+0\s+([0-9.eE+\s-]+?)\)", text))
    require(len(matches) == 1, "requires one rectangular DSN board boundary")
    match = matches[0]
    values = [float(x) for x in match.group(1).split()]
    require(len(values) in (8, 10) and all(math.isfinite(x) for x in values), "invalid DSN rectangle")
    points = list(zip(values[::2], values[1::2]))
    xs, ys = sorted(set(values[::2])), sorted(set(values[1::2]))
    require(len(xs) == len(ys) == 2 and set(points) == {(x, y) for x in xs for y in ys}, "nonrectangular DSN boundary")
    require(abs(xs[1] - xs[0] - 24000) < 1 and abs(ys[1] - ys[0] - 18000) < 1, "DSN dimensions differ from board")
    x0, x1, y0, y1 = xs[0] + inset_um, xs[1] - inset_um, ys[0] + inset_um, ys[1] - inset_um
    replacement = f"(boundary\n      (path pcb 0 {x1:.0f} {y0:.0f} {x0:.0f} {y0:.0f} {x0:.0f} {y1:.0f} {x1:.0f} {y1:.0f} {x1:.0f} {y0:.0f})"
    return text[:match.start()] + replacement + text[match.end():]


def configure_board(board, pcbnew):
    board.SetCopperLayerCount(2)
    ds = board.GetDesignSettings()
    for key, value in {"m_MinClearance": 0.15, "m_TrackMinWidth": 0.15, "m_ViasMinSize": 0.6,
                       "m_MinThroughDrill": 0.3, "m_ViasMinAnnularWidth": 0.15,
                       "m_HoleClearance": 0.25, "m_HoleToHoleMin": 0.25, "m_CopperEdgeClearance": 0.5}.items():
        setattr(ds, key, pcbnew.FromMM(value))
    ds.m_MinResolvedSpokes = 2
    nc = ds.m_NetSettings.GetDefaultNetclass()
    nc.SetClearance(pcbnew.FromMM(0.15))
    nc.SetTrackWidth(pcbnew.FromMM(0.2))
    nc.SetViaDiameter(pcbnew.FromMM(0.6))
    nc.SetViaDrill(pcbnew.FromMM(0.3))
    corners = [(0, 0), (24, 0), (24, 18), (0, 18)]
    for start, end in zip(corners, corners[1:] + corners[:1]):
        edge = pcbnew.PCB_SHAPE(board)
        edge.SetShape(pcbnew.SHAPE_T_SEGMENT)
        edge.SetStart(pcbnew.VECTOR2I(*(pcbnew.FromMM(v) for v in start)))
        edge.SetEnd(pcbnew.VECTOR2I(*(pcbnew.FromMM(v) for v in end)))
        edge.SetLayer(pcbnew.Edge_Cuts)
        edge.SetWidth(pcbnew.FromMM(0.05))
        board.Add(edge)


def assign_model_path(fp, model, path):
    # KiCad 10 SWIG iteration returns model values, not writable vector references.
    # Copy the exact loaded value back through the native vector setter.
    original = model_identity(model)
    model.m_Filename = path
    fp.Models()[0] = model
    expected = dict(original, path=path)
    require(model_identity(list(fp.Models())[0]) == expected, "model filename assignment did not persist")


def create_board(data, pcbnew):
    board = pcbnew.BOARD()
    configure_board(board, pcbnew)
    nets = {}
    for net in data["nets"]:
        item = pcbnew.NETINFO_ITEM(board, net["name"])
        board.Add(item)
        nets[net["name"]] = item
    assignments = {pin["ref"] + "." + pin["pad"]: nets[net["name"]] for net in data["nets"] for pin in net["pins"]}
    for part in sorted(data["parts"], key=lambda p: p["ref"]):
        ref = part["ref"]
        asset = data["catalog"][part["catalogId"]]
        fp = pcbnew.FootprintLoad(asset["footprint"]["libraryPath"], asset["footprint"]["name"])
        require(fp is not None, "exact FootprintLoad failed")
        require(sorted(str(p.GetNumber()) for p in fp.Pads()) == asset["padNumbers"], "loaded pad numbers differ from catalog")
        models = list(fp.Models())
        require(len(models) == 1, "loaded footprint requires exact single model")
        model, expected = models[0], asset["models"][0]
        require(str(model.m_Filename) == expected["sourceReference"], "loaded model reference differs from catalog")
        for field, native in (("offsetMm", model.m_Offset), ("scale", model.m_Scale), ("rotationDeg", model.m_Rotation)):
            vector(xyz(native), expected[field], "loaded " + field)
        require(bool(model.m_Show), "loaded model is hidden")
        assign_model_path(fp, model, expected["path"])
        library, name = FOOTPRINTS[part["catalogId"]]
        fpid = library.removesuffix(".pretty") + ":" + name
        fp.SetFPIDAsString(fpid)
        require(str(fp.GetFPIDAsString()) == fpid, "qualified footprint library identity did not persist")
        fp.SetReference(ref)
        fp.SetValue(VALUES[ref])
        fp.Value().SetVisible(False)
        x, y, angle = PLACEMENT[ref]
        fp.SetPosition(pcbnew.VECTOR2I(pcbnew.FromMM(x), pcbnew.FromMM(y)))
        fp.SetOrientationDegrees(angle)
        label = fp.Reference()
        label.SetPosition(pcbnew.VECTOR2I(*(pcbnew.FromMM(n) for n in LABELS[ref])))
        label.SetTextAngle(pcbnew.EDA_ANGLE(0, pcbnew.DEGREES_T))
        label.SetTextSize(pcbnew.VECTOR2I(pcbnew.FromMM(0.8), pcbnew.FromMM(0.8)))
        label.SetTextThickness(pcbnew.FromMM(0.1))
        for pad in fp.Pads():
            pad.SetNet(assignments[ref + "." + str(pad.GetNumber())])
        board.Add(fp)
    check_topology(board)
    close_decouplers(board, pcbnew)
    check_pad_clearance(board, pcbnew)
    return board


ENABLED_DEFAULT_CHECKS = frozenset(("missing_courtyard", "track_not_centered_on_via",
                                    "tuning_profile_track_geometries", "footprint_filters_mismatch",
                                    "footprint_type_mismatch"))


def project_policy(project, strengthen=False):
    settings = project.get("board", {}).get("design_settings", {})
    severities = settings.get("rule_severities")
    require(isinstance(severities, dict) and ENABLED_DEFAULT_CHECKS <= set(severities), "project DRC severities missing")
    require(settings.get("drc_exclusions") == [], "project DRC exclusions forbidden")
    require(settings.get("rules", {}).get("min_resolved_spokes") == 2, "project thermal minimum must remain two")
    for key, severity in list(severities.items()):
        require(severity in ("error", "warning", "ignore"), "unsupported project DRC severity")
        if severity == "ignore":
            require(strengthen and key in ENABLED_DEFAULT_CHECKS, "ignored project DRC check: " + key)
            severities[key] = "error"
    require(all(severities[key] == "error" for key in ENABLED_DEFAULT_CHECKS), "required project DRC checks not enabled")
    return project


def project_hash(board_path, strengthen=False):
    path = Path(board_path).with_suffix(".kicad_pro")
    project = project_policy(read_json(path), strengthen)
    if strengthen:
        # Only immediately after creation by our own SaveBoard. This is pure
        # JSON, no native reload or save. A later native teardown rewrite is
        # caught by the next fresh process's project hash/policy verification.
        path.write_text(json.dumps(project, indent=2, sort_keys=True, allow_nan=False) + "\n")
    return digest(path)


RESERVED_ESCAPE_RADII_NM = (600000, 800000, 1000000, 1200000, 1500000, 1800000, 2200000, 2600000)


def opposite_escape_pairs(center, size, angle_degrees):
    # Native pad size is local; rotate its longest axis into board coordinates.
    require(size[0] != size[1] and min(size) > 0, "escape requires a non-square native pad")
    angle = math.radians(angle_degrees + (90 if size[1] > size[0] else 0))
    # KiCad board coordinates have +y down, while pad angle is counterclockwise.
    axis = (math.cos(angle), -math.sin(angle))
    return [((center[0] + round(radius * axis[0]), center[1] + round(radius * axis[1])),
             (center[0] - round(radius * axis[0]), center[1] - round(radius * axis[1])))
            for radius in RESERVED_ESCAPE_RADII_NM]


def dogleg_escape_candidates(center, size, angle_degrees, direction, obstacles, via_boxes):
    """One cardinal major-axis exit, then one lateral turn; <=16 choices.

    Exact rectangle bounds only generate an interval/candidates. Entire native
    segment/via/hole guards subsequently establish legality. No pad-specific
    coordinate, placement change or route retry is encoded here.
    """
    pair = opposite_escape_pairs(center, size, angle_degrees)[0]
    delta = (pair[direction][0] - center[0], pair[direction][1] - center[1])
    axis = 0 if abs(delta[0]) > abs(delta[1]) else 1
    other = 1 - axis
    require(delta[other] == 0, "dogleg requires cardinal native pad major axis")
    sign = 1 if delta[axis] > 0 else -1
    minimum = max(size) // 2 + 200000 + 100000  # entire .2mm bend beyond FULL thermal gap
    maximum = 2600000
    for box in obstacles:
        if box[other] <= center[other] <= box[other + 2]:
            near = box[axis] if sign > 0 else box[axis + 2]
            distance = sign * (near - center[axis])
            if distance > 0:
                maximum = min(maximum, distance)
    if maximum - minimum <= 2:
        return []
    corner = list(center)
    corner[axis] += sign * ((minimum + maximum) // 2)
    # Project lateral coordinates of actual via-obstacle cell centers onto
    # the fixed corner line. Projection generates candidates only; both full
    # native segments plus the via/drill must independently pass the guard.
    centers = corridor_candidates(tuple(corner), via_boxes)
    values = sorted({point[other] for point in centers}, key=lambda value: (abs(value - corner[other]), value))[:16]
    result = []
    for value in values:
        end = list(corner)
        end[other] = value
        if abs(value - corner[other]) >= 400000 and math.hypot(end[0] - center[0], end[1] - center[1]) <= 2600000:
            result.append((tuple(corner), tuple(end)))
    return result


def reserved_copper(board, pcbnew):
    result = []
    for item in board.GetTracks():
        if not item.IsLocked():
            continue
        net = str(item.GetNetname())
        require(net in RESERVED_NETS, "unexpected locked reservation net")
        common = {"uuid": str(item.m_Uuid.AsString()), "net": net, "locked": True,
                  "widthNm": int(item.GetWidth())}
        if isinstance(item, pcbnew.PCB_VIA):
            common.update(kind="via", positionNm=xy(item.GetPosition()), drillNm=int(item.GetDrillValue()),
                          layers=sorted(layer for layer in (pcbnew.F_Cu, pcbnew.B_Cu) if item.IsOnLayer(layer)))
            if net in ("SDA", "SCL"):
                require(item.GetViaType() == pcbnew.VIATYPE_THROUGH, "reserved " + net + " via is not plated through")
                common["viaType"] = int(item.GetViaType())
        else:
            common.update(kind="track", startNm=xy(item.GetStart()), endNm=xy(item.GetEnd()), layer=int(item.GetLayer()))
        result.append(common)
    require(len({item["uuid"] for item in result}) == len(result), "duplicate reserved copper UUID")
    return sorted(result, key=lambda item: item["uuid"])


def assert_reserved(expected, board, pcbnew):
    require(reserved_copper(board, pcbnew) == expected, "reserved GND/SDA/SCL copper dropped, duplicated or changed")
    # Also detect an unlocked duplicate of a reserved item. UUID alone cannot
    # catch a router/import copying geometry under a new identity.
    all_shapes = set()
    for item in board.GetTracks():
        net = str(item.GetNetname())
        if net not in RESERVED_NETS:
            continue
        if isinstance(item, pcbnew.PCB_VIA):
            key = (net, "via", tuple(xy(item.GetPosition())), int(item.GetWidth()), int(item.GetDrillValue()),
                   tuple(layer for layer in (pcbnew.F_Cu, pcbnew.B_Cu) if item.IsOnLayer(layer)))
        else:
            ends = sorted((tuple(xy(item.GetStart())), tuple(xy(item.GetEnd()))))
            key = (net, "track", tuple(ends), int(item.GetLayer()), int(item.GetWidth()))
        require(key not in all_shapes, "duplicate " + net + " copper geometry")
        all_shapes.add(key)


def check_reserved_clearance(board, pcbnew):
    """Recheck retained copper against newly imported/final foreign copper.

    No repair/restoration. A router may snap beyond its obstacle grid; exact
    native shape checks, independently of lock/UUID identity, must catch it.
    """
    guards = {}
    all_holes = [(str(item.m_Uuid.AsString()), item.GetEffectiveHoleShape())
                 for fp in board.GetFootprints() for item in fp.Pads()
                 if item.GetDrillSize().x > 0 or item.GetDrillSize().y > 0]
    all_holes += [(str(item.m_Uuid.AsString()), item.GetEffectiveHoleShape())
                  for item in board.GetTracks() if isinstance(item, pcbnew.PCB_VIA)]
    for item in board.GetTracks():
        if not item.IsLocked():
            continue
        net = str(item.GetNetname())
        require(net in RESERVED_NETS, "reserved copper has foreign net")
        if net not in guards:
            guards[net] = GroundClearance(board, pcbnew, net)
        guard = guards[net]
        if not isinstance(item, pcbnew.PCB_VIA):
            require(guard.stub_clear(item.GetEffectiveShape(), item.GetLayer()),
                    "reserved " + net + " stub clearance violated by imported copper")
            continue
        uuid = str(item.m_Uuid.AsString())
        drill = item.GetEffectiveHoleShape()
        require(drill is not None and guard.inside_edges(drill), "reserved via drill edge violation")
        for layer in guard.layers:
            land = item.GetEffectiveShape(layer)
            require(guard.inside_edges(land), "reserved via land edge violation")
            require(not any(shapes_collide(pcbnew, pad, land, 0) for pad in guard.pads),
                    "reserved via overlaps pad")
            require(not any(shapes_collide(pcbnew, foreign, land, guard.clearance) or
                            shapes_collide(pcbnew, foreign, drill, guard.hole_clearance) for foreign in guard.other[layer]),
                    "reserved via clearance violated by imported copper")
            require(not any(shapes_collide(pcbnew, hole, land, guard.hole_clearance)
                            for hole, own in guard.holes if not own), "reserved via land violates foreign hole clearance")
        require(not any(shapes_collide(pcbnew, hole, drill, guard.hole_clearance)
                        for other_uuid, hole in all_holes if other_uuid != uuid),
                "reserved via hole spacing violated")


def bounded_escape_plan(tasks, candidates_for, evaluate):
    """FINAL SPEC v3: lexical, no backtracking, <=10x24=240 checks.

    The complete virtual plan must succeed before any native board mutation.
    A failed fixed-order assignment stops, never invokes a wider search.
    """
    require(len(tasks) <= 10 and tasks == sorted(tasks), "reservation task order/bound invalid")
    planned, evaluations = [], 0
    for task in tasks:
        candidates = candidates_for(task, planned)
        require(len(candidates) <= 24, "reservation per-escape candidate cap exceeded")
        chosen = None
        for candidate in candidates:
            require(evaluations < 240, "reservation candidate evaluation cap exhausted")
            evaluations += 1
            chosen = evaluate(task, candidate, planned)
            if chosen is not None:
                break
        require(chosen is not None, "no legal opposite pre-route GND escape assignment for " + str(task))
        planned.append(chosen)
    return planned, evaluations


def reserve_sensor_ground(board, pcbnew):
    """Reserve TWO opposite escapes per reviewed sensor/decoupler ground pad.

    No signal router has run yet. All pairs must be legal before adding any
    copper. Locked geometry is exported as DSN fix wiring and must survive SES
    import exactly. Final fill/connectivity/DRC, not these vias, prove success.
    """
    guard = GroundClearance(board, pcbnew)
    pads = {str(fp.GetReference()) + "." + str(pad.GetNumber()): pad
            for fp in board.GetFootprints() for pad in fp.Pads()
            if str(fp.GetReference()) in ("U1", "C1", "C2") and str(pad.GetNetname()) == "GND"}
    require(set(pads) == {pin for pin in NETS["GND"] if not pin.startswith("J1.")}, "ground escape topology changed")
    tasks, contours = [], {}
    for endpoint, pad in sorted(pads.items()):
        require(pad.IsOnLayer(pcbnew.F_Cu) and pad.GetDrillSize().x == pad.GetDrillSize().y == 0,
                "escape requires undrilled front pad")
        half_gap = pcbnew.SHAPE_POLY_SET()
        pad.TransformShapeToPolygon(half_gap, pcbnew.F_Cu, 100000, pcbnew.FromMM(pcbnew.ARC_LOW_DEF_MM), pcbnew.ERROR_OUTSIDE)
        require(half_gap.OutlineCount() == 1 and half_gap.HoleCount(0) == 0, "unsupported escape pad contour")
        contours[endpoint] = native_chain(half_gap.COutline(0))
        tasks.extend((endpoint, direction) for direction in (0, 1))
    def box(shape, margin):
        b = shape.BBox()
        return (b.GetLeft() - margin, b.GetTop() - margin, b.GetRight() + margin, b.GetBottom() + margin)
    def candidates_for(task, prefix):
        endpoint, direction = task
        pad = pads[endpoint]
        center = xy(pad.GetPosition())
        pairs = opposite_escape_pairs(center, xy(pad.GetSize()), pad.GetOrientationDegrees())
        obstacles = guard.stub_obstacle_boxes(pcbnew.F_Cu)
        # Other same-net pads/accepted lands also bound a useful corner. These
        # boxes generate candidates only; native copper may join same-net tracks.
        obstacles += [box(other.GetEffectiveShape(pcbnew.F_Cu), 250000)
                      for name, other in pads.items() if name != endpoint]
        obstacles += [box(old["land"], 250000) for old in prefix]
        via_boxes = guard.corridor_boxes() + [box(old["land"], 300000) for old in prefix]
        via_boxes += [box(old["drill"], 400000) for old in prefix]
        return [(pair[direction],) for pair in pairs] + dogleg_escape_candidates(
            center, xy(pad.GetSize()), pad.GetOrientationDegrees(), direction, obstacles, via_boxes)
    def evaluate(task, path, prefix):
        endpoint, _ = task
        start = pads[endpoint].GetPosition()
        at = pcbnew.VECTOR2I(*path[-1])
        points = [start] + [pcbnew.VECTOR2I(*point) for point in path]
        envelope = crossing_envelope(tuple(xy(start)), tuple(xy(points[1])), contours[endpoint], 200000)
        if envelope is None:
            return None
        crossing = pcbnew.SHAPE_CIRCLE(pcbnew.VECTOR2I(*envelope[0]), envelope[1])
        if any(old["pad"] == endpoint and shapes_collide(pcbnew, old["crossing"], crossing, 0) for old in prefix):
            return None
        segments = [pcbnew.SHAPE_SEGMENT(a, b, 200000) for a, b in zip(points, points[1:])]
        land, drill = pcbnew.SHAPE_CIRCLE(at, 300000), pcbnew.SHAPE_CIRCLE(at, 150000)
        if any(guard.reject(segment, pcbnew.F_Cu, land, drill) is not None for segment in segments):
            return None
        if any(shapes_collide(pcbnew, old["land"], land, 0) or
               shapes_collide(pcbnew, old["drill"], drill, 250000) for old in prefix):
            return None
        return {"pad": endpoint, "start": start, "at": at, "land": land, "drill": drill,
                "points": points, "crossing": crossing}
    planned, evaluations = bounded_escape_plan(tasks, candidates_for, evaluate)
    require(len(planned) == 10 and evaluations <= 240, "incomplete bounded ground reservation")
    net = board.FindNet("GND")
    for choice in planned:
        via = pcbnew.PCB_VIA(board)
        via.SetViaType(pcbnew.VIATYPE_THROUGH)
        via.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
        via.SetPosition(choice["at"])
        via.SetWidth(600000)
        via.SetDrill(300000)
        via.SetNet(net)
        via.SetLocked(True)
        board.Add(via)
        for start, end in zip(choice["points"], choice["points"][1:]):
            track = pcbnew.PCB_TRACK(board)
            track.SetStart(start)
            track.SetEnd(end)
            track.SetWidth(200000)
            track.SetLayer(pcbnew.F_Cu)
            track.SetNet(net)
            track.SetLocked(True)
            board.Add(track)
    return reserved_copper(board, pcbnew)


def reserve_sensor_sda(board, data, pcbnew):
    """One reviewed north escape from the canonical proposal's U1.3 SDA net.

    Ground reservation runs first and is immutable. All of its copper/holes
    are foreign obstacles here. No dogleg, pad change, net reassignment, search
    expansion or post-router restoration is permitted if the exact seed fails.
    """
    selected = [net for net in data["nets"] if net["name"] == "SDA"]
    require(len(selected) == 1, "canonical SDA proposal missing or duplicated")
    pins = [pin["ref"] + "." + pin["pad"] for pin in selected[0]["pins"]]
    require(len(pins) == len(set(pins)) and set(pins) == NETS["SDA"], "canonical SDA proposal topology changed")
    pads = {}
    for fp in board.GetFootprints():
        for pad in fp.Pads():
            endpoint = str(fp.GetReference()) + "." + str(pad.GetNumber())
            if endpoint in pins or str(pad.GetNetname()) == selected[0]["name"]:
                require(endpoint not in pads and endpoint in pins and str(pad.GetNetname()) == selected[0]["name"],
                        "native SDA pad topology changed")
                pads[endpoint] = pad
    require(set(pads) == set(pins), "native SDA pad missing")
    pad = pads["U1.3"]
    require(pad.IsOnLayer(pcbnew.F_Cu) and not pad.IsOnLayer(pcbnew.B_Cu) and
            pad.GetDrillSize().x == pad.GetDrillSize().y == 0, "SDA escape requires undrilled front pad")
    start = pad.GetPosition()
    require(xy(start) == [14325000, 7975000], "reviewed U1.3 SDA position changed")
    before = reserved_copper(board, pcbnew)
    require(len(before) == 22 and all(item["net"] == "GND" for item in before) and
            sum(item["kind"] == "track" for item in before) == 12 and
            sum(item["kind"] == "via" for item in before) == 10, "SDA requires original 22 GND-only reservations")
    assert_reserved(before, board, pcbnew)
    at = pcbnew.VECTOR2I(start.x, start.y - SDA_ESCAPE_NM)
    guard = GroundClearance(board, pcbnew, selected[0]["name"])
    stub = pcbnew.SHAPE_SEGMENT(start, at, 200000)
    land, drill = pcbnew.SHAPE_CIRCLE(at, 300000), pcbnew.SHAPE_CIRCLE(at, 150000)
    rejection = guard.reject(stub, pcbnew.F_Cu, land, drill)
    require(rejection is None, "no legal reviewed north SDA escape: " + str(rejection))
    net = board.FindNet(selected[0]["name"])
    require(net is not None and net.GetNetCode() > 0, "canonical SDA native net missing")
    track = pcbnew.PCB_TRACK(board)
    track.SetStart(start)
    track.SetEnd(at)
    track.SetWidth(200000)
    track.SetLayer(pcbnew.F_Cu)
    track.SetNet(net)
    track.SetLocked(True)
    via = pcbnew.PCB_VIA(board)
    via.SetViaType(pcbnew.VIATYPE_THROUGH)
    via.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
    via.SetPosition(at)
    via.SetWidth(600000)
    via.SetDrill(300000)
    via.SetNet(net)
    via.SetLocked(True)
    board.Add(track)
    board.Add(via)
    reserved = reserved_copper(board, pcbnew)
    require([item for item in reserved if item["net"] == "GND"] == before and len(reserved) == len(before) + 2,
            "SDA escape changed existing GND reservations")
    assert_reserved(reserved, board, pcbnew)
    check_reserved_clearance(board, pcbnew)
    return reserved


def reserve_sensor_scl(board, data, pcbnew):
    """One canonical U1.4 straight-east escape, never a copied north SDA seed.

    The original 22 GND and two SDA records are immutable. Evaluate the full
    native stub, land and drill against both layers and every foreign hole
    before adding either item. No search, reroute or native save/load is added.
    """
    selected = [net for net in data["nets"] if net["name"] == "SCL"]
    require(len(selected) == 1, "canonical SCL proposal missing or duplicated")
    pins = [pin["ref"] + "." + pin["pad"] for pin in selected[0]["pins"]]
    require(len(pins) == len(set(pins)) and set(pins) == NETS["SCL"], "canonical SCL proposal topology changed")
    pads = {}
    for fp in board.GetFootprints():
        for pad in fp.Pads():
            endpoint = str(fp.GetReference()) + "." + str(pad.GetNumber())
            if endpoint in pins or str(pad.GetNetname()) == "SCL":
                require(endpoint not in pads and endpoint in pins and str(pad.GetNetname()) == "SCL",
                        "native SCL pad topology changed")
                pads[endpoint] = pad
    require(set(pads) == set(pins), "native SCL pad missing")
    pad = pads["U1.4"]
    require(pad.IsOnLayer(pcbnew.F_Cu) and not pad.IsOnLayer(pcbnew.B_Cu) and
            pad.GetDrillSize().x == pad.GetDrillSize().y == 0, "SCL escape requires undrilled front pad")
    start = pad.GetPosition()
    require(xy(start) == [14975000, 7975000], "reviewed U1.4 SCL position changed")
    before = reserved_copper(board, pcbnew)
    counts = {(net, kind): sum(item["net"] == net and item["kind"] == kind for item in before)
              for net in RESERVED_NETS for kind in ("track", "via")}
    require(len(before) == 24 and counts == {("GND", "track"): 12, ("GND", "via"): 10,
            ("SDA", "track"): 1, ("SDA", "via"): 1, ("SCL", "track"): 0, ("SCL", "via"): 0},
            "SCL requires original 22 GND and two SDA reservations")
    sda_track = next(item for item in before if item["net"] == "SDA" and item["kind"] == "track")
    sda_via = next(item for item in before if item["net"] == "SDA" and item["kind"] == "via")
    require(sda_track["startNm"] == [14325000, 7975000] and sda_track["endNm"] == [14325000, 7175000] and
            sda_track["widthNm"] == 200000 and sda_track["layer"] == pcbnew.F_Cu and
            sda_via["positionNm"] == [14325000, 7175000] and sda_via["widthNm"] == 600000 and
            sda_via["drillNm"] == 300000 and sda_via["layers"] == sorted((pcbnew.F_Cu, pcbnew.B_Cu)),
            "SCL requires unchanged reviewed north SDA escape")
    assert_reserved(before, board, pcbnew)
    check_reserved_clearance(board, pcbnew)
    at = pcbnew.VECTOR2I(start.x + SCL_ESCAPE_NM, start.y)
    guard = GroundClearance(board, pcbnew, "SCL")
    stub = pcbnew.SHAPE_SEGMENT(start, at, 200000)
    land, drill = pcbnew.SHAPE_CIRCLE(at, 300000), pcbnew.SHAPE_CIRCLE(at, 150000)
    rejection = guard.reject(stub, pcbnew.F_Cu, land, drill)
    require(rejection is None, "no legal reviewed east SCL escape: " + str(rejection))
    net = board.FindNet("SCL")
    require(net is not None and net.GetNetCode() > 0 and str(net.GetNetname()) == "SCL",
            "canonical SCL native net missing or changed")
    track = pcbnew.PCB_TRACK(board)
    track.SetStart(start)
    track.SetEnd(at)
    track.SetWidth(200000)
    track.SetLayer(pcbnew.F_Cu)
    track.SetNet(net)
    track.SetLocked(True)
    via = pcbnew.PCB_VIA(board)
    via.SetViaType(pcbnew.VIATYPE_THROUGH)
    via.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
    via.SetPosition(at)
    via.SetWidth(600000)
    via.SetDrill(300000)
    via.SetNet(net)
    via.SetLocked(True)
    board.Add(track)
    board.Add(via)
    reserved = reserved_copper(board, pcbnew)
    require([item for item in reserved if item["net"] != "SCL"] == before and len(reserved) == 26,
            "SCL escape changed existing GND/SDA reservations")
    assert_reserved(reserved, board, pcbnew)
    check_reserved_clearance(board, pcbnew)
    return reserved


def verify_reserved_dsn(text, reserved):
    """Validate fixed wiring geometry exported by KiCad, not router promises."""
    require(re.search(r"\(resolution\s+um\s+10\s*\)", text) is not None, "reserved DSN units changed")
    # KiCad's parser declaration contains a literal unpaired quote token,
    # not a JSON string. Normalize ONLY that exact declaration, leaving all
    # ordinary quoted names/paths subject to strict string token validation.
    text = re.sub(r'(\(parser\s*)\(string_quote\s+"\s*\)', r'\1(string_quote quote)', text, count=1)
    tokens = []
    position = 0
    token_pattern = re.compile(r'\s*("(?:\\.|[^"\\])*"|[()]|[^\s()"]+)')
    while position < len(text):
        if not text[position:].strip():
            break
        match = token_pattern.match(text, position)
        require(match is not None, "malformed DSN quote or token")
        tokens.append(match.group(1))
        position = match.end()
    require(len(tokens) <= 200000, "DSN token bound exceeded")
    stack, roots = [], []
    for token in tokens:
        if token == "(":
            node = []
            (stack[-1] if stack else roots).append(node)
            stack.append(node)
            require(len(stack) <= 64, "DSN nesting bound exceeded")
        elif token == ")":
            require(bool(stack), "unbalanced DSN")
            stack.pop()
        else:
            require(bool(stack), "DSN token outside root")
            stack[-1].append(json.loads(token) if token.startswith('"') else token)
    require(not stack and len(roots) == 1, "unbalanced DSN root")
    children = lambda node, key: [child for child in node[1:] if isinstance(child, list) and child and child[0] == key]
    wiring = children(roots[0], "wiring")
    require(len(wiring) == 1, "reserved DSN wiring missing")
    def nm(value):
        scaled = Fraction(value) * 1000
        require(scaled.denominator == 1, "reserved DSN coordinate lost native precision")
        return int(scaled)
    require(reserved and all(item["net"] in RESERVED_NETS for item in reserved), "unreviewed reserved DSN net")
    expected_nets = {item["net"] for item in reserved}
    def net_name(node):
        nets = children(node, "net")
        require(len(nets) == 1 and len(nets[0]) == 2 and nets[0][1] in expected_nets,
                "reserved DSN wiring net changed")
        return nets[0][1]
    via_name = "Via[0-1]_600:300_um"
    libraries = children(roots[0], "library")
    require(len(libraries) == 1, "reserved DSN library missing")
    stacks = [node for node in children(libraries[0], "padstack") if len(node) > 1 and node[1] == via_name]
    require(len(stacks) == 1 and sorted(children(stacks[0], "shape")) ==
            [["shape", ["circle", "B.Cu", "600"]], ["shape", ["circle", "F.Cu", "600"]]] and
            children(stacks[0], "attach") == [["attach", "off"]], "reserved DSN through-via padstack changed")
    # KiCad exports drill in this reviewed name, not a separate plating/hole
    # field. Native THROUGH type, layer pair and drill remain source-of-truth.
    actual = []
    for wire in children(wiring[0], "wire"):
        net = net_name(wire)
        require(children(wire, "type") == [["type", "fix"]], "reserved DSN wire not fixed")
        paths = children(wire, "path")
        require(len(paths) == 1, "reserved DSN wire path missing")
        path = paths[0]
        require(len(path) >= 7 and len(path) % 2 == 1 and path[1] == "F.Cu", "reserved DSN path invalid")
        points = [(nm(path[i]), -nm(path[i + 1])) for i in range(3, len(path), 2)]
        for start, end in zip(points, points[1:]):
            actual.append((net, "track", "F.Cu", tuple(sorted((start, end))), nm(path[2])))
    for via in children(wiring[0], "via"):
        net = net_name(via)
        require(children(via, "type") == [["type", "fix"]], "reserved DSN via not fixed")
        require(len(via) >= 6 and via[1] == via_name, "reserved DSN via dimensions changed")
        actual.append((net, "via", ("F.Cu", "B.Cu"), (nm(via[2]), -nm(via[3])), 600000, 300000))
    expected = []
    for item in reserved:
        if item["kind"] == "track":
            require(item["layer"] == 0, "reserved DSN expected track layer changed")
            expected.append((item["net"], "track", "F.Cu", tuple(sorted((tuple(item["startNm"]), tuple(item["endNm"])))), item["widthNm"]))
        else:
            require(item["kind"] == "via" and item["layers"] == [0, 2], "reserved DSN expected via layers changed")
            expected.append((item["net"], "via", ("F.Cu", "B.Cu"), tuple(item["positionNm"]), item["widthNm"], item["drillNm"]))
    require(sorted(actual) == sorted(expected), "reserved DSN copper missing, duplicated or changed")


def checked_save(board, path, pcbnew):
    path = no_links(path)
    require(not path.exists(), "native output already exists")
    result = pcbnew.SaveBoard(str(path), board)
    require(result is not False, "native SaveBoard failed")
    safe_file(path, MAX_ASSET)
    return project_hash(path, strengthen=True)


def footprint_table(data):
    quote = lambda value: json.dumps(value, ensure_ascii=False)
    libraries = {}
    for cid, (library, _) in sorted(FOOTPRINTS.items()):
        nickname = library.removesuffix(".pretty")
        path = data["catalog"][cid]["footprint"]["libraryPath"]
        require(nickname not in libraries or libraries[nickname] == path, "conflicting footprint library path")
        libraries[nickname] = path
    return "(fp_lib_table\n  (version 7)\n" + "".join(
        "  (lib (name " + quote(name) + ")(type KiCad)(uri " + quote(path) + ")(options \"\")(descr \"\"))\n"
        for name, path in sorted(libraries.items())) + ")\n"


def checked_footprint_table(data, output):
    path = safe_file(output / "fp-lib-table", MAX_JSON)
    require(path.read_text() == footprint_table(data), "footprint library table differs from exact reviewed assets")
    return digest(path)


def prepare(data, input_path, output, pcbnew):
    for name in ("board.kicad_pcb", "board.dsn", "prepared-evidence.json", "fp-lib-table"):
        require(not no_links(output / name).exists(), "prepare output already exists")
    with no_links(output / "fp-lib-table").open("x") as stream:
        stream.write(footprint_table(data))
    table_sha256 = checked_footprint_table(data, output)
    board = create_board(data, pcbnew)
    initial = identity(board)
    reserve_sensor_ground(board, pcbnew)
    reserve_sensor_sda(board, data, pcbnew)
    reserved = reserve_sensor_scl(board, data, pcbnew)
    assert_identity(initial, identity(board))
    board_path = output / "board.kicad_pcb"
    project_sha256 = checked_save(board, board_path, pcbnew)
    saved = pcbnew.LoadBoard(str(board_path))
    assert_identity(initial, identity(saved))
    assert_reserved(reserved, saved, pcbnew)
    dsn_path = output / "board.dsn"
    require(pcbnew.ExportSpecctraDSN(saved, str(dsn_path)), "native DSN export failed")
    text = safe_file(dsn_path, MAX_ASSET).read_text()
    verify_reserved_dsn(text, reserved)
    dsn_path.write_text(inset_dsn(text))
    evidence = {"version": VERSION, "stage": "prepared", "inputSha256": digest(input_path),
                "boardSha256": digest(board_path), "projectSha256": project_sha256, "dsnSha256": digest(dsn_path),
                "tableSha256": table_sha256, "identity": initial, "reservedCopper": reserved,
                "reservationQualification": "locked-DSN-obstacles-and-import-retention-require-real-qualification",
                "routerSourceBinaryProvenance": "binary-pinned-source-build-binding-not-established",
                "reservationBounds": {"spec": "v3-lexical-no-backtracking", "escapes": 10,
                                      "candidatesPerEscape": 24, "totalCandidateChecks": 240},
                "sdaReservationBounds": {"endpoint": "U1.3", "direction": "north", "radiusNm": SDA_ESCAPE_NM,
                                         "escapes": 1, "totalCandidateChecks": 1},
                "sclReservationBounds": {"endpoint": "U1.4", "direction": "east", "radiusNm": SCL_ESCAPE_NM,
                                         "escapes": 1, "totalCandidateChecks": 1},
                "reservationCounts": {net: {kind: sum(item["net"] == net and item["kind"] == kind for item in reserved)
                                            for kind in ("track", "via")} for net in sorted(RESERVED_NETS)},
                "decouplers": close_decouplers(saved, pcbnew),
                "drc": {"available": False, "errors": None, "warnings": None}, "routeAttempts": 0}
    write_json(output / "prepared-evidence.json", evidence)
    return {"version": VERSION, "stage": "prepared", "board": board_path.name, "dsn": dsn_path.name,
            "evidence": "prepared-evidence.json"}


# Fixed finite search, not a router or a retry ladder. All dimensions are nm.
GROUND_RADII_NM = (400000, 500000, 600000, 800000, 1000000,
                   1200000, 1500000, 1800000, 2200000, 2600000)
GROUND_DIRECTIONS = 24
GROUND_GRAPH_LIMIT = 512


def ground_candidates(center):
    return [(center[0] + round(radius * math.cos(2 * math.pi * direction / GROUND_DIRECTIONS)),
             center[1] + round(radius * math.sin(2 * math.pi * direction / GROUND_DIRECTIONS)))
            for radius in GROUND_RADII_NM for direction in range(GROUND_DIRECTIONS)]


def corridor_candidates(center, expanded_boxes):
    """At most 256 deterministic cell centers from actual obstacle bounds.

    Bounding boxes ONLY generate candidates; native effective shapes decide
    legality. Integer interval midpoints retain micron-scale corridors without
    loosening clearance or claiming radial candidate exhaustion proves no path.
    """
    reach = 2600000
    require(len(expanded_boxes) <= 4 * GROUND_GRAPH_LIMIT, "corridor obstacle count exceeds bound")
    bounds = ((max(800000, center[0] - reach), min(23200000, center[0] + reach)),
              (max(800000, center[1] - reach), min(17200000, center[1] + reach)))
    axes = []
    for axis, (low, high) in enumerate(bounds):
        require(low < high, "ground corridor window outside board")
        cuts = {low, high}
        for box in expanded_boxes:
            if box[2] < bounds[0][0] or box[0] > bounds[0][1] or box[3] < bounds[1][0] or box[1] > bounds[1][1]:
                continue
            for value in (box[axis], box[axis + 2]):
                if low < value < high:
                    cuts.add(value)
        cuts = sorted(cuts)
        mids = [(left + right) // 2 for left, right in zip(cuts, cuts[1:]) if right - left > 1]
        axes.append(sorted(mids, key=lambda value: (abs(value - center[axis]), value))[:16])
    points = [(x, y) for x in axes[0] for y in axes[1]
              if (x - center[0]) ** 2 + (y - center[1]) ** 2 <= reach ** 2 and (x, y) != tuple(center)]
    return sorted(points, key=lambda point: ((point[0] - center[0]) ** 2 + (point[1] - center[1]) ** 2, point))


def connected_components(nodes, links):
    """Deterministic graph partition; a zone polygon, NOT a ZONE, is a node."""
    require(len(nodes) <= GROUND_GRAPH_LIMIT, "ground graph exceeds bounded size")
    adjacency = {key: set() for key in nodes}
    for left, right in links:
        require(left in nodes and right in nodes, "unknown ground graph node")
        adjacency[left].add(right)
        adjacency[right].add(left)
    result, remaining = [], set(nodes)
    while remaining:
        todo, reached = [min(remaining)], set()
        while todo:
            key = todo.pop()
            if key not in reached:
                reached.add(key)
                todo.extend(adjacency[key] - reached)
        result.append(reached)
        remaining -= reached
    return result


def shapes_collide(pcbnew, left, right, clearance=0):
    # KiCad10 SHAPE_CIRCLE.Collide exposes only the SEG overload and hides
    # inherited SHAPE/SHAPE dispatch. Call the BASE overload explicitly for
    # non-polygons; retain the polygon override (including hole semantics).
    if isinstance(left, pcbnew.SHAPE_POLY_SET):
        return left.Collide(right, clearance)
    if isinstance(right, pcbnew.SHAPE_POLY_SET):
        return right.Collide(left, clearance)
    return pcbnew.SHAPE.Collide(left, right, clearance)


def ground_links(nodes, pcbnew):
    links = []
    keys = sorted(nodes)
    for index, left in enumerate(keys):
        for right in keys[index + 1:]:
            # Distinct polygons from the SAME layer's fill are separate by
            # construction. Never ask native poly/poly collision to join them.
            if left.startswith("zone:") and right.startswith("zone:"):
                continue
            for layer in sorted(set(nodes[left]) & set(nodes[right])):
                a, b = nodes[left][layer], nodes[right][layer]
                # Dispatch through SHAPE_POLY_SET when one node is a polygon.
                if right.startswith("zone:"):
                    a, b = b, a
                if shapes_collide(pcbnew, a, b, 0):
                    links.append((left, right))
                    break
    return links


def ground_scene(board, pcbnew):
    """Measured filled copper components. No zone-wide connectivity shortcut.

    One multilayer node is legitimate for a plated pad/via only. Individual
    filled polygons keep their holes using UnitSet; sharing the same ZONE UUID
    is NOT an electrical connection. This is corroboration, not a DRC verdict.
    """
    layers = (pcbnew.F_Cu, pcbnew.B_Cu)
    nodes, pads, back_nodes = {}, {}, set()
    for fp in board.GetFootprints():
        for pad in fp.Pads():
            if str(pad.GetNetname()) != "GND":
                continue
            key = str(fp.GetReference()) + "." + str(pad.GetNumber())
            require(key not in pads, "duplicate ground pad")
            pads[key] = pad
            nodes[key] = {layer: pad.GetEffectiveShape(layer) for layer in layers if pad.IsOnLayer(layer)}
            require(nodes[key], "ground pad missing copper")
            if len(nodes[key]) > 1:
                require(pad.GetAttribute() == pcbnew.PAD_ATTRIB_PTH, "nonplated ground layer bridge")
    require(set(pads) == NETS["GND"], "ground graph endpoint mismatch")
    require(all(pad.IsOnLayer(pcbnew.F_Cu) for pad in pads.values()), "ground fanout requires front-layer pads")
    for index, item in enumerate(board.GetTracks()):
        if str(item.GetNetname()) != "GND":
            continue
        nodes["track:" + str(index)] = ({layer: item.GetEffectiveShape(layer) for layer in layers
                                        if item.IsOnLayer(layer)} if isinstance(item, pcbnew.PCB_VIA)
                                       else {item.GetLayer(): item.GetEffectiveShape()})
    zones = list(board.Zones())
    require(len(zones) == 2 and {z.GetLayer() for z in zones} == set(layers), "requires two single-layer ground zones")
    for zone in zones:
        layer = zone.GetLayer()
        require(str(zone.GetNetname()) == "GND" and zone.IsFilled() and zone.HasFilledPolysForLayer(layer),
                "ground graph requires native filled polygons")
        polys = zone.GetFilledPolysList(layer)
        require(0 < polys.OutlineCount() <= 64, "ground polygon count outside bound")
        for index in range(polys.OutlineCount()):
            key = "zone:" + str(layer) + ":" + str(index)
            nodes[key] = {layer: polys.UnitSet(index)}
            if layer == pcbnew.B_Cu:
                back_nodes.add(key)
    require(len(nodes) <= GROUND_GRAPH_LIMIT, "ground graph exceeds bounded size")
    links = ground_links(nodes, pcbnew)
    return {"nodes": nodes, "pads": pads, "backNodes": back_nodes, "links": links,
            "components": connected_components(nodes, links)}


def ground_reachability(board, pcbnew):
    try:
        scene = ground_scene(board, pcbnew)
        anchor = next(group for group in scene["components"] if "J1.2" in group)
        return {"available": True, "anchor": "J1.2", "method": "native-effective-shape-polygon-components-v1",
                "reachedPads": sorted(set(scene["pads"]) & anchor),
                "unreachedPads": sorted(set(scene["pads"]) - anchor),
                "padComponents": sorted([sorted(set(scene["pads"]) & group) for group in scene["components"]
                                         if set(scene["pads"]) & group])}
    except Exception as exc:
        return {"available": False, "anchor": "J1.2", "unreachedPads": None, "reason": str(exc)[:300]}


def checked_ground_edges(board, pcbnew):
    # This adapter owns exactly one rectangular outline. Reject unexpected
    # edges/cutouts instead of applying a rectangle bbox to an arbitrary board.
    expected = {frozenset(pair) for pair in (((0, 0), (24000000, 0)), ((24000000, 0), (24000000, 18000000)),
                                            ((24000000, 18000000), (0, 18000000)), ((0, 18000000), (0, 0)))}
    edges = [item for item in board.GetDrawings() if item.GetLayer() == pcbnew.Edge_Cuts]
    require(len(edges) == 4 and all(item.GetShape() == pcbnew.SHAPE_T_SEGMENT for item in edges),
            "ground fanout requires exact rectangular board edges")
    require({frozenset((tuple(xy(item.GetStart())), tuple(xy(item.GetEnd())))) for item in edges} == expected,
            "ground fanout board edges changed")
    require(not any(item.GetLayer() == pcbnew.Edge_Cuts for fp in board.GetFootprints() for item in fp.GraphicalItems()),
            "unexpected footprint board cutout")


class GroundClearance:
    """Narrow CopperIndex recipe, fail CLOSED on missing native geometry.

    Other-net effective copper, both directions of hole/copper clearance, all
    hole/hole spacing, pad keepout and exact owned-board edges. Same-net copper
    may connect, but an ordinary drilled via land may not overlap ANY pad.
    No bounding-box pad approximation, endpoint sampling or swallowed errors.
    """
    def __init__(self, board, pcbnew, reservation_net="GND"):
        require(reservation_net in RESERVED_NETS, "unreviewed clearance reservation net")
        checked_ground_edges(board, pcbnew)
        self.pcbnew = pcbnew
        self.layers = (pcbnew.F_Cu, pcbnew.B_Cu)
        self.clearance, self.hole_clearance, self.edge_clearance = 150000, 250000, 500000
        self.width, self.height = 24000000, 18000000
        self.other = {layer: [] for layer in self.layers}
        self.holes, self.pads, self.added_holes = [], [], []
        items = [(pad, True) for fp in board.GetFootprints() for pad in fp.Pads()]
        items += [(item, False) for item in board.GetTracks()]
        require(len(items) <= GROUND_GRAPH_LIMIT, "ground obstacles exceed bounded size")
        for item, is_pad in items:
            own = str(item.GetNetname()) == reservation_net
            is_via = isinstance(item, pcbnew.PCB_VIA)
            drilled = (is_via or (is_pad and (item.GetDrillSize().x > 0 or item.GetDrillSize().y > 0)))
            if drilled:
                hole = item.GetEffectiveHoleShape()
                require(hole is not None, "native hole geometry unavailable")
                self.holes.append((hole, own))
            for layer in self.layers:
                if not item.IsOnLayer(layer):
                    continue
                shape = item.GetEffectiveShape(layer) if is_pad or is_via else item.GetEffectiveShape()
                require(shape is not None, "native copper geometry unavailable")
                if is_pad:
                    self.pads.append(shape)
                if not own:
                    self.other[layer].append(shape)
        if reservation_net in ("SDA", "SCL"):
            # GND guards predate the seeds and their fill/planner behavior stays
            # unchanged. Signals also see retained foreign zone polygons in
            # final inspect, not just the pre-route tracks/vias.
            zones = list(board.Zones())
            require(len(zones) <= 2, reservation_net + " foreign zone count outside bound")
            for zone in zones:
                if str(zone.GetNetname()) == reservation_net:
                    continue
                layer = zone.GetLayer()
                require(layer in self.layers and zone.IsFilled() and zone.HasFilledPolysForLayer(layer),
                        reservation_net + " foreign zone native fill unavailable")
                polys = zone.GetFilledPolysList(layer)
                require(0 < polys.OutlineCount() <= 64, reservation_net + " foreign zone polygon count outside bound")
                self.other[layer].extend(polys.UnitSet(index) for index in range(polys.OutlineCount()))

    def inside_edges(self, shape):
        # Exact for this validated axis-aligned rectangle and an effective
        # shape's extremal bounds. Full stub width and entire via land count.
        box = shape.BBox()
        return (box.GetLeft() >= self.edge_clearance and box.GetTop() >= self.edge_clearance and
                box.GetRight() <= self.width - self.edge_clearance and
                box.GetBottom() <= self.height - self.edge_clearance)

    def stub_obstacle_boxes(self, layer):
        result = []
        for shape, margin in ([(shape, 250000) for shape in self.other[layer]] +
                              [(hole, 350000) for hole, own in self.holes if not own]):
            box = shape.BBox()
            result.append((box.GetLeft() - margin, box.GetTop() - margin,
                           box.GetRight() + margin, box.GetBottom() + margin))
        return result

    def corridor_boxes(self):
        def expanded(shape, margin):
            box = shape.BBox()
            return (box.GetLeft() - margin, box.GetTop() - margin,
                    box.GetRight() + margin, box.GetBottom() + margin)
        # max(copper radius + copper gap, drill radius + hole/copper gap)
        boxes = [expanded(shape, 450000) for shapes in self.other.values() for shape in shapes]
        boxes += [expanded(shape, 300000) for shape in self.pads]
        # Hole versus new drill: .15+.25. Other-net hole versus via land:
        # .30+.25 is stronger. Accepted GND drills still need hole spacing.
        boxes += [expanded(shape, 400000 if own else 550000) for shape, own in self.holes]
        boxes += [expanded(shape, 400000) for shape in self.added_holes]
        return boxes

    def collide(self, left, right, clearance):
        return shapes_collide(self.pcbnew, left, right, clearance)

    def stub_clear(self, stub, layer):
        return (self.inside_edges(stub) and
                not any(self.collide(shape, stub, self.clearance) for shape in self.other[layer]) and
                not any(self.collide(hole, stub, self.hole_clearance) for hole, own in self.holes if not own))

    def reject(self, stub, layer, land, drill):
        if not all(self.inside_edges(shape) for shape in (stub, land, drill)):
            return "board-edge"
        # Stronger than just no drill-in-pad: keep the entire via land clear of
        # pads, including its own LGA source, so no partial via-in-pad shortcut.
        if any(self.collide(pad, land, 0) for pad in self.pads):
            return "via-in-pad"
        for copper_layer in self.layers:
            for shape in self.other[copper_layer]:
                if self.collide(shape, land, self.clearance) or self.collide(shape, drill, self.hole_clearance):
                    return "via-other-copper"
                if copper_layer == layer and self.collide(shape, stub, self.clearance):
                    return "stub-other-copper"
        for hole, own in self.holes:
            if self.collide(hole, drill, self.hole_clearance):
                return "hole-spacing"
            if not own and (self.collide(hole, land, self.hole_clearance) or self.collide(hole, stub, self.hole_clearance)):
                return "other-hole-copper"
        if any(self.collide(hole, drill, self.hole_clearance) for hole in self.added_holes):
            return "hole-spacing"
        return None


def strict_crossings(first, second):
    """Exact proper intersections of closed, straight native polygon chains.

    Coincident edges or intersections at a vertex are deliberately ambiguous:
    fail rather than turn touching/overlapping copper into an extra spoke.
    Fraction avoids rounding two distinct crossings into one native integer.
    """
    require(3 <= len(first) <= 8192 and 3 <= len(second) <= 8192, "thermal contour size outside bound")
    cross = lambda a, b: a[0] * b[1] - a[1] * b[0]
    sub = lambda a, b: (a[0] - b[0], a[1] - b[1])
    result = set()
    for p, q in zip(first, first[1:] + first[:1]):
        r = sub(q, p)
        if r == (0, 0):
            continue
        for u, v in zip(second, second[1:] + second[:1]):
            s, up = sub(v, u), sub(u, p)
            if s == (0, 0):
                continue
            determinant = cross(r, s)
            if not determinant:
                if cross(up, r) == 0:
                    axis = 0 if r[0] else 1
                    require(max(min(p[axis], q[axis]), min(u[axis], v[axis])) >
                            min(max(p[axis], q[axis]), max(u[axis], v[axis])), "ambiguous overlapping thermal boundary")
                continue
            t, z = Fraction(cross(up, s), determinant), Fraction(cross(up, r), determinant)
            if 0 <= t <= 1 and 0 <= z <= 1:
                require(0 < t < 1 and 0 < z < 1, "ambiguous tangent or vertex thermal boundary")
                result.add((Fraction(p[0]) + t * r[0], Fraction(p[1]) + t * r[1]))
    return sorted(result)


def native_chain(chain):
    require(chain.ArcCount() == 0, "thermal contour must contain native tessellated segments")
    points = [tuple(xy(chain.CPoint(index))) for index in range(chain.PointCount())]
    if points and points[0] == points[-1]:
        points.pop()
    return points


def thermal_measurements(scene, pcbnew):
    """Initial geometric count, not a DRC pass or isolated-island waiver.

    Native checker intersects pad expanded by half its 0.2mm thermal gap.
    Count every polygon separately and retain holes; final DRC still checks
    which islands are electrically useful after stitching and final refill.
    """
    result = {}
    front = [shapes[pcbnew.F_Cu] for key, shapes in scene["nodes"].items()
             if key.startswith("zone:") and pcbnew.F_Cu in shapes]
    for endpoint, pad in sorted(scene["pads"].items()):
        boundary = pcbnew.SHAPE_POLY_SET()
        pad.TransformShapeToPolygon(boundary, pcbnew.F_Cu, 100000, pcbnew.FromMM(pcbnew.ARC_LOW_DEF_MM), pcbnew.ERROR_OUTSIDE)
        require(boundary.OutlineCount() == 1 and boundary.HoleCount(0) == 0, "unsupported thermal pad contour")
        contour = native_chain(boundary.COutline(0))
        count = 0
        for poly in front:
            crossings = strict_crossings(contour, native_chain(poly.COutline(0)))
            for hole in range(poly.HoleCount(0)):
                crossings += strict_crossings(contour, native_chain(poly.CHole(0, hole)))
            require(len(set(crossings)) == len(crossings) and len(crossings) % 2 == 0,
                    "ambiguous thermal crossing count")
            count += len(crossings) // 2
        result[endpoint] = {"geometricSpokes": count, "boundary": boundary}
    return result


def crossing_envelope(start, end, contour, width):
    """Conservative finite-width crossing disk, or None for unsafe geometry.

    The intersection interval on a straight contour edge has half-length
    r/abs(sin(angle)). Compute its enclosing integer radius using integer
    square-root/ceil, not float trigonometry. Reject grazing angles and disks
    that can reach any contour vertex or non-crossed edge.
    """
    crossings = line_boundary_crossings(start, end, contour)
    if len(crossings) != 1:
        return None
    point = crossings[0]
    d = (end[0] - start[0], end[1] - start[1])
    length2 = d[0] ** 2 + d[1] ** 2
    if not length2:
        return None
    crossed = []
    for index, (a, b) in enumerate(zip(contour, contour[1:] + contour[:1])):
        e = (b[0] - a[0], b[1] - a[1])
        offset = (point[0] - a[0], point[1] - a[1])
        if offset[0] * e[1] == offset[1] * e[0] and min(a[0], b[0]) <= point[0] <= max(a[0], b[0]) and min(a[1], b[1]) <= point[1] <= max(a[1], b[1]):
            crossed.append((index, e))
    if len(crossed) != 1:
        return None
    edge_index, e = crossed[0]
    edge_length2 = e[0] ** 2 + e[1] ** 2
    determinant = abs(d[0] * e[1] - d[1] * e[0])
    # sin(theta)>=1/4, otherwise credit would be highly grazing/ambiguous.
    if not determinant or 16 * determinant ** 2 < length2 * edge_length2:
        return None
    half_width = (width + 1) // 2 + 1
    squared_numerator = half_width ** 2 * length2 * edge_length2
    root = math.isqrt(squared_numerator)
    if root ** 2 < squared_numerator:
        root += 1
    radius = (root + determinant - 1) // determinant + 2  # covers rounding center <=1nm
    center = (round(point[0]), round(point[1]))
    for index, (a, b) in enumerate(zip(contour, contour[1:] + contour[:1])):
        vx, vy = b[0] - a[0], b[1] - a[1]
        norm = vx * vx + vy * vy
        if not norm:
            continue
        t = max(Fraction(0), min(Fraction(1), Fraction((center[0] - a[0]) * vx + (center[1] - a[1]) * vy, norm)))
        if index == edge_index:
            # Entire envelope must lie on this segment's interior; otherwise
            # an adjacent contour edge could have another finite-width exit.
            if min((center[0] - a[0]) ** 2 + (center[1] - a[1]) ** 2,
                   (center[0] - b[0]) ** 2 + (center[1] - b[1]) ** 2) <= radius ** 2:
                return None
        elif (center[0] - a[0] - t * vx) ** 2 + (center[1] - a[1] - t * vy) ** 2 <= radius ** 2:
            return None
    return center, radius


def manual_spoke_credit(endpoint, pad, boundary, tracks, front_polygons, pcbnew):
    """Conservative credit for distinct manual spokes, never for a via alone.

    Native DRC counts connected tracks whose near end is inside the half-gap
    contour and far end touches the front fill. We additionally require the
    exact pad, anchored front polygon and a separate finite-width crossing.
    """
    accepted, decisions = [], []
    contour = native_chain(boundary.COutline(0))
    pad_shape = pad.GetEffectiveShape(pcbnew.F_Cu)
    for track in tracks:
        reason = None
        start, end = track["start"], track["at"]
        if track["net"] != "GND" or track["layer"] != pcbnew.F_Cu:
            reason = "wrong-net-or-layer"
        elif not boundary.Contains(start):
            if boundary.Contains(end):
                start, end = end, start
            else:
                reason = "no-pad-contour-endpoint"
        if reason is None and not pad_shape.Collide(start, 0):
            reason = "not-directly-connected-to-pad"
        if reason is None and boundary.Contains(end):
            reason = "endpoint-inside-pad-contour"
        if reason is None and not any(poly.Contains(end) for poly in front_polygons):
            reason = "endpoint-not-in-anchored-front-fill"
        envelope = crossing_envelope(tuple(xy(start)), tuple(xy(end)), contour, track["width"]) if reason is None else None
        if reason is None and envelope is None:
            reason = "ambiguous-manual-crossing"
        crossing_shape = None
        if reason is None:
            point = pcbnew.VECTOR2I(*envelope[0])
            crossing_shape = pcbnew.SHAPE_CIRCLE(point, envelope[1])
            if any(poly.Collide(crossing_shape, 0) for poly in front_polygons):
                reason = "overlaps-existing-geometric-spoke"
            elif any(shapes_collide(pcbnew, previous, crossing_shape, 0) for previous in accepted):
                reason = "duplicate-or-overlapping-manual-spoke"
        if reason is None:
            accepted.append(crossing_shape)
        decisions.append({"track": track["id"], "startNm": xy(start), "endNm": xy(end),
                          "credited": reason is None, "reason": reason})
    return len(accepted), decisions


def plan_thermal_spokes(scene, nodes, guard, pcbnew, manual_tracks=(), diagnostics=None):
    measurements = thermal_measurements(scene, pcbnew)
    components = connected_components(nodes, ground_links(nodes, pcbnew))
    anchor = next(group for group in components if "J1.2" in group)
    targets = [nodes[key][pcbnew.F_Cu] for key in sorted(anchor)
               if key.startswith("zone:") and pcbnew.F_Cu in nodes[key]]
    planned = []
    for endpoint, measurement in sorted(measurements.items()):
        count = measurement["geometricSpokes"]
        require(count > 0, "GND pad has no measured thermal spoke: " + endpoint)
        manual_count, manual_decisions = manual_spoke_credit(endpoint, scene["pads"][endpoint],
            measurement["boundary"], manual_tracks, targets, pcbnew) if manual_tracks else (0, [])
        diagnostic = {"pad": endpoint, "geometricSpokes": count, "manualSpokes": manual_count,
                      "requiredSpokes": 2, "manualTracks": manual_decisions, "supplementalRejects": {}}
        if diagnostics is not None:
            diagnostics.append(diagnostic)
        if count + manual_count >= 2:
            diagnostic["supplementalRequired"] = False
            continue
        diagnostic["supplementalRequired"] = True
        start = scene["pads"][endpoint].GetPosition()
        original = [shape[pcbnew.F_Cu] for key, shape in scene["nodes"].items()
                    if key.startswith("zone:") and pcbnew.F_Cu in shape]
        chosen = None
        def rejected(reason):
            counts = diagnostic["supplementalRejects"]
            counts[reason] = counts.get(reason, 0) + 1
        for point in ground_candidates(xy(start)):
            at = pcbnew.VECTOR2I(*point)
            # Beyond FULL thermal gap and inside useful initial fill. Do not
            # count a trace along an existing thermal as a second physical spoke.
            if measurement["boundary"].Collide(at, 100001):
                rejected("inside-thermal-gap")
                continue
            if not any(poly.Contains(at) and not poly.CollideEdge(at, None, 100001) for poly in targets):
                rejected("not-inside-anchored-front-fill")
                continue
            stub = pcbnew.SHAPE_SEGMENT(start, at, 200000)
            if not guard.stub_clear(stub, pcbnew.F_Cu):
                rejected("stub-clearance")
                continue
            # Find where the centerline exits the half-gap contour. This is
            # spoke distinctness only; clearance uses the whole native stub.
            p, q = tuple(xy(start)), point
            # A native SEG/polygon intersection returns a list only in C++; use
            # exact rational line intersections against each contour segment.
            boundary = native_chain(measurement["boundary"].COutline(0))
            envelope = crossing_envelope(p, q, boundary, 200000)
            if envelope is None:
                rejected("ambiguous-crossing")
                continue
            exit_point = pcbnew.VECTOR2I(*envelope[0])
            crossing_land = pcbnew.SHAPE_CIRCLE(exit_point, envelope[1])
            if any(poly.Collide(crossing_land, 0) for poly in original):
                rejected("overlaps-geometric-spoke")
                continue
            if any(old["endpoint"] == endpoint and shapes_collide(pcbnew, old["stub"], crossing_land, 0) for old in planned):
                rejected("overlaps-supplemental-spoke")
                continue
            chosen = {"endpoint": endpoint, "start": start, "at": at, "stub": stub,
                      "geometricSpokesBefore": count}
            break
        require(chosen is not None, "no legal supplemental thermal spoke for " + endpoint)
        diagnostic["supplementalEndNm"] = xy(chosen["at"])
        nodes["thermal-stub:" + endpoint] = {pcbnew.F_Cu: chosen["stub"]}
        planned.append(chosen)
    return planned


def line_boundary_crossings(start, end, contour):
    # Exact open segment intersections; ambiguous vertex/collinear cases reject
    # this candidate (a different member of the finite candidate set may work).
    cross = lambda a, b: a[0] * b[1] - a[1] * b[0]
    sub = lambda a, b: (a[0] - b[0], a[1] - b[1])
    direction = sub(end, start)
    result = set()
    for p, q in zip(contour, contour[1:] + contour[:1]):
        edge, offset = sub(q, p), sub(p, start)
        determinant = cross(direction, edge)
        if determinant == 0:
            if cross(offset, direction) == 0:
                return []
            continue
        t, u = Fraction(cross(offset, edge), determinant), Fraction(cross(offset, direction), determinant)
        if 0 <= t <= 1 and 0 <= u <= 1:
            if t in (0, 1) or u in (0, 1):
                return []
            result.add((Fraction(start[0]) + t * direction[0], Fraction(start[1]) + t * direction[1]))
    return sorted(result)


def stitch_ground(board, pcbnew, diagnostic_writer=lambda value: None):
    scene = ground_scene(board, pcbnew)
    guard = GroundClearance(board, pcbnew)
    nodes, pads = scene["nodes"], scene["pads"]
    components = scene["components"]
    before = sorted(sorted(set(pads) & group) for group in components if set(pads) & group)
    planned, attempted = [], 0
    # Each iteration must join at least one previously unreachable endpoint.
    # All accepted shapes update the virtual graph and drilled-hole obstacles
    # before considering the next candidate. Mutate the board only when the
    # complete finite plan is legal; never leave a partial successful fanout.
    for _ in range(len(NETS["GND"]) - 1):
        anchor = next(group for group in components if "J1.2" in group)
        pending = sorted(set(pads) - anchor)
        if not pending:
            break
        targets = [nodes[key][pcbnew.B_Cu] for key in sorted(scene["backNodes"] & anchor)]
        require(targets, "J1.2 has no connected back-plane polygon")
        group = next(group for group in components if pending[0] in group)
        endpoints = sorted(set(pads) & group)
        chosen = None
        rejects = {}
        for endpoint in endpoints:
            pad = pads[endpoint]
            start = pad.GetPosition()
            radial = ground_candidates(xy(start))
            cells = corridor_candidates(xy(start), guard.corridor_boxes())
            radial_set = set(radial)
            candidates = radial + [point for point in cells if point not in radial_set]
            for point in candidates:
                attempted += 1
                at = pcbnew.VECTOR2I(*point)
                stub = pcbnew.SHAPE_SEGMENT(start, at, 150000)
                land = pcbnew.SHAPE_CIRCLE(at, 300000)
                drill = pcbnew.SHAPE_CIRCLE(at, 150000)
                reason = guard.reject(stub, pcbnew.F_Cu, land, drill)
                if reason is None and any(shapes_collide(pcbnew, old["land"], land, 0) for old in planned):
                    reason = "previous-via-land"
                # Entire land must lie inside a specific ANCHORED back polygon,
                # including clearance from its holes/edges, not a sampled point
                # or any disconnected polygon in the back ZONE.
                if reason is None and not any(poly.Contains(at) and not poly.CollideEdge(at, None, 300001) for poly in targets):
                    reason = "not-inside-anchored-back-plane"
                if reason is not None:
                    rejects[reason] = rejects.get(reason, 0) + 1
                    continue
                chosen = {"endpoint": endpoint, "start": start, "at": at, "stub": stub, "land": land, "drill": drill}
                break
            if chosen is not None:
                break
        require(chosen is not None, "no legal GND fanout for " + ",".join(endpoints) + ": " + json.dumps(rejects, sort_keys=True))
        index = len(planned)
        nodes["stitch-stub:" + str(index)] = {pcbnew.F_Cu: chosen["stub"]}
        nodes["stitch-via:" + str(index)] = {layer: chosen["land"] for layer in (pcbnew.F_Cu, pcbnew.B_Cu)}
        components = connected_components(nodes, ground_links(nodes, pcbnew))
        updated = next(group for group in components if "J1.2" in group)
        require(set(endpoints) <= updated and anchor <= updated, "ground candidate did not connect measured component")
        guard.added_holes.append(chosen["drill"])
        planned.append(chosen)
    anchor = next(group for group in components if "J1.2" in group)
    require(set(pads) <= anchor, "bounded GND plan leaves unreachable pads")
    manual_tracks = [{"id": "stitch-stub:" + str(index), "net": "GND", "layer": pcbnew.F_Cu,
                      "start": choice["start"], "at": choice["at"], "width": 150000}
                     for index, choice in enumerate(planned)]
    for index, track in enumerate(board.GetTracks()):
        if not isinstance(track, pcbnew.PCB_VIA) and str(track.GetNetname()) == "GND":
            manual_tracks.append({"id": "existing-track:" + str(index), "net": "GND", "layer": track.GetLayer(),
                                  "start": track.GetStart(), "at": track.GetEnd(), "width": track.GetWidth()})
    require(len(manual_tracks) <= GROUND_GRAPH_LIMIT, "manual thermal track count exceeds bound")
    thermal_diagnostics = []
    diagnostic = {"version": 1, "anchor": "J1.2", "status": "planning", "boardMutated": False,
                  "stitches": [{"pad": p["endpoint"], "startNm": xy(p["start"]), "viaNm": xy(p["at"])} for p in planned],
                  "thermals": thermal_diagnostics}
    try:
        thermal_spokes = plan_thermal_spokes(scene, nodes, guard, pcbnew, manual_tracks, thermal_diagnostics)
    except NativeError as exc:
        diagnostic.update(status="rejected", reason=str(exc)[:300])
        diagnostic_writer(diagnostic)
        raise
    diagnostic["status"] = "planned"
    diagnostic_writer(diagnostic)
    net = board.FindNet("GND")
    for choice in planned:
        via = pcbnew.PCB_VIA(board)
        via.SetViaType(pcbnew.VIATYPE_THROUGH)
        via.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
        via.SetPosition(choice["at"])
        via.SetWidth(600000)
        via.SetDrill(300000)
        via.SetNet(net)
        track = pcbnew.PCB_TRACK(board)
        track.SetStart(choice["start"])
        track.SetEnd(choice["at"])
        track.SetWidth(150000)
        track.SetLayer(pcbnew.F_Cu)
        track.SetNet(net)
        board.Add(via)
        board.Add(track)
    for choice in thermal_spokes:
        track = pcbnew.PCB_TRACK(board)
        track.SetStart(choice["start"])
        track.SetEnd(choice["at"])
        track.SetWidth(200000)
        track.SetLayer(pcbnew.F_Cu)
        track.SetNet(net)
        board.Add(track)
    return {"version": 1, "anchor": "J1.2", "method": "bounded-native-shape-fanout-v1",
            "thermalSpokes": [{"pad": p["endpoint"], "startNm": xy(p["start"]), "endNm": xy(p["at"]),
                               "trackWidthNm": 200000, "geometricSpokesBefore": p["geometricSpokesBefore"],
                               "requiredSpokes": 2} for p in thermal_spokes],
            "beforePadComponents": before, "candidatesTested": attempted,
            "radialCandidateLimitPerPad": len(GROUND_RADII_NM) * GROUND_DIRECTIONS,
            "corridorCandidateLimitPerPad": 256,
            "candidateLimitPerPad": len(GROUND_RADII_NM) * GROUND_DIRECTIONS + 256,
            "stitches": [{"pad": p["endpoint"], "startNm": xy(p["start"]), "viaNm": xy(p["at"]),
                          "trackWidthNm": 150000, "viaDiameterNm": 600000, "viaDrillNm": 300000} for p in planned],
            "connectivityVerdict": "requires-fresh-saved-board-inspection"}


def fill_ground(board, pcbnew, journal=lambda label: None, diagnostic_writer=lambda value: None):
    require(not list(board.Zones()), "unexpected preexisting zones")
    net = board.FindNet("GND")
    require(net is not None and net.GetNetCode() > 0, "canonical ground net missing")
    zones = []
    for layer in (pcbnew.F_Cu, pcbnew.B_Cu):
        zone = pcbnew.ZONE(board)
        zone.SetLayer(layer)
        zone.SetNet(net)
        zone.SetLocalClearance(pcbnew.FromMM(0.15))
        zone.SetMinThickness(pcbnew.FromMM(0.2))
        zone.SetPadConnection(pcbnew.ZONE_CONNECTION_THERMAL)
        zone.SetThermalReliefGap(pcbnew.FromMM(0.2))
        zone.SetThermalReliefSpokeWidth(pcbnew.FromMM(0.2))
        outline = zone.Outline()
        outline.NewOutline()
        for x, y in ((0.65, 0.65), (23.35, 0.65), (23.35, 17.35), (0.65, 17.35)):
            outline.Append(pcbnew.FromMM(x), pcbnew.FromMM(y))
        board.Add(zone)
        zones.append(zone)
    journal("zones-created")
    journal("before-connectivity-build")
    board.BuildConnectivity()
    journal("after-connectivity-build")
    filler = pcbnew.ZONE_FILLER(board)
    journal("before-zone-fill")
    require(filler.Fill(zones) is not False, "native zone fill failed")
    journal("after-zone-fill")
    require(all(zone.IsFilled() and zone.GetFilledArea() > 0 for zone in zones), "native zones not measurably filled")
    journal("ground-measured")
    fanout = stitch_ground(board, pcbnew, diagnostic_writer)
    journal("ground-stitched")
    # One final refill after the complete bounded plan, never a fill/retry loop.
    require(board.BuildConnectivity() is not False, "post-stitch connectivity build failed")
    journal("before-final-fill")
    require(filler.Fill(zones) is not False, "final native zone fill failed")
    journal("after-final-fill")
    require(all(zone.IsFilled() and zone.GetFilledArea() > 0 for zone in zones), "final ground fill missing")
    return fanout


def connectivity(board):
    # Failure is represented as unavailable, never fabricated zero or an electrical pass.
    try:
        require(board.BuildConnectivity() is not False, "connectivity build failed")
        conn = board.GetConnectivity()
        conn.RecalculateRatsnest()
        count = conn.GetUnconnectedCount(False)
        require(type(count) is int and count >= 0, "invalid connectivity count")
        return {"available": True, "unrouted": count, "method": "pcbnew.GetUnconnectedCount(false)"}
    except Exception as exc:
        return {"available": False, "unrouted": None, "reason": str(exc)[:300]}


def prepared_inputs(input_path, output, ses):
    baseline = read_json(output / "prepared-evidence.json")
    board_path = safe_file(output / "board.kicad_pcb", MAX_ASSET)
    dsn_path = safe_file(output / "board.dsn", MAX_ASSET)
    require(baseline.get("version") == VERSION and baseline.get("stage") == "prepared", "invalid prepared evidence")
    require(baseline.get("inputSha256") == digest(input_path) and baseline.get("boardSha256") == digest(board_path)
            and baseline.get("dsnSha256") == digest(dsn_path), "prepared artifact hash mismatch")
    require(baseline.get("projectSha256") == project_hash(board_path), "prepared project hash mismatch")
    require(baseline.get("tableSha256") == checked_footprint_table(read_json(input_path), output),
            "prepared footprint table hash mismatch")
    ses = safe_file(ses, MAX_ASSET, [output])
    return baseline, board_path, ses


def import_session(data, input_path, output, ses, pcbnew):
    for name in ("imported-board.kicad_pcb", "import-evidence.json"):
        require(not no_links(output / name).exists(), "import output already exists")
    stage(output, "import-start")
    baseline, board_path, ses = prepared_inputs(input_path, output, ses)
    stage(output, "prepared-verified")
    board = pcbnew.LoadBoard(str(board_path))
    stage(output, "board-loaded")
    assert_identity(baseline["identity"], identity(board))
    assert_reserved(baseline["reservedCopper"], board, pcbnew)
    stage(output, "before-import")
    require(pcbnew.ImportSpecctraSES(board, str(ses)), "native SES import failed")
    stage(output, "after-import")
    imported = output / "imported-board.kicad_pcb"
    project_sha256 = checked_save(board, imported, pcbnew)
    stage(output, "imported-saved")
    # No more pcbnew access after ImportSpecctraSES + SaveBoard in this process.
    # The parent must require a NORMAL ZERO EXIT, not merely this evidence file.
    evidence = {"version": VERSION, "stage": "imported", "inputSha256": digest(input_path),
                "preparedBoardSha256": baseline["boardSha256"], "dsnSha256": baseline["dsnSha256"],
                "sesSha256": digest(ses), "importedBoardSha256": digest(imported),
                "preparedProjectSha256": baseline["projectSha256"], "importedProjectSha256": project_sha256,
                "tableSha256": baseline["tableSha256"]}
    write_json(output / "import-evidence.json", evidence)
    stage(output, "import-evidence-written")
    return {"version": VERSION, "stage": "imported", "board": imported.name, "evidence": "import-evidence.json"}


def imported_inputs(input_path, output, ses):
    baseline, _, ses = prepared_inputs(input_path, output, ses)
    imported = safe_file(output / "imported-board.kicad_pcb", MAX_ASSET)
    imported_evidence = read_json(output / "import-evidence.json")
    require(imported_evidence == {"version": VERSION, "stage": "imported", "inputSha256": digest(input_path),
            "preparedBoardSha256": baseline["boardSha256"], "dsnSha256": baseline["dsnSha256"],
            "sesSha256": digest(ses), "importedBoardSha256": digest(imported),
            "preparedProjectSha256": baseline["projectSha256"], "importedProjectSha256": project_hash(imported),
            "tableSha256": baseline["tableSha256"]},
            "import artifact hash mismatch")
    return baseline, imported_evidence, imported, ses


def finish(data, input_path, output, ses, pcbnew):
    for name in ("final-board.kicad_pcb", "fill-evidence.json", "native-evidence.json", "ground-plan-diagnostic.json"):
        require(not no_links(output / name).exists(), "finish output already exists")
    stage(output, "finish-start")
    baseline, imported_evidence, imported, ses = imported_inputs(input_path, output, ses)
    stage(output, "prepared-verified")
    routed = pcbnew.LoadBoard(str(imported))
    stage(output, "imported-reloaded")
    assert_identity(baseline["identity"], identity(routed))
    assert_reserved(baseline["reservedCopper"], routed, pcbnew)
    check_reserved_clearance(routed, pcbnew)
    stage(output, "imported-identity-verified")
    check_topology(routed)
    fanout = fill_ground(routed, pcbnew, lambda label: stage(output, label),
                         lambda value: write_plan_diagnostic(output, value))
    assert_identity(baseline["identity"], identity(routed))
    assert_reserved(baseline["reservedCopper"], routed, pcbnew)
    stage(output, "filled")
    final_path = output / "final-board.kicad_pcb"
    project_sha256 = checked_save(routed, final_path, pcbnew)
    stage(output, "final-saved")
    # Do not reload or inspect pcbnew containers after mutative zone fill/save.
    fill_evidence = dict(imported_evidence, stage="filled", boardSha256=digest(final_path),
                         projectSha256=project_sha256, groundFanout=fanout)
    write_json(output / "fill-evidence.json", fill_evidence)
    stage(output, "fill-evidence-written")
    return {"version": VERSION, "stage": "filled", "board": final_path.name, "evidence": "fill-evidence.json"}


def inspect(data, input_path, output, ses, pcbnew):
    require(not no_links(output / "native-evidence.json").exists(), "inspect output already exists")
    stage(output, "inspect-start")
    baseline, imported_evidence, _, ses = imported_inputs(input_path, output, ses)
    final_path = safe_file(output / "final-board.kicad_pcb", MAX_ASSET)
    fill_evidence = read_json(output / "fill-evidence.json")
    require(fill_evidence == dict(imported_evidence, stage="filled", boardSha256=digest(final_path),
                                  projectSha256=fill_evidence.get("projectSha256"),
                                  groundFanout=fill_evidence.get("groundFanout")), "fill artifact hash mismatch")
    require(fill_evidence.get("projectSha256") == project_hash(final_path), "final project hash mismatch")
    require(isinstance(fill_evidence.get("groundFanout"), dict), "ground fanout evidence missing")
    saved = pcbnew.LoadBoard(str(final_path))
    stage(output, "final-reloaded")
    final_identity = identity(saved)
    assert_identity(baseline["identity"], final_identity)
    assert_reserved(baseline["reservedCopper"], saved, pcbnew)
    check_reserved_clearance(saved, pcbnew)
    stage(output, "final-identity-verified")
    check_topology(saved)
    zones = list(saved.Zones())
    require(len(zones) == 2 and all(z.IsFilled() and z.GetFilledArea() > 0 for z in zones), "saved ground fill missing")
    tracks = list(saved.GetTracks())
    evidence = {"version": VERSION, "stage": "finished", "inputSha256": digest(input_path),
                "boardSha256": digest(final_path), "projectSha256": fill_evidence["projectSha256"],
                "preparedProjectSha256": baseline["projectSha256"], "preparedBoardSha256": baseline["boardSha256"],
                "tableSha256": baseline["tableSha256"],
                "dsnSha256": baseline["dsnSha256"], "sesSha256": digest(ses), "routeAttempts": 1,
                "identityPreserved": True, "identity": final_identity,
                "reservedCopperPreserved": True, "reservedCopper": baseline["reservedCopper"],
                "decouplers": close_decouplers(saved, pcbnew), "connectivity": connectivity(saved),
                "groundConnectivity": ground_reachability(saved, pcbnew), "groundFanout": fill_evidence["groundFanout"],
                "zones": [{"net": str(z.GetNetname()), "layer": int(z.GetLayer()),
                           "filled": bool(z.IsFilled()), "filledAreaNative": float(z.GetFilledArea())} for z in zones],
                "trackSegments": sum(not isinstance(t, pcbnew.PCB_VIA) for t in tracks),
                "vias": sum(isinstance(t, pcbnew.PCB_VIA) for t in tracks),
                "drc": {"available": False, "errors": None, "warnings": None}}
    write_json(output / "native-evidence.json", evidence)
    stage(output, "evidence-written")
    return {"version": VERSION, "stage": "finished", "board": final_path.name, "evidence": "native-evidence.json"}


def drc_api(data, input_path, output, pcbnew):
    """Diagnostic only: actual KiCad engine, text output, no CLI-pass substitution."""
    board_path = safe_file(output / "final-board.kicad_pcb", MAX_ASSET)
    project = safe_file(output / "final-board.kicad_pro", MAX_JSON)
    report = no_links(output / "drc-api.txt")
    evidence_path = no_links(output / "drc-api-evidence.json")
    require(not report.exists() and not evidence_path.exists(), "DRC API diagnostic output already exists")
    rules = no_links(output / "final-board.kicad_dru")
    sources = [board_path, project, input_path]
    if rules.exists():
        sources.append(safe_file(rules, MAX_JSON))
    before = {p.name: digest(p) for p in sources}
    require(pcbnew.Version() == "10.0.1", "DRC diagnostic engine version mismatch")
    board = pcbnew.LoadBoard(str(board_path))
    check_topology(board)
    require(pcbnew.WriteDRCReport(board, str(report), pcbnew.EDA_UNITS_MM, True),
            "native WriteDRCReport failed")
    text = safe_file(report, MAX_JSON).read_text()
    # Completeness only here. A separately reviewed parser must classify the native
    # findings; successful report production is never zero-error evidence.
    sections = (r"\*\* Found (\d+) DRC violations \*\*", r"\*\* Found (\d+) unconnected pads \*\*",
                r"\*\* Found (\d+) Footprint errors \*\*")
    counts = []
    for pattern in sections:
        matches = re.findall(pattern, text)
        require(len(matches) == 1, "incomplete or ambiguous native DRC report sections")
        counts.append(int(matches[0]))
    require(text.startswith("** Drc report for ") and text.rstrip().endswith("** End of Report **"),
            "incomplete native DRC report framing")
    after = {p.name: digest(p) for p in sources}
    require(before == after, "DRC API diagnostic mutated persisted input")
    evidence = {"version": VERSION, "stage": "drc-api-diagnostic", "engine": "KiCad DRC_ENGINE",
                "api": "pcbnew.WriteDRCReport", "engineVersion": pcbnew.Version(),
                "format": "native-text", "reportAllTrackErrors": True, "schematicParity": "not-run",
                "cliDrcStatus": "not-established", "sourceSha256": before, "reportSha256": digest(report),
                "persistedInputsUnchanged": True,
                "sectionCounts": {"violations": counts[0], "unconnected": counts[1], "footprintErrors": counts[2]}}
    write_json(evidence_path, evidence)
    return {"version": VERSION, "stage": "drc-api-diagnostic", "report": report.name, "evidence": evidence_path.name}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "import", "finish", "inspect", "drc-api"))
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--ses")
    args = parser.parse_args(argv)
    output = no_links(args.output_dir)
    require(output.is_dir(), "owned output directory must already exist")
    input_path = safe_file(args.input, MAX_JSON, [output])
    require((args.command in ("import", "finish", "inspect")) == bool(args.ses),
            "--ses required only for import, finish and inspect")
    data = validate_input(read_json(input_path))
    # This is the only native import. The orchestrator must enforce process containment.
    try:
        import pcbnew
        if args.command in ("prepare", "drc-api"):
            operation = prepare if args.command == "prepare" else drc_api
            result = operation(data, input_path, output, pcbnew)
        else:
            operation = {"import": import_session, "finish": finish, "inspect": inspect}[args.command]
            result = operation(data, input_path, output, no_links(args.ses), pcbnew)
    except Exception as exc:
        # Private, bounded diagnostic. Native/system exception strings can contain
        # paths or runtime internals; retain only our fixed contract error messages.
        error = {"version": VERSION, "stage": args.command, "category": type(exc).__name__,
                 "message": str(exc)[:300] if isinstance(exc, NativeError) else "Native API operation failed"}
        tb = exc.__traceback__
        while tb:
            if tb.tb_frame.f_code.co_filename == __file__:
                error["adapterLine"] = tb.tb_lineno
                error["operation"] = tb.tb_frame.f_code.co_name
            tb = tb.tb_next
        if isinstance(exc, AttributeError):
            match = re.search(r"has no attribute '([A-Za-z_][A-Za-z_0-9]{0,63})'", str(exc))
            if match:
                error["missingAttribute"] = match.group(1)
        try:
            write_json(output / "native-error.json", error)
        except Exception:
            pass  # Diagnostic write cannot replace the original failure or mask exit.
        raise
    print(json.dumps(result, sort_keys=True, allow_nan=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(json.dumps({"version": VERSION, "error": str(exc)[:1000]}), file=sys.stderr)
        sys.exit(1)
