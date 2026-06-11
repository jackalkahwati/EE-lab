"""Feature-building helpers for the Onshape Part Studio feature API.

Builds sketch and extrude features as BTM JSON. Coordinates in the sketch
entities are meters (Onshape internal SI); depths/offsets are passed in mm
as expression strings.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional
from urllib.parse import quote

from onshape_client import Client


def line(eid: str, x1: float, y1: float, x2: float, y2: float) -> Dict[str, Any]:
    return {
        "btType": "BTMSketchCurveSegment-155",
        "entityId": eid,
        "startPointId": eid + ".start",
        "endPointId": eid + ".end",
        "startParam": 0.0,
        "endParam": 1.0,
        "geometry": {
            "btType": "BTCurveGeometryLine-117",
            "pntX": x1, "pntY": y1, "pntZ": 0.0,
            "dirX": x2 - x1, "dirY": y2 - y1, "dirZ": 0.0,
        },
    }


def rect(prefix: str, x1: float, y1: float, x2: float, y2: float) -> List[Dict[str, Any]]:
    return [
        line(prefix + ".b", x1, y1, x2, y1),
        line(prefix + ".r", x2, y1, x2, y2),
        line(prefix + ".t", x2, y2, x1, y2),
        line(prefix + ".l", x1, y2, x1, y1),
    ]


def circle(eid: str, cx: float, cy: float, radius: float) -> Dict[str, Any]:
    return {
        "btType": "BTMSketchCurve-4",
        "entityId": eid,
        "centerId": eid + ".center",
        "geometry": {
            "btType": "BTCurveGeometryCircle-115",
            "radius": radius,
            "xCenter": cx, "yCenter": cy,
            "xDir": 1.0, "yDir": 0.0,
            "clockwise": False,
        },
    }


class FeatureBuilder:
    def __init__(self, client: Client, did: str, wid: str, eid: str) -> None:
        self.c = client
        self.did, self.wid, self.eid = did, wid, eid
        self._base = "/api/v6/partstudios/d/{}/w/{}/e/{}".format(did, wid, eid)

    # -- introspection -------------------------------------------------------

    def get_features(self) -> Dict[str, Any]:
        return self.c._request("GET", self._base + "/features")

    def plane_param(self, sketch_name: str) -> Dict[str, Any]:
        """Clone the sketchPlane parameter from an existing sketch by name
        (last match wins so re-created sketches resolve correctly)."""
        found = None
        for f in self.get_features()["features"]:
            if f.get("name") == sketch_name and f.get("btType") == "BTMSketch-151":
                for p in f.get("parameters", []):
                    if p.get("parameterId") == "sketchPlane":
                        found = p
        if not found:
            raise RuntimeError("no sketch named {!r} to clone plane from".format(sketch_name))
        return found

    def feature_states(self) -> Dict[str, str]:
        data = self.get_features()
        out = {}
        for fid, st in (data.get("featureStates") or {}).items():
            out[fid] = st.get("featureStatus", "?")
        return out

    # -- creation ------------------------------------------------------------

    def _post(self, feature: Dict[str, Any]) -> Dict[str, Any]:
        resp = self.c._request("POST", self._base + "/features",
                               json={"feature": feature})
        feat = resp.get("feature") or {}
        state = (resp.get("featureState") or {}).get("featureStatus", "?")
        if state not in ("OK", "?"):
            raise RuntimeError("feature {!r} state {}".format(
                feature.get("name"), state))
        return feat

    def add_sketch(self, name: str, plane_param: Dict[str, Any],
                   entities: List[Dict[str, Any]]) -> str:
        feat = self._post({
            "btType": "BTMSketch-151",
            "featureType": "newSketch",
            "name": name,
            "parameters": [plane_param],
            "entities": entities,
            "constraints": [],
        })
        return feat["featureId"]

    def add_extrude(self, name: str, sketch_fid: str, depth_mm: float,
                    offset_mm: Optional[float] = None,
                    offset_opposite: bool = False,
                    opposite: bool = False,
                    symmetric: bool = False) -> str:
        params: List[Dict[str, Any]] = [
            {"btType": "BTMParameterEnum-145", "parameterId": "bodyType",
             "value": "SOLID", "enumName": "ExtendedToolBodyType"},
            {"btType": "BTMParameterEnum-145", "parameterId": "operationType",
             "value": "NEW", "enumName": "NewBodyOperationType"},
            {"btType": "BTMParameterQueryList-148", "parameterId": "entities",
             "queries": [{"btType": "BTMIndividualSketchRegionQuery-140",
                          "featureId": sketch_fid}]},
            {"btType": "BTMParameterEnum-145", "parameterId": "endBound",
             "value": "BLIND", "enumName": "BoundingType"},
            {"btType": "BTMParameterQuantity-147", "parameterId": "depth",
             "expression": "{} mm".format(depth_mm)},
            {"btType": "BTMParameterBoolean-144", "parameterId": "oppositeDirection",
             "value": opposite},
        ]
        if symmetric:
            params.append({"btType": "BTMParameterBoolean-144",
                           "parameterId": "symmetric", "value": True})
        if offset_mm is not None:
            params += [
                {"btType": "BTMParameterBoolean-144",
                 "parameterId": "startOffset", "value": True},
                {"btType": "BTMParameterEnum-145",
                 "parameterId": "startOffsetBound", "value": "BLIND",
                 "enumName": "StartOffsetType"},
                {"btType": "BTMParameterQuantity-147",
                 "parameterId": "startOffsetDistance",
                 "expression": "{} mm".format(abs(offset_mm))},
                {"btType": "BTMParameterBoolean-144",
                 "parameterId": "startOffsetOppositeDirection",
                 "value": offset_opposite},
            ]
        feat = self._post({
            "btType": "BTMFeature-134",
            "featureType": "extrude",
            "name": name,
            "parameters": params,
        })
        return feat["featureId"]

    def delete_feature(self, fid: str) -> None:
        self.c._request("DELETE", self._base + "/features/featureid/{}".format(fid))

    # -- parts ---------------------------------------------------------------

    def parts(self) -> Dict[str, str]:
        """name -> partId for all parts."""
        return {p["partId"]: p["name"]
                for p in self.c.list_parts(self.did, self.wid, self.eid)}

    def bbox(self, part_id: str) -> Dict[str, float]:
        bb = self.c._request(
            "GET", "/api/v6/parts/d/{}/w/{}/e/{}/partid/{}/boundingboxes".format(
                self.did, self.wid, self.eid, quote(part_id, safe="")))
        return {k: bb[k] * 1000.0 for k in
                ("lowX", "highX", "lowY", "highY", "lowZ", "highZ")}

    def all_bboxes(self) -> Dict[str, Dict[str, float]]:
        """All solid bodies' name -> bbox(mm) in ONE FeatureScript eval call."""
        script = """
function(context is Context, queries is map)
{
    var out = [];
    for (var body in evaluateQuery(context, qBodyType(qEverything(EntityType.BODY), BodyType.SOLID)))
    {
        try
        {
            var bx = evBox3d(context, {"topology": body});
            var nm = getProperty(context, {"entity": body, "propertyType": PropertyType.NAME});
            out = append(out, {
                "n": nm,
                "lx": bx.minCorner[0] / millimeter, "hx": bx.maxCorner[0] / millimeter,
                "ly": bx.minCorner[1] / millimeter, "hy": bx.maxCorner[1] / millimeter,
                "lz": bx.minCorner[2] / millimeter, "hz": bx.maxCorner[2] / millimeter});
        }
        catch (e) {}
    }
    return out;
}
"""
        resp = self.c._request("POST", self._base + "/featurescript",
                               json={"script": script, "queries": {}})

        def decode(v):
            if isinstance(v, dict):
                if "message" in v:
                    return decode(v["message"])
                if "key" in v:
                    return (decode(v["key"]), decode(v.get("value")))
                if "value" in v:
                    return decode(v["value"])
                return v
            if isinstance(v, list):
                items = [decode(i) for i in v]
                if items and all(isinstance(i, tuple) and len(i) == 2 for i in items):
                    return dict(items)
                return items
            return v

        rows = decode(resp.get("result"))
        out: Dict[str, Dict[str, float]] = {}
        for row in rows or []:
            if not isinstance(row, dict) or "n" not in row:
                continue
            out[row["n"]] = {
                "lowX": float(row["lx"]), "highX": float(row["hx"]),
                "lowY": float(row["ly"]), "highY": float(row["hy"]),
                "lowZ": float(row["lz"]), "highZ": float(row["hz"]),
            }
        return out

    def rename_part(self, part_id: str, name: str,
                    name_prop: str = "57f3fb8efa3416c06701d60d") -> None:
        self.c._request(
            "POST", "/api/v6/metadata/d/{}/w/{}/e/{}/p/{}".format(
                self.did, self.wid, self.eid, quote(part_id, safe="")),
            json={"properties": [{"propertyId": name_prop, "value": name}]})
