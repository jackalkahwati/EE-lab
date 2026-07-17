#!/usr/bin/env python3
"""
Thermal validation loop (Rec #3) — the software half of closing the physical
loop for HEAT, mirroring how FL-1's electrical results already feed back.

Compose predicts (thermal_budget). A physical test measures. This module takes
both, computes where the model was wrong, and emits a CALIBRATION UPDATE that
makes the next prediction of the same class better — the same fleet-learning
pattern the electronics stack uses, now for thermal.

WHAT IS HARDWARE-GATED: the measurement itself needs a thermal test rig
(thermocouples / IR on a powered unit at a set ambient). This module is the
software that ingests that data and closes the loop; it does not fabricate it.
The demo below uses SYNTHETIC measurements, clearly labelled, to exercise the
loop end to end.

Calibration logic (transparent, first-order):
  * per-part error = predicted_junction - measured
  * a part measured much cooler than predicted was better-coupled to the wall
    than the generic theta_JA assumed -> fit an effective theta_JA for it.
  * a systematic surface/air bias means the assumed convection+emissivity were
    off -> fit an effective enclosure h.
Each correction is stored against the product class with a confidence that grows
with the number of measured units.

Usage: thermal_validation.py <prediction.json> <measurement.json> [--out cal.json]
"""
from __future__ import annotations
import argparse, json, sys

def fit(prediction, measurement):
    amb = prediction.get("ambientC", 25)
    enc = prediction.get("enclosure", {})
    pred_air = enc.get("internalAirC", amb)
    meas = {m["name"]: float(m["measuredC"]) for m in measurement.get("parts", [])}
    pred_parts = {p["name"]: p for p in prediction.get("parts", [])}

    per_part = []
    theta_corrections = {}
    for name, pp in pred_parts.items():
        if name not in meas:
            continue
        pj = pp["junctionC"]; mj = meas[name]; err = round(pj - mj, 1)
        entry = {"name": name, "predictedC": pj, "measuredC": mj, "errorC": err}
        # back out the effective theta_JA from the measurement, if the part has power
        p = pp.get("powerW", 0)
        if p > 0:
            # measured rise above the (measured or predicted) internal air / power
            air_ref = meas.get("__air__", pred_air)
            theta_eff = round(max(0.1, (mj - air_ref) / p), 2)
            entry["thetaJA_assumed"] = pp.get("thetaJA_CperW")
            entry["thetaJA_effective"] = theta_eff
            if pp.get("thetaJA_CperW") and abs(theta_eff - pp["thetaJA_CperW"]) / pp["thetaJA_CperW"] > 0.25:
                theta_corrections[name] = theta_eff
        per_part.append(entry)

    # systematic enclosure bias: if measured air (if given) differs from predicted
    h_correction = None
    if "__air__" in meas:
        meas_air = meas["__air__"]
        pred_rise = pred_air - amb; meas_rise = meas_air - amb
        if pred_rise > 0 and abs(meas_rise - pred_rise) / pred_rise > 0.2:
            factor = round(pred_rise / max(0.1, meas_rise), 2)  # h scales inversely with rise
            h_correction = {"assumed_hWm2K": enc.get("effectiveHWm2K"),
                            "effective_hWm2K": round((enc.get("effectiveHWm2K") or 6) * factor, 2),
                            "reason": f"measured air rise {round(meas_rise,1)}C vs predicted {round(pred_rise,1)}C"}

    n_units = int(measurement.get("unitsMeasured", 1))
    return {
        "source": "thermal-validation-v1",
        "productClass": prediction.get("productClass") or measurement.get("productClass") or "unclassified",
        "measurementSource": measurement.get("source", "UNSPECIFIED"),
        "synthetic": bool(measurement.get("synthetic", False)),
        "perPart": sorted(per_part, key=lambda e: -abs(e["errorC"])),
        "maxAbsErrorC": max((abs(e["errorC"]) for e in per_part), default=None),
        "calibration": {
            "thetaJA_effective": theta_corrections,
            "enclosure_h": h_correction,
            "note": "apply these to future thermal budgets of this product class; "
                    "generic theta/emissivity are replaced by measured-effective values.",
        },
        "confidence": round(min(0.95, 0.4 + 0.15 * n_units), 2),
        "unitsMeasured": n_units,
        "honesty": "the MEASUREMENT is the hardware-gated input (thermal rig). Once real data "
                   "exists this closes the loop exactly like the electrical FL-1 loop; the "
                   "calibration only becomes trustworthy across several measured units.",
    }

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("prediction"); ap.add_argument("measurement"); ap.add_argument("--out")
    a = ap.parse_args()
    pred = json.load(open(a.prediction)); meas = json.load(open(a.measurement))
    cal = fit(pred, meas)
    out = json.dumps(cal, indent=1)
    if a.out:
        open(a.out, "w").write(out)
        tag = " [SYNTHETIC]" if cal["synthetic"] else ""
        print(f"wrote {a.out}: class '{cal['productClass']}', max error {cal['maxAbsErrorC']}C{tag}")
        for e in cal["perPart"][:3]:
            extra = f"  theta {e.get('thetaJA_assumed')}→{e.get('thetaJA_effective')}" if "thetaJA_effective" in e else ""
            print(f"  {e['name']:22} pred {e['predictedC']}C  meas {e['measuredC']}C  err {e['errorC']}C{extra}")
    else:
        print(out)

if __name__ == "__main__":
    main()
