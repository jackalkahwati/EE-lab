"""Stage 1 design interpreter — turns a natural-language board request into a
structured design spec for the FirstLight FL-1 family, using Claude.

This is the real Stage-1 AI pass the pipeline used to skip ("cached netlist").
It does NOT silently rewrite the proven .ato topology; it produces a validated
spec (matrix size, lanes, MCU, supply, title) that:
  - parametrizes the floorplan generator (gen_board.py DESIGN_SPEC), and
  - is recorded alongside the run.
The hard Stage-1 gate remains `ato build` (run by the pipeline after this).

Usage:  python3 ai_design.py "<prompt>" <out_spec.json>
Output: writes <out_spec.json>; prints human-readable rationale lines to stdout
        (each line is streamed to the UI log). Exits 0 even on API failure —
        it falls back to the FL-1 baseline so the pipeline can still run.
"""
import json
import os
import re
import sys
import urllib.request

PROMPT = sys.argv[1] if len(sys.argv) > 1 else ""
OUT = sys.argv[2] if len(sys.argv) > 2 else "design_spec.json"

# FL-1 baseline — the validated reference design point.
BASELINE = {
    "probes": 8,
    "group_lanes": 7,
    "probe_lanes": 3,
    "mcu": "RP2040 (Raspberry Pi Pico 2)",
    "vin": "24V",
    "title": "FIRSTLIGHT FL-1 - RELAY/PROBE MATRIX REV A - FLOORPLAN",
    "rationale": "FL-1 baseline reference design.",
}

MODEL = os.environ.get("AI_DESIGN_MODEL", "claude-haiku-4-5-20251001")

SYSTEM = """You are the design-interpretation stage of the FirstLight \
prompt-to-PCBA pipeline. The reference board is the FL-1 relay/probe matrix: \
a 4-layer board that switches instrument lanes onto probe tips through banks \
of G6K relays (group lanes) and SIP reed relays (probe lanes), driven by \
shift-register sinks under an RP2040.

Given a plain-English board request, return ONLY a JSON object describing the \
closest buildable point in the FL-1 family. Schema (all fields required):
{
  "probes": int 2..8,          // number of probe channels
  "group_lanes": int 1..7,     // instrument lanes via G6K relays (scope/daq/logic/pwr)
  "probe_lanes": int 1..3,     // lanes via reed relays (dmm_hi/dmm_lo/gnd_ref)
  "mcu": string,               // controller, e.g. "RP2040 (Raspberry Pi Pico 2)"
  "vin": string,               // input supply, e.g. "24V"
  "title": string,             // short board title for the floorplan
  "rationale": string          // 1-2 sentences mapping the request to these params
}
Clamp anything out of range. Keep RP2040 unless the request clearly names a \
different controller. Do not add fields. Do not wrap the JSON in prose or code \
fences."""


def clamp(v, lo, hi, d):
    try:
        return max(lo, min(hi, int(v)))
    except Exception:
        return d


