#!/usr/bin/env python3
"""Rigid-flex synthesis: fuse a 2-board partition into ONE rigid-flex part.

When the flex decision says rigid-flex, this takes the auto_partition output
(board_a + board_b + interconnect) and produces a single spec where:
  - the two board-to-board CONNECTORS are removed,
  - each net the connector was bridging is reconnected DIRECTLY across a flex
    section (the flex ribbon carries the copper the cable used to),
  - each side's parts are tagged as a rigid REGION (rigid_a / rigid_b),
  - the flex section + bend rules + rigid-flex stackup are attached.
The result is the original functional design as one foldable part — no connectors,
no cable, no mating step — and it must still pass the design-correctness gate.

Usage:  python3 rigid_flex_synth.py <partition_dir> [out.json]
Writes the rigid-flex spec; prints `RIGIDFLEX parts=<n> flex_conductors=<n>`.
"""
import json
import os
import sys


def other_end(nets, pinref):
    for net in nets:
        if pinref in net:
            for p in net:
                if p != pinref:
                    return p
    return None


def synth(board_a, board_b, ic):
    conn_a = ic.get("board_a_connector")
    conn_b = ic.get("board_b_connector")
    a_parts = board_a.get("parts", [])
    b_parts = board_b.get("parts", [])
    parts = [p for p in a_parts + b_parts if p.get("name") not in (conn_a, conn_b)]

    # keep every net that doesn't touch a connector
    nets = [n for n in board_a.get("nets", []) if not any(str(p).startswith(f"{conn_a}.") for p in n)]
    nets += [n for n in board_b.get("nets", []) if not any(str(p).startswith(f"{conn_b}.") for p in n)]

    # reconnect each crossing net directly, flex carries it
    flex = []
    for m in ic.get("map", []):
        a_end = other_end(board_a.get("nets", []), m.get("a"))
        b_end = other_end(board_b.get("nets", []), m.get("b"))
        if a_end and b_end and a_end != b_end:
            nets.append([a_end, b_end])
            flex.append({"signal": m.get("signal"), "type": m.get("type", "signal"), "a": a_end, "b": b_end})

    region = {p["name"]: "rigid_a" for p in a_parts if p.get("name") != conn_a}
    region.update({p["name"]: "rigid_b" for p in b_parts if p.get("name") != conn_b})

    spec = {
        "parts": parts,
        "nets": nets,
        "gnd": (board_a.get("gnd") or []) + (board_b.get("gnd") or []),
        "process": "rigid_flex",
        "regions": region,
        "flex_sections": [{
            "id": "flex_1", "joins": ["rigid_a", "rigid_b"],
            "conductors": len(flex), "carries": [f["signal"] for f in flex],
            "bend": {"radius_min_mult": 10, "no_via_in_bend": True, "no_components": True,
                     "trace_perp_to_bend": True, "hatched_pour": True},
        }],
        "stackup": "rigid-flex: 2 FR-4 rigid islands + 2-layer polyimide flex ribbon (coverlay both sides, no stiffener under bend)",
        "_provenance": "rigid_flex_synth from auto_partition (2 boards + cable -> 1 foldable part)",
    }
    return spec, flex


def main():
    pdir = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(pdir, "rigid_flex.chipscale-spec.json")
    ba = json.load(open(os.path.join(pdir, "board_a.chipscale-spec.json")))
    bb = json.load(open(os.path.join(pdir, "board_b.chipscale-spec.json")))
    ic = json.load(open(os.path.join(pdir, "interconnect.json")))
    spec, flex = synth(ba, bb, ic)
    json.dump(spec, open(out, "w"), indent=1)
    print(f"RIGID-FLEX synthesized -> {os.path.basename(out)}")
    print(f"  rigid_a: {sum(1 for v in spec['regions'].values() if v=='rigid_a')} parts | "
          f"rigid_b: {sum(1 for v in spec['regions'].values() if v=='rigid_b')} parts | "
          f"flex ribbon: {len(flex)} conductors ({', '.join(str(f['signal']) for f in flex)})")
    print(f"RIGIDFLEX parts={len(spec['parts'])} flex_conductors={len(flex)}")


if __name__ == "__main__":
    main()
