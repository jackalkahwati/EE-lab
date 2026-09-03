#!/usr/bin/env python3
"""Rigid / flex / rigid-flex decision.

Answers "does this board (or this split) want to be rigid, flex, or rigid-flex?"
from real drivers, not a guess:
  - MECHANICAL: does the assembly require the board to bend / fold / wrap to fit,
    or flex dynamically (a hinge / moving part)?  -> flex or rigid-flex.
  - INTERCONNECT (the partition case): two rigid sections joined by a SHORT, FIXED
    board-to-board link are the textbook rigid-flex win — ONE fabricated part
    replaces 2 boards + 2 connectors + a cable + the mating step. A LONG or
    field-serviceable link should stay a cable.
  - COST/VOLUME: flex/rigid-flex cost 2.5-4x; they must earn it.

Usage (partition case):
  python3 flex_decision.py --partition <interconnect.json> [intent]
Usage (single board):
  python3 flex_decision.py --board <chipscale-spec.json> [intent]
Prints a decision line + rationale + `FLEXDECISION <process>`.
"""
import json
import re
import sys

import fab_processes

FOLD = re.compile(r"\bfold|folded|foldable|wrap|wraps|conform|curved|cylindr|around a|bend to fit\b", re.I)
DYNAMIC = re.compile(r"\bhinge|moving|articulat|repeated flex|dynamic flex|actuat|gimbal|rotat\b", re.I)
WEARABLE = re.compile(r"\bwearable|wrist|strap|garment|patch|on-body\b", re.I)
COMPACT = re.compile(r"\bcompact|tight space|fit into|stack|stacked|3d fold|origami\b", re.I)
SERVICE = re.compile(r"\bfield-serviceable|replaceable|swappable|detachable|removable module\b", re.I)


def decide_partition(interconnect, intent=""):
    """interconnect: the auto_partition interconnect.json dict."""
    cut = int(interconnect.get("cut_signal_nets", 0)) + int(interconnect.get("shared_rails", 0)) + 1
    reasons, alts = [], []
    dynamic = bool(DYNAMIC.search(intent))
    fold = bool(FOLD.search(intent) or COMPACT.search(intent) or WEARABLE.search(intent))
    serviceable = bool(SERVICE.search(intent))

    # a SHORT fixed link with a modest pin count is the rigid-flex sweet spot
    short_fixed_link = cut <= 20 and not serviceable
    if dynamic:
        proc, why = "flex", "the link flexes DYNAMICALLY (hinge/moving part) — needs a true flex ribbon, not a cable"
    elif serviceable:
        proc, why = "rigid", "the two sections must be SEPARABLE/serviceable — keep them as 2 rigid boards + a connector+cable"
        alts.append("rigid-flex if they never need to separate")
    elif short_fixed_link:
        proc, why = "rigid_flex", (f"two rigid sections joined by a SHORT FIXED {cut}-conductor link — one rigid-flex part "
                                   "replaces 2 boards + 2 connectors + a cable + the mating step" + (", and it folds to fit the bay" if fold else ""))
        alts.append("2 rigid boards + cable if you need field-separability or lowest unit cost at volume")
    else:
        proc, why = "rigid", f"the interconnect is wide/long ({cut} conductors) — a cable is simpler and cheaper than a big flex ribbon"
        alts.append("rigid-flex if the link is actually short + fixed")
    reasons.append(why)
    return proc, reasons, alts, {"conductors": cut, "dynamic": dynamic, "fold": fold, "serviceable": serviceable}


def decide_board(spec, intent=""):
    reasons, alts = [], []
    dynamic = bool(DYNAMIC.search(intent))
    fold = bool(FOLD.search(intent) or WEARABLE.search(intent) or COMPACT.search(intent))
    if dynamic:
        return "flex", ["board flexes dynamically (hinge/wearable) — flex substrate required"], ["rigid-flex if it has dense rigid sections too"], {}
    if fold:
        return "rigid_flex", ["board must fold/conform to fit — rigid islands for the parts, flex to fold"], ["flex if there are few/no dense component clusters"], {}
    return "rigid", ["planar, no bend/fold requirement — rigid FR-4 is right"], [], {}


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    src = sys.argv[2] if len(sys.argv) > 2 else ""
    intent = sys.argv[3] if len(sys.argv) > 3 else ""
    if mode == "--partition":
        proc, reasons, alts, facts = decide_partition(json.load(open(src)), intent)
    elif mode == "--board":
        proc, reasons, alts, facts = decide_board(json.load(open(src)), intent)
    else:
        print("usage: flex_decision.py --partition <interconnect.json> [intent] | --board <spec.json> [intent]")
        sys.exit(2)
    p = fab_processes.process(proc)
    print(f"DECISION: {p['label']} ({proc}, {p['cost_mult']:.1f}x cost)")
    for r in reasons:
        print("  because:", r)
    for a in alts:
        print("  alt:", a)
    if not p["export_ready"]:
        print(f"  note: {proc} is spec-modeled; fab-ready {proc} gerbers (coverlay/stiffener + bend-zone DRC) are the export slice.")
    print(f"FLEXDECISION {proc}")


if __name__ == "__main__":
    main()
