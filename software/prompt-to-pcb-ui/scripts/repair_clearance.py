"""Deterministic post-route clearance repair.

flroute's grid is rule-safe by construction, so clearance violations only
come from OFF-GRID copper (fanout stubs / terminal snaps). This pass reads
the DRC referee's exact violations and, for each, shoves the offending
track segment perpendicular-away from the copper it conflicts with by the
measured deficit + margin, reconnecting the ends with short jog segments so
the net stays whole. Re-run kicad-cli DRC after to verify; this only adjusts
final geometry and cannot regress routing.

  <kicad-python3> repair_clearance.py <board.kicad_pcb> <drc.json>

Prints "REPAIRED <n>/<total>" sentinel (teardown segfault tolerated).
"""
import json
import sys

import pcbnew

board_path, drc_path = sys.argv[1], sys.argv[2]
MARGIN_NM = pcbnew.FromMM(0.03)  # push this far past the rule
RULE_NM = pcbnew.FromMM(0.20)

b = pcbnew.LoadBoard(board_path)
drc = json.load(open(drc_path))

# index tracks by uuid (pre-mutation capture)
tracks = {}
for t in b.GetTracks():
    if t.GetClass() in ("PCB_TRACK", "PCB_ARC"):
        tracks[t.m_Uuid.AsString()] = t

def seg_len(t):
    s, e = t.GetStart(), t.GetEnd()
    return ((s.x - e.x) ** 2 + (s.y - e.y) ** 2) ** 0.5

# plan moves: (track, dx, dy) — shove perpendicular away from the conflict
plan = []
viol = [v for v in drc.get("violations", []) if v["type"] == "clearance"]
for v in viol:
    items = v.get("items", [])
    if len(items) != 2:
        continue
    actual = float(v["description"].split("actual")[1].split("mm")[0].strip())
    deficit = RULE_NM - pcbnew.FromMM(actual)
    push = deficit + MARGIN_NM
    # the conflict location (both items report a pos near the collision)
    p0 = items[0].get("pos", {})
    p1 = items[1].get("pos", {})
    # pick the movable item: a track (has uuid in our index); prefer shorter
    cands = []
    for it in items:
        tr = tracks.get(it.get("uuid", ""))
        if tr is not None:
            cands.append((seg_len(tr), tr, it))
    if not cands:
        continue
    cands.sort()
    _, tr, it = cands[0]  # shortest track = most stub-like, safest to move
    other = items[1] if it is items[0] else items[0]
    ox = pcbnew.FromMM(other.get("pos", {}).get("x", 0.0))
    oy = pcbnew.FromMM(other.get("pos", {}).get("y", 0.0))
    # segment direction, then perpendicular
    s, e = tr.GetStart(), tr.GetEnd()
    dx, dy = e.x - s.x, e.y - s.y
    ln = (dx * dx + dy * dy) ** 0.5 or 1.0
    px, py = -dy / ln, dx / ln  # unit perpendicular
    # midpoint of the segment
    mx, my = (s.x + e.x) / 2.0, (s.y + e.y) / 2.0
    # choose perp sign that moves the midpoint AWAY from the other item
    if (mx + px) ** 2 == 0:  # guard; never true, keeps form explicit
        pass
    dot = (mx - ox) * px + (my - oy) * py
    sign = 1.0 if dot >= 0 else -1.0
    plan.append((tr, int(sign * px * push), int(sign * py * push)))

# apply: move the segment, add jog segments at each end to stay connected
applied = 0
for tr, dx, dy in plan:
    s, e = tr.GetStart(), tr.GetEnd()
    ns = pcbnew.VECTOR2I(s.x + dx, s.y + dy)
    ne = pcbnew.VECTOR2I(e.x + dx, e.y + dy)
    layer = tr.GetLayer()
    width = tr.GetWidth()
    net = tr.GetNetCode()
    # jog: original start -> new start, and new end -> original end
    for (a, c) in ((s, ns), (ne, e)):
        j = pcbnew.PCB_TRACK(b)
        j.SetStart(pcbnew.VECTOR2I(a.x, a.y))
        j.SetEnd(pcbnew.VECTOR2I(c.x, c.y))
        j.SetLayer(layer)
        j.SetWidth(width)
        j.SetNetCode(net)
        b.Add(j)
    tr.SetStart(ns)
    tr.SetEnd(ne)
    applied += 1

if applied:
    pcbnew.SaveBoard(board_path, b)
print(f"REPAIRED {applied}/{len(viol)}")
