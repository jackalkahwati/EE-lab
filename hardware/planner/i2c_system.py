"""Phase 19.1 — I2C pull-up ownership + effective pull-up checker, and the
connector keying / orientation checker. Turns the two Phase 19 system findings
into enforceable rules.

Rules encoded here:
  - system I2C pull-ups must have exactly one explicit owner
  - card pull-ups are valid standalone but DNP/configurable in system builds
  - no silent stacking: the checker computes the real parallel resistance
  - no I2C electrical compliance claim without physical measurement
  - unkeyed board-to-backplane connectors are review_required until keyed
"""

POPULATION_STATES = ("populated", "DNP", "configurable", "unknown", "not_present")
OWNERSHIP_STATES = ("card_owned_standalone", "backplane_owned_system",
                    "shared_but_review_required", "unknown_owner", "invalid_stack")
CLASSIFICATIONS = ("ok", "review_required", "too_strong_pullup", "missing_pullup",
                   "unknown_population", "measurement_required", "invalid_configuration")

BUS_V = 3.3
VOL = 0.4          # I2C low-level output voltage bound
I_SINK_MAX_MA = 3.0  # standard-mode sink spec
R_MIN_OK = (BUS_V - VOL) / (I_SINK_MAX_MA / 1000.0)   # ~967 ohm
R_REVIEW = 1500.0   # 967..1500 ohm: works but margin-thin -> review
R_MAX_OK = 10000.0  # weaker than 10k on a loaded bus -> review (rise time)

# The seven-board inventory (evidence: R10/R11 on every MCU card from the Pico
# block; R94/R95 on the backplane from Phase 19).
I2C_BOARDS = [
    ("controller_backplane", "Controller / Backplane v2.1", ["R10", "R11"], 4700, "populated"),
    ("digital_bringup", "Digital Bring-up v2.1", ["R10", "R11"], 4700, "populated"),
    ("relay_probe_matrix", "Relay / Probe Matrix v2.1", ["R10", "R11"], 4700, "populated"),
    ("calibration_reference", "Calibration / Reference v2", ["R10", "R11"], 4700, "populated"),
    ("external_instrument_interface", "EII-1", ["R10", "R11"], 4700, "populated"),
    ("power_current_monitor", "PCM-1", ["R10", "R11"], 4700, "populated"),
    ("passive_backplane", "Passive Backplane v1", ["R94", "R95"], 4700, "populated"),
]


def ownership_model():
    rows = []
    for role, name, refs, val, pop in I2C_BOARDS:
        is_bp = role == "passive_backplane"
        rows.append({
            "board": name, "role": role, "revision": "current first-article",
            "i2c_buses": ["FL-1 shared bus (bus v2)"],
            "sda_pullup_refs": [refs[0]], "scl_pullup_refs": [refs[1]],
            "value_ohm": val, "population_state": pop,
            "required_for_standalone": not is_bp,
            "dnp_for_backplane_system": not is_bp,
            "jumper_option_exists": False,
            "backplane_owns_in_system": True,
            "ownership_today": "shared_but_review_required",
            "ownership_target": "backplane_owned_system" if is_bp
                                 else "card_owned_standalone",
            "revb_recommendation": "keep populated (system owner)" if is_bp else
                "DNP by default for system builds; populate only for standalone "
                "bench validation; add solder-jumper enable in Rev B",
            "validation_note": "standalone card validation NEEDS the card "
                               "pull-ups populated" if not is_bp else
                               "backplane pull-ups define the bus with zero cards",
        })
    return {"version": "v1", "boards": rows,
            "rules": ["a card may be valid standalone and still require DNP in "
                      "a backplane system", "system pull-ups must have exactly "
                      "one explicit owner", "backplane-owned system pull-ups "
                      "preferred", "no silent stacking", "no I2C compliance "
                      "claim without physical measurement",
                      "no system validation pass with unknown ownership"]}


