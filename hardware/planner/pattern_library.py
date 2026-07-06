"""FirstLight Instrument Pattern Library (Phase 9) + selection (Phase 7).

Builds the pattern library from GENUINELY LOCAL, trusted sources — Compose's own
passing boards, FirstLight component contracts, and ingested UCS parts — plus
HONEST needs_reference placeholders for the target FL-1 instrument patterns that
still need a curated reference dropped into references/. Nothing external is
fabricated; a placeholder is clearly marked and is not usable in synthesis.

  from pattern_library import build, load_all, select
"""
import json
import os

import pattern_extract as pe
import pattern_spec as ps
import reference_manifest as rm

LIB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "patterns")
HERE = os.path.dirname(os.path.abspath(__file__))
USABLE = ("reusable", "reusable_with_review")

# the FL-1 instrument patterns we want (Phase 9 target list). Each names how it is
# sourced today: a real local extraction, or an honest needs_reference placeholder.
_TARGETS = [
    ("precision ADC measurement channel", "precision_adc_channel", "board:ads1115"),
    ("current sense channel", "current_sense_channel", "contract:current_sense"),
    ("I2C interface block", "i2c_interface", "contract:i2c_sensor"),
    ("SPI interface block", "spi_interface", "contract:spi_device"),
    ("CAN interface block", "can_interface", "contract:can_transceiver"),
    ("shift-register output channel", "shift_register_channel", "contract:shift_register"),
    ("regulated power rail", "power_rail", "contract:regulator"),
    # placeholders — need a curated reference before they become usable
    ("relay matrix channel", "relay_matrix_channel", "placeholder"),
    ("programmable power rail", "programmable_power_rail", "placeholder"),
    ("eFuse / load switch channel", "efuse_load_switch", "placeholder"),
    ("voltage reference channel", "voltage_reference_channel", "placeholder"),
    ("analog mux channel", "analog_mux_channel", "placeholder"),
    ("DAC stimulus channel", "dac_stimulus_channel", "placeholder"),
    ("op-amp output buffer", "opamp_output_buffer", "placeholder"),
    ("calibration loopback", "calibration_loopback", "placeholder"),
    ("SWD/JTAG programmer interface", "swd_jtag_interface", "placeholder"),
]


def _contracts():
    import sys
    sys.path.insert(0, os.path.join(HERE, "..", "blocks"))
    try:
        import resolve_part
        return getattr(resolve_part, "CONTRACTS", {})
    except Exception:
        return {}


def _placeholder(name, category):
    p = ps.make_pattern(
        name, category, "firstlight_generated", "unknown_needs_review",
        purpose="target FL-1 instrument pattern — no curated reference yet",
        components=[],
        provenance={"source": "needs_reference"},
        confidence={},
        unknowns=["everything — drop a curated reference into references/ and register it"])
    p = ps.finalize(p)
    p["support_status"] = "needs_review"
    p["status_reasons"] = ["needs_reference: no source design ingested yet"]
    p["needs_reference"] = True
    return p


def build():
    """(Re)build the library from local sources + placeholders. Returns the list."""
    refs = rm.load()
    contracts = _contracts()
    board_refs = {r["name"]: r for r in refs if r["source_type"] == "firstlight_generated"
                  and r.get("local_files")}
    ads_board = next((r for r in board_refs.values() if "ADS1115" in r["name"]), None)

    patterns = []
    for name, cat, src in _TARGETS:
        kind, _, key = src.partition(":")
        if kind == "board" and ads_board:
            run = os.path.join(HERE, ads_board["local_files"][0])
            if os.path.isdir(run):
                patterns.append(pe.from_board(run, name, cat, ads_board))
                continue
        if kind == "contract" and key in contracts:
            p = pe.from_contract(key, contracts[key])
            p["name"], p["category"] = name, cat
            patterns.append(p)
            continue
        patterns.append(_placeholder(name, cat))

    os.makedirs(LIB_DIR, exist_ok=True)
    for p in patterns:
        fn = "".join(c if c.isalnum() or c in "-_" else "_" for c in p["category"]) + ".json"
        json.dump(p, open(os.path.join(LIB_DIR, fn), "w"), indent=1)
    return patterns


def load_all(usable_only=False):
    out = []
    if not os.path.isdir(LIB_DIR):
        return out
    for fn in sorted(os.listdir(LIB_DIR)):
        if not fn.endswith(".json"):
            continue
        try:
            p = json.load(open(os.path.join(LIB_DIR, fn)))
        except Exception:
            continue
        if usable_only and p.get("support_status") not in USABLE:
            continue
        out.append(p)
    return out


# ---- Phase 7: pattern scoring + selection -----------------------------------
def _score(pattern, intent):
    """Higher = better fit. Honesty: an unusable-license or needs_reference
    pattern can never be SELECTED for direct use — it scores 0 for reuse."""
    if pattern.get("support_status") not in USABLE:
        return 0.0, ["not usable (%s)" % pattern.get("support_status")]
    s, why = 0.0, []
    caps = " ".join(intent.get("capabilities", []) + [intent.get("product_goal", "")]).lower()
    cat = pattern["category"].replace("_", " ")
    # functional match
    if any(w in caps for w in cat.split()):
        s += 40
        why.append("functional match on '%s'" % cat)
    # interface match
    for it in pattern.get("interface_pins", []):
        if it.lower() in caps or it.lower() in " ".join(intent.get("buses", [])).lower():
            s += 10
            why.append("interface %s matches" % it)
    # source trust + license safety
    if pattern.get("direct_reuse_allowed"):
        s += 20
        why.append("permissive license (direct reuse)")
    else:
        s += 8
        why.append("usable with review")
    # validation evidence (a proven FL board)
    if "passing FirstLight board" in pattern.get("purpose", "") or \
       "passed strict" in pattern.get("expected_performance", ""):
        s += 15
        why.append("proven on a passing FL board")
    return s, why


def select(intent, patterns=None):
    """Rank library patterns for a design intent; explain selected + rejected."""
    patterns = patterns if patterns is not None else load_all()
    scored = [(p, *_score(p, intent)) for p in patterns]
    scored.sort(key=lambda x: -x[1])
    usable = [x for x in scored if x[1] > 0]
    selected = usable[0] if usable else None
    return {
        "selected": ({"category": selected[0]["category"], "name": selected[0]["name"],
                      "support_status": selected[0]["support_status"],
                      "score": round(selected[1], 1), "why": selected[2],
                      "direct_reuse": selected[0]["direct_reuse_allowed"]}
                     if selected else None),
        "rejected": [{"category": p["category"], "score": round(sc, 1),
                      "why": (why[0] if why else "no functional match")}
                     for p, sc, why in scored[1:8]],
        "no_fit_reason": None if selected else "no usable pattern matched the intent",
    }
