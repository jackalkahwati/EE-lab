#!/usr/bin/env python3
"""Auto-partition — SPLIT a too-dense chip-scale netlist into two routable
sub-boards joined by a synthesized board-to-board connector.

This is the automated version of the manual analog/digital split we did for the
FL-1 measurement board: when a single dense board won't route clean, cut the
netlist along the analog/digital seam (analog front-end: mux / ADC / reference
vs digital+comms: MCU / transceiver), give each half its own board-to-board
header, and wire every net that crosses the seam — plus the shared power/ground
rails — through the connector so the two halves stay electrically identical to
the one dense board.

Reuses:
  multirail.split_analog / DOMAIN_PATTERNS  — the analog/digital seam knowledge.
  functional_wire connector format          — {"name":"J93","mpn":"2x4-2.54-Header",
                                               "footprint":"header_2x4","kind":"connector"}.
  design_rules.json ic class/pin-role map    — to seed which chips are analog vs
                                               digital and to name crossing signals.

Usage:  python3 auto_partition.py <chipscale-spec.json> <out_dir> [intent]
Writes: <out_dir>/board_a.chipscale-spec.json
        <out_dir>/board_b.chipscale-spec.json
        <out_dir>/interconnect.json
Prints: PARTITION a=<n_parts> b=<n_parts> cut=<n_cut_nets>
"""
import json
import math
import os
import re
import sys
from collections import Counter, defaultdict, deque

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# Reuse the analog/digital seam knowledge from the multi-rail synthesis pass.
from multirail import split_analog, ANALOG_PIN, DOMAIN_PATTERNS  # noqa: E402

# Chip classes (from design_rules.json "class") that belong to each domain.
ANALOG_CLASSES = {"mux", "adc", "reference", "sensor", "afe", "amplifier",
                  "dac", "analog", "frontend"}
DIGITAL_CLASSES = {"mcu", "transceiver", "comms", "logic", "memory",
                   "digital", "radio"}

# Pin ROLE names (from the rules pin map) that mark a net as a power rail.
POWER_ROLE = re.compile(
    r"^(VDD|VCC|AVDD|VDDA|AVCC|DVDD|VDDIO|IOVDD|VIN|VBAT|VBACKUP|VREF|VA|VCCA|VCCB|V\+)",
    re.I)
GND_ROLE = re.compile(r"^(GND|VSS|AGND|DGND)", re.I)


def load(p):
    with open(p) as fh:
        return json.load(fh)


def refof(pin):
    return pin.rsplit(".", 1)[0]


def numof(pin):
    parts = pin.rsplit(".", 1)
    return parts[1] if len(parts) == 2 else ""


def role_map(mpn, ic_rules):
    """Match a part's mpn to an ic-rules entry (same fuzzy match the gate uses)."""
    if not mpn:
        return None
    for k, rr in ic_rules.items():
        if k.upper() in mpn.upper() or mpn.upper() in k.upper():
            return rr
    return None


class UnionFind:
    def __init__(self):
        self.parent = {}

    def find(self, x):
        self.parent.setdefault(x, x)
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a, b):
        self.parent[self.find(a)] = self.find(b)