def effective_pullup(installed, mode="backplane_system", bus_v=BUS_V):
    """installed = list of (name, value_ohm_or_None, population_state).
    Returns the checker report for one bus line (SDA == SCL topology here)."""
    unknowns = [n for n, _v, p in installed if p == "unknown"]
    if unknowns:
        return {"classification": "unknown_population",
                "reason": "population unknown for: %s" % ", ".join(unknowns),
                "effective_ohm": None, "recommendation":
                "resolve population state before any system validation"}
    active = [(n, v) for n, v, p in installed
              if p in ("populated", "configurable") and v]
    if not active:
        return {"classification": "missing_pullup",
                "reason": "no pull-up populated on the bus (bus floats)",
                "effective_ohm": None,
                "recommendation": "populate the designated owner's pull-ups"}
    inv = sum(1.0 / v for _n, v in active)
    r_eff = 1.0 / inv
    i_sink_ma = (bus_v - VOL) / r_eff * 1000.0
    base = {"effective_ohm": round(r_eff, 1),
            "estimated_sink_ma_at_VOL": round(i_sink_ma, 2),
            "contributors": [{"name": n, "ohm": v} for n, v in active],
            "spec": "I2C standard-mode sink limit %.1fmA -> R_eff >= %.0f ohm"
                    % (I_SINK_MAX_MA, R_MIN_OK)}
    if r_eff < R_MIN_OK:
        return {**base, "classification": "too_strong_pullup",
                "reason": "%d contributors stack to %.0f ohm; sink current "
                          "%.2fmA exceeds the %.1fmA spec"
                          % (len(active), r_eff, i_sink_ma, I_SINK_MAX_MA),
                "recommendation": "DNP card-side pull-ups for system builds; "
                                  "backplane owns the bus"}
    if r_eff < R_REVIEW and len(active) > 1:
        return {**base, "classification": "review_required",
                "reason": "multiple owners stack to %.0f ohm — within spec but "
                          "margin-thin and unowned" % r_eff,
                "recommendation": "designate a single owner; DNP the rest"}
    if r_eff > R_MAX_OK:
        return {**base, "classification": "review_required",
                "reason": "weak effective pull-up (%.0f ohm) on a multi-drop "
                          "bus — rise time risk" % r_eff,
                "recommendation": "strengthen the owner's pull-up"}
    if len(active) > 1 and mode == "backplane_system":
        return {**base, "classification": "review_required",
                "reason": "more than one pull-up owner in system mode",
                "recommendation": "single owner rule: backplane owns; cards DNP"}
    return {**base, "classification": "ok",
            "reason": "single owner, %.0f ohm within spec window" % r_eff,
            "note": "physical compliance still measurement_required (rise time "
                    "+ sink current with instrument identity recorded)"}


# ---- connectors --------------------------------------------------------------
CONNECTORS = [
    # (name, board, type, pins, keyed, pin1_silk, carries_safety_or_power)
    ("J8 bus header", "each plugin card", "PinHeader_2x07", 14, False, True, True),
    ("J40-J45 slots", "Passive Backplane v1", "PinHeader_2x07", 14, False, True, True),
    ("J1 power inlet", "Passive Backplane v1 / cards", "PinHeader_1x02", 2, False, True, True),
    ("J20 DUT input", "PCM-1", "PinHeader_1x03", 3, False, True, True),
    ("J12 instrument UART", "EII-1", "PinHeader_1x04", 4, False, True, False),
    ("GPIO bank J10/J11", "digital + EII", "PinHeader_1x05", 5, False, True, False),
    ("PROBE/INSTR_BUS", "Relay / Probe Matrix", "PinHeader_1x06", 6, False, True, False),
]


def orientation_check():
    rows = []
    for name, board, ctype, pins, keyed, pin1, safety in CONNECTORS:
        if keyed:
            cls = "keyed_ok"
        elif not pin1:
            cls = "missing_pin1_mark"
        elif safety:
            cls = "unkeyed_review_required"
        else:
            cls = "unkeyed_review_required"
        sev = "high" if safety and not keyed else ("medium" if not keyed else "low")
        rows.append({"connector": name, "board": board, "type": ctype,
                     "pins": pins, "keyed": keyed, "pin1_marked": pin1,
                     "safety_or_power": safety, "classification": cls,
                     "severity": sev,
                     "first_article_mitigation": "pin-1 silk + assembly "
                     "checklist + human inspection" if not keyed else None,
                     "revb": "keyed shrouded header" if safety and not keyed
                             else ("shrouded or keyed option" if not keyed else "keep")})
    return {"version": "v1", "connectors": rows,
            "rules": ["first articles may use unkeyed connectors ONLY with pin-1 "
                      "silk + checklist + human inspection",
                      "Rev B prefers keyed/shrouded for board-to-backplane",
                      "interlock/fault/reset/trigger/sync/power connectors are "
                      "safety-relevant: higher severity",
                      "no production-readiness claim with reversible critical "
                      "connectors absent keying or equivalent mitigation"]}
