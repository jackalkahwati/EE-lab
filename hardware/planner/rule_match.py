"""Shared MPN -> design-rule lookup for the design-correctness tooling.

design_check.py (the gate), functional_wire.py (the synthesis pass) and
functional_sim.py (the ngspice stage) all need to answer the same question:
"which entry in the rules DB describes this part?". They used to answer it three
different ways (two bidirectional-substring scans and one exact dict get), so a
part like `REF3025AIDBZR` could pass the gate while the sim silently dropped it.
This module is the ONE answer all three use.

match_rule(mpn, rules) -> rule | None

`rules` may be the full rules document ({"ics": {mpn: rule, ...}, ...}) or a flat
{mpn: rule} table (functional_sim's DEVICE_DB). Matching is case-insensitive
and whitespace-trimmed. Precedence, first tier that yields a hit wins:

  1. EXACT     key == mpn                               (REF3025 == REF3025)
  2. FAMILY    key is a prefix of mpn; longest key wins  (REF3025 -> REF3025AIDBZR)
  3. TRUNCATED mpn is a prefix of key, mpn >= 5 chars;   (ADS1115 -> ADS1115IDGS)
               shortest key wins (closest family)
  4. TOKEN     key appears as a delimited token inside   (RP2040 -> PICO-RP2040-MODULE)
               mpn (split on - _ / space . ,); longest key wins

Deliberately NOT supported (the old behaviour): arbitrary reverse substring
(`"R" in "REF3025"` matched every reference to a resistor's value). An empty or
non-string mpn never matches.

load_rules(path, merge_auto=True) loads a rules JSON and, like the gate always
did, fills gaps from design_rules_auto.json (generated from the part library by
gen_design_rules.py). Curated entries ALWAYS win; auto entries only add MPNs the
hand-written DB lacks. Raises ValueError with a one-line reason when the DB is
not shaped like a rules document.
"""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_RULES = os.path.join(HERE, "design_rules.json")
AUTO_RULES = os.path.join(HERE, "design_rules_auto.json")

_TOKEN_SPLIT = re.compile(r"[-_/\s.,]+")
_TRUNCATED_MIN = 5


def _table(rules):
    """Return the {mpn: rule} table from either a full rules doc or a flat dict."""
    if not isinstance(rules, dict):
        return {}
    ics = rules.get("ics")
    if isinstance(ics, dict):
        return ics
    return rules


def _norm(s):
    return str(s).strip().upper()


def match_rule(mpn, rules):
    """Return the rule entry for `mpn` per the precedence in the module doc, or None."""
    if not isinstance(mpn, str) or not mpn.strip():
        return None
    table = _table(rules)
    if not table:
        return None
    m = _norm(mpn)
    keyed = {}
    for k, v in table.items():
        if isinstance(k, str) and k.strip():
            keyed.setdefault(_norm(k), (k, v))
    # 1. exact
    if m in keyed:
        return keyed[m][1]
    # 2. family: key is a prefix of the mpn (longest key wins)
    fam = [k for k in keyed if m.startswith(k)]
    if fam:
        return keyed[max(fam, key=len)][1]
    # 3. truncated: mpn is a prefix of the key (shortest key wins)
    if len(m) >= _TRUNCATED_MIN:
        trunc = [k for k in keyed if k.startswith(m)]
        if trunc:
            return keyed[min(trunc, key=len)][1]
    # 4. token: key is a whole delimited token inside the mpn
    tokens = {t for t in _TOKEN_SPLIT.split(m) if t}
    tok = [k for k in keyed if k in tokens]
    if tok:
        return keyed[max(tok, key=len)][1]
    return None


def match_key(mpn, rules):
    """Like match_rule but returns the matched table KEY (original spelling), or None."""
    table = _table(rules)
    rule = match_rule(mpn, table)
    if rule is None:
        return None
    for k, v in table.items():
        if v is rule:
            return k
    return None


class SpecError(ValueError):
    """A chipscale-spec that cannot be checked (shape problem, not a design finding)."""


def validate_spec(spec):
    """Shape-check a chipscale-spec ({parts, nets, gnd}) the way all three tools
    need it. Returns (parts, nets, gnd); `nets`/`gnd` default to [] when ABSENT.
    Raises SpecError (a ValueError) with a one-line reason when:
      - the spec is not a JSON object,
      - 'parts' is missing or not a list (an EMPTY list is valid — the caller
        decides what an empty design means),
      - a part is not an object or has no non-empty string 'name',
      - 'nets' is present but not a list of lists of 'REF.PIN' strings,
      - 'gnd' is present but not a list of strings (null included).
    """
    if not isinstance(spec, dict):
        raise SpecError("spec is not a JSON object")
    parts = spec.get("parts")
    if not isinstance(parts, list):
        raise SpecError("spec has no 'parts' list" if "parts" not in spec else "'parts' is not a list")
    for i, p in enumerate(parts):
        if not isinstance(p, dict):
            raise SpecError("part #%d is not an object" % i)
        name = p.get("name")
        if not isinstance(name, str) or not name.strip():
            raise SpecError("part #%d has no name (mpn=%r)" % (i, p.get("mpn")))
    nets = spec.get("nets", [])
    if nets is None:
        nets = []
    if not isinstance(nets, list):
        raise SpecError("'nets' is not a list")
    for i, n in enumerate(nets):
        if not isinstance(n, list) or not all(isinstance(x, str) and "." in x for x in n):
            raise SpecError("net #%d is not a list of 'REF.PIN' strings" % i)
    if "gnd" in spec:
        gnd = spec["gnd"]
        if gnd is None:
            raise SpecError("'gnd' is null")
        if not isinstance(gnd, list) or not all(isinstance(x, str) for x in gnd):
            raise SpecError("'gnd' is not a list of 'REF.PIN' strings")
    else:
        gnd = []
    return parts, nets, list(gnd)


def load_rules(path=None, merge_auto=True):
    """Load a design-rules document; validate its shape; merge auto rules into gaps."""
    path = path or DEFAULT_RULES
    with open(path) as f:
        rules = json.load(f)
    if not isinstance(rules, dict):
        raise ValueError("rules DB %s is not a JSON object" % os.path.basename(path))
    if not isinstance(rules.get("ics"), dict):
        raise ValueError("rules DB %s has no 'ics' table" % os.path.basename(path))
    if not isinstance(rules.get("generic"), dict):
        raise ValueError("rules DB %s has no 'generic' section" % os.path.basename(path))
    if merge_auto and os.path.exists(AUTO_RULES):
        try:
            with open(AUTO_RULES) as f:
                auto = json.load(f)
            for mpn, entry in ((auto.get("ics") if isinstance(auto, dict) else None) or {}).items():
                if isinstance(entry, dict):
                    rules["ics"].setdefault(mpn, entry)
        except Exception:
            pass  # auto rules are a convenience layer; a broken file never blocks the gate
    return rules