def main():
    if len(sys.argv) < 3:
        print("usage: auto_partition.py <chipscale-spec.json> <out_dir> [intent]",
              file=sys.stderr)
        sys.exit(2)
    spec_path, out_dir = sys.argv[1], sys.argv[2]
    spec = load(spec_path)
    intent = sys.argv[3] if len(sys.argv) > 3 else str(spec.get("intent", ""))
    rules = load(os.path.join(HERE, "design_rules.json"))
    ic_rules = rules["ics"]

    parts = spec.get("parts", [])
    nets = [list(n) for n in spec.get("nets", [])]
    gnd = list(spec.get("gnd", []) or [])
    ref_mpn = {p["name"]: (p.get("mpn") or "") for p in parts}
    part_by_ref = {p["name"]: p for p in parts}

    # ---- 1. connectivity graph: union-find over pins => electrical nets --------
    uf = UnionFind()
    all_pins = set()
    for net in nets:
        for pin in net:
            all_pins.add(pin)
        for i in range(len(net) - 1):
            uf.union(net[i], net[i + 1])
    enet_pins = defaultdict(set)  # root -> set of pins
    for pin in all_pins:
        enet_pins[uf.find(pin)].add(pin)

    def pin_role(pin):
        rr = role_map(ref_mpn.get(refof(pin), ""), ic_rules)
        if not rr:
            return None
        return (rr.get("pins") or {}).get(numof(pin))

    # classify each electrical net: power rail vs signal
    rail_roots, signal_roots = set(), set()
    for root, pins in enet_pins.items():
        is_rail = any(pin_role(p) and POWER_ROLE.match(pin_role(p)) for p in pins)
        (rail_roots if is_rail else signal_roots).add(root)

    # ---- 2. partition components: seed chips by class, grow passives ----------
    group = {}  # ref -> 'A' (analog) or 'B' (digital)
    chip_class = {}
    for p in parts:
        rr = role_map(p.get("mpn", ""), ic_rules)
        if rr:
            chip_class[p["name"]] = rr.get("class")
            if rr.get("class") in ANALOG_CLASSES:
                group[p["name"]] = "A"
            elif rr.get("class") in DIGITAL_CLASSES:
                group[p["name"]] = "B"

    # signal-net adjacency (rails excluded) — passives follow the chips they sit
    # between on the *signal* path, not the shared power rail.
    sig_adj = defaultdict(Counter)
    for root in signal_roots:
        refs = {refof(p) for p in enet_pins[root]}
        for a in refs:
            for b in refs:
                if a != b:
                    sig_adj[a][b] += 1
    # physical adjacency (all nets incl. rails) — for decoupling caps that only
    # touch a power rail + ground and have no signal neighbours.
    phys_adj = defaultdict(set)
    for net in nets:
        for i in range(len(net) - 1):
            a, b = refof(net[i]), refof(net[i + 1])
            if a != b:
                phys_adj[a].add(b)
                phys_adj[b].add(a)

    # fallback: if the class map failed to seed one whole side, bisect on the
    # single highest-signal-degree chip so we still produce two boards.
    if "A" not in group.values() or "B" not in group.values():
        chips = [p["name"] for p in parts if p["name"] in chip_class] or \
                [p["name"] for p in parts if (p.get("kind") == "chip")]
        if len(chips) >= 2:
            deg = {c: sum(sig_adj[c].values()) for c in chips}
            hub = max(deg, key=deg.get)
            for c in chips:
                group[c] = "B" if c == hub else "A"

    # label propagation for passives/connectors along signal nets
    order = [p["name"] for p in parts]
    for _ in range(len(order) + 1):
        changed = False
        for r in order:
            if r in group:
                continue
            sa = sum(c for n, c in sig_adj[r].items() if group.get(n) == "A")
            sb = sum(c for n, c in sig_adj[r].items() if group.get(n) == "B")
            if sa or sb:
                group[r] = "A" if sa >= sb else "B"
                changed = True
        if not changed:
            break
    # leftovers (rail-only decoupling caps): BFS to the nearest grouped part
    for r in order:
        if r in group:
            continue
        seen, dq, label = {r}, deque([r]), None
        while dq:
            cur = dq.popleft()
            for nb in phys_adj[cur]:
                if nb in group:
                    label = group[nb]
                    dq.clear()
                    break
                if nb not in seen:
                    seen.add(nb)
                    dq.append(nb)
        group[r] = label or "A"

    # ---- 3./4. walk original nets: keep intra-board pairs, find cut boundaries -
    board_nets = {"A": [], "B": []}
    cut_boundary = defaultdict(lambda: {"A": set(), "B": set()})  # root -> side pins
    for net in nets:
        for i in range(len(net) - 1):
            a, b = net[i], net[i + 1]
            ga, gb = group[refof(a)], group[refof(b)]
            if ga == gb:
                board_nets[ga].append([a, b])
            else:
                root = uf.find(a)
                cut_boundary[root]["A"].add(a if ga == "A" else b)
                cut_boundary[root]["B"].add(b if gb == "B" else a)

    # ground: split the gnd list by board; both halves keep their own ground pins
    board_gnd = {"A": [g for g in gnd if group.get(refof(g)) == "A"],
                 "B": [g for g in gnd if group.get(refof(g)) == "B"]}

    # ---- name each crossing net (for the interconnect map) --------------------
    AMBIG = re.compile(r"OUT_OR_IN|IN_OR_OUT|^(IO|NC|PIN)\d*$", re.I)

    def net_name(root, kind):
        roles = [r for r in (pin_role(p) for p in enet_pins[root]) if r]
        pwr = [r for r in roles if POWER_ROLE.match(r)]
        if kind == "power":
            return sorted(pwr)[0] if pwr else "VCC"
        # prefer an informative signal role (SCL, S0, COM...) over power/ambiguous
        sig = [r for r in roles
               if not POWER_ROLE.match(r) and not GND_ROLE.match(r)
               and not AMBIG.match(r)]
        if sig:
            return sorted(sig, key=len)[0]
        return None

    # ---- 5. synthesize the board-to-board connector ---------------------------
    used_nums = [int(re.sub(r"\D", "", p["name"]) or 0) for p in parts]
    base = (max(used_nums) if used_nums else 0) + 1
    JA, JB = f"J{base}", f"J{base + 1}"

    cut_signal_roots = sorted(r for r in cut_boundary if r in signal_roots)
    cut_rail_roots = sorted(r for r in cut_boundary if r in rail_roots)

    interconnect = []
    pin_idx = 0

    def add_pin(kind, name, root):
        nonlocal pin_idx
        pin_idx += 1
        entry = {"pin": pin_idx, "signal": name, "type": kind,
                 "a": f"{JA}.{pin_idx}", "b": f"{JB}.{pin_idx}"}
        if root is not None:
            aset = sorted(cut_boundary[root]["A"])
            bset = sorted(cut_boundary[root]["B"])
            entry["a_nodes"], entry["b_nodes"] = aset, bset
            for pa in aset:
                board_nets["A"].append([f"{JA}.{pin_idx}", pa])
            for pb in bset:
                board_nets["B"].append([f"{JB}.{pin_idx}", pb])
        return entry

    # pin 1: shared GROUND (both halves need it)
    if board_gnd["A"] and board_gnd["B"]:
        e = add_pin("ground", "GND", None)
        board_gnd["A"].append(f"{JA}.{e['pin']}")
        board_gnd["B"].append(f"{JB}.{e['pin']}")
        interconnect.append(e)
    # shared POWER rails that span both halves
    for root in cut_rail_roots:
        interconnect.append(add_pin("power", net_name(root, "power") or "VCC", root))
    # every crossing SIGNAL net
    for root in cut_signal_roots:
        nm = net_name(root, "signal") or f"NET{root.replace('.', '_')}"
        interconnect.append(add_pin("signal", nm, root))

    npins = pin_idx
    rows = max(1, math.ceil(npins / 2))
    conn = {"mpn": f"2x{rows}-2.54-Header", "footprint": f"header_2x{rows}",
            "pins": npins}
    part_a = {"name": JA, "mpn": conn["mpn"], "footprint": conn["footprint"],
              "kind": "connector"}
    part_b = {"name": JB, "mpn": conn["mpn"], "footprint": conn["footprint"],
              "kind": "connector"}

    # ---- assemble the two board specs -----------------------------------------
    board_parts = {"A": [], "B": []}
    for p in parts:
        board_parts[group[p["name"]]].append(p)
    board_parts["A"].append(part_a)
    board_parts["B"].append(part_b)

    def build_spec(side, self_conn, mate_conn):
        return {
            "parts": board_parts[side],
            "nets": board_nets[side],
            "gnd": board_gnd[side],
            "intent": intent,
            "components": len(board_parts[side]),
            "signal_nets": len(board_nets[side]),
            "ground_pins": len(board_gnd[side]),
            "source": "auto_partition",
            "partition": {
                "side": "analog_front_end" if side == "A" else "digital_comms",
                "connector": self_conn,
                "mates_with": mate_conn,
                "interconnect_pins": npins,
            },
        }

    os.makedirs(out_dir, exist_ok=True)
    a_path = os.path.join(out_dir, "board_a.chipscale-spec.json")
    b_path = os.path.join(out_dir, "board_b.chipscale-spec.json")
    ic_path = os.path.join(out_dir, "interconnect.json")
    with open(a_path, "w") as fh:
        json.dump(build_spec("A", JA, JB), fh, indent=1)
    with open(b_path, "w") as fh:
        json.dump(build_spec("B", JB, JA), fh, indent=1)
    with open(ic_path, "w") as fh:
        json.dump({
            "board_a": os.path.basename(a_path),
            "board_b": os.path.basename(b_path),
            "board_a_connector": JA,
            "board_b_connector": JB,
            "connector": conn,
            "cut_signal_nets": len(cut_signal_roots),
            "shared_rails": len(cut_rail_roots) + (1 if any(e["type"] == "ground"
                                                            for e in interconnect) else 0),
            "map": interconnect,
        }, fh, indent=1)

    n_cut = len(cut_signal_roots)
    print(f"AUTO-PARTITION — {os.path.basename(spec_path)}")
    print(f"  board A (analog front-end): {len(board_parts['A'])} parts, "
          f"{len(board_nets['A'])} nets  -> {os.path.basename(a_path)}")
    print(f"  board B (digital/comms):    {len(board_parts['B'])} parts, "
          f"{len(board_nets['B'])} nets  -> {os.path.basename(b_path)}")
    print(f"  connector: {conn['mpn']} ({npins} pins) — {JA} <-> {JB}")
    for e in interconnect:
        print(f"    pin {e['pin']:>2} {e['type']:<7} {e['signal']:<8} "
              f"{e.get('a_nodes', [])} <-> {e.get('b_nodes', [])}")
    print(f"PARTITION a={len(board_parts['A'])} b={len(board_parts['B'])} cut={n_cut}")


if __name__ == "__main__":
    main()