def heuristic_spec(prompt):
    """Deterministic local NL interpreter — drives the spec from the prompt
    text with no API. Real design interpretation, not a placeholder; Claude
    refines on top of this when API credit is available."""
    t = (prompt or "").lower()
    spec = dict(BASELINE)

    # probe count: "8 probe", "4-channel", "6x ...", "NxM matrix"
    m = re.search(r"(\d+)\s*[-x]?\s*(?:probe|channel|chan|ch\b|tip)", t)
    if not m:
        m = re.search(r"(\d+)\s*x\s*\d+\s*(?:matrix|relay)", t)
    if not m:
        m = re.search(r"matrix\D{0,12}?(\d+)", t)
    if m:
        spec["probes"] = clamp(m.group(1), 2, 8, BASELINE["probes"])

    # group lanes (G6K instrument lanes) by which instruments are named
    g_lanes = sum(k in t for k in ("scope", "oscilloscope", "daq", "logic",
                                   "analyzer", "pwr", "power inject", "siggen",
                                   "function gen"))
    if g_lanes:
        # each named instrument family ~ a lane; scope usually = 2 lanes
        g = g_lanes + (1 if ("scope" in t or "oscilloscope" in t) else 0)
        spec["group_lanes"] = clamp(g, 1, 7, BASELINE["group_lanes"])

    # probe lanes (reed): dmm / continuity / reference
    p_lanes = sum(k in t for k in ("dmm", "multimeter", "ohm", "continuity",
                                   "reference", "gnd_ref", "ground ref"))
    if p_lanes:
        spec["probe_lanes"] = clamp(p_lanes, 1, 3, BASELINE["probe_lanes"])

    # supply voltage
    mv = re.search(r"(\d{1,3})\s*v(?:olt|dc|\b)", t)
    if mv:
        spec["vin"] = "{}V".format(clamp(mv.group(1), 1, 230, 24))

    # controller
    for needle, name in (("rp2040", "RP2040 (Raspberry Pi Pico 2)"),
                         ("pico", "RP2040 (Raspberry Pi Pico 2)"),
                         ("stm32", "STM32"), ("esp32", "ESP32"),
                         ("rp2350", "RP2350 (Raspberry Pi Pico 2)")):
        if needle in t:
            spec["mcu"] = name
            break

    if prompt and prompt.strip():
        spec["title"] = "FL-1 VARIANT - {}".format(
            re.sub(r"\s+", " ", prompt.strip())[:48].upper())
    spec["rationale"] = (
        "Local interpreter: {p} probes, {g} group lanes, {pl} probe lanes, "
        "{mcu}, {v} from the request.".format(
            p=spec["probes"], g=spec["group_lanes"], pl=spec["probe_lanes"],
            mcu=spec["mcu"], v=spec["vin"]))
    return spec


def call_claude(prompt):
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise RuntimeError("ANTHROPIC_API_KEY not set")
    body = json.dumps({
        "model": MODEL,
        "max_tokens": 600,
        "system": SYSTEM,
        "messages": [{"role": "user", "content": prompt or "FL-1 baseline board"}],
    }).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        headers={
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.load(r)
    text = "".join(b.get("text", "") for b in data.get("content", []))
    # tolerate stray fences / prose around the JSON
    s, e = text.find("{"), text.rfind("}")
    if s < 0 or e < 0:
        raise ValueError("no JSON object in model reply")
    return json.loads(text[s:e + 1])


def main():
    print("ai_design: interpreting prompt with {}".format(MODEL))
    if PROMPT:
        print("ai_design: prompt = {}".format(PROMPT[:160]))
    # Local deterministic interpretation always runs — the prompt drives the
    # spec even with no API. Claude refines it when credit is available.
    spec = heuristic_spec(PROMPT)
    try:
        got = call_claude(PROMPT)
        spec["probes"] = clamp(got.get("probes"), 2, 8, spec["probes"])
        spec["group_lanes"] = clamp(got.get("group_lanes"), 1, 7, spec["group_lanes"])
        spec["probe_lanes"] = clamp(got.get("probe_lanes"), 1, 3, spec["probe_lanes"])
        spec["mcu"] = str(got.get("mcu") or spec["mcu"])[:80]
        spec["vin"] = str(got.get("vin") or spec["vin"])[:24]
        spec["title"] = str(got.get("title") or spec["title"])[:80]
        spec["rationale"] = str(got.get("rationale") or spec["rationale"])[:400]
        print("ai_design: GREEN — refined by {}".format(MODEL))
    except Exception as e:  # resilient: keep the local interpretation
        print("ai_design: model unavailable ({}) — using local interpreter".format(
            str(e).split(":")[0]))

    print("ai_design: spec -> {} probes, {} group lanes, {} probe lanes, MCU {}, Vin {}".format(
        spec["probes"], spec["group_lanes"], spec["probe_lanes"], spec["mcu"], spec["vin"]))
    if spec.get("rationale"):
        print("ai_design: rationale — {}".format(spec["rationale"]))
    json.dump(spec, open(OUT, "w"), indent=2)
    print("ai_design: wrote spec -> {}".format(OUT))


if __name__ == "__main__":
    main()
