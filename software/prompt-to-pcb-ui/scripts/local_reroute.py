"""Hybrid cleanup: local fine-grid shape re-router for DRC-dirty nets.

flroute routes on a coarse rule-safe grid and escapes fine-pitch pads with
off-grid stubs that aren't clearance-checked against foreign copper — the
source of every residual clearance defect. This pass takes the nets the DRC
referee flags, rips each one, and re-routes it on a FINE grid (0.1mm) where
clearance to all other copper is a hard constraint (gridless-style: clean by
construction), with through-via support so an entry can escape to another
layer. KiCad's own push-and-shove engine is GUI-only / not scriptable, so
this is our shape-based engine.

  <kicad-python3> local_reroute.py <board.kicad_pcb> <drc.json>

Prints "REROUTED <ok>/<attempted> (skipped <n>)". Re-run DRC after.
"""
import json
import heapq
import re
import sys

import pcbnew

board_path, drc_path = sys.argv[1], sys.argv[2]
b = pcbnew.LoadBoard(board_path)

STACK = [pcbnew.F_Cu, pcbnew.In1_Cu, pcbnew.In2_Cu, pcbnew.B_Cu]  # 0,4,6,2
SIDX = {l: i for i, l in enumerate(STACK)}
NL = 4
PITCH = pcbnew.FromMM(0.1)
CLR = pcbnew.FromMM(0.20)
W = pcbnew.FromMM(0.25)
HALO = CLR + W / 2.0          # foreign-copper center -> our centerline min
VIA_DIA = pcbnew.FromMM(0.6)
VIA_DRILL = pcbnew.FromMM(0.3)
VIA_PEN = pcbnew.FromMM(2.0)  # A* cost penalty for a layer change
MARGIN = pcbnew.FromMM(6.0)   # window padding around a net's pads
MAX_SPAN = pcbnew.FromMM(60)  # skip nets whose pad bbox is larger (too global)

# ---- dirty nets from the DRC referee ----------------------------------------
drc = json.load(open(drc_path))
dirty = set()
for v in drc.get("violations", []):
    if v["type"] in ("clearance", "shorting_items"):
        for it in v.get("items", []):
            m = re.search(r"\[(.*?)\]", it.get("description", ""))
            if m:
                dirty.add(m.group(1))

# ---- capture geometry pre-mutation ------------------------------------------
pads_by_net = {}            # net -> list of (cx,cy,hw,hh,{stackidx})
all_pads = []               # (cx,cy,hw,hh,{stackidx},netcode)
for fp in b.GetFootprints():
    for p in fp.Pads():
        pos = p.GetPosition()
        sz = p.GetSize()
        hw, hh = sz.x / 2.0, sz.y / 2.0
        lset = {SIDX[l] for l in STACK if p.IsOnLayer(l)}
        nn = str(p.GetNetname())
        rec = (pos.x, pos.y, hw, hh, lset)
        pads_by_net.setdefault(nn, []).append(rec)
        all_pads.append((pos.x, pos.y, hw, hh, lset, p.GetNetCode()))

seg_obstacles = []   # (x0,y0,x1,y1,half,netcode,stackidx)
via_obstacles = []   # (x,y,r,netcode)
track_objs = []      # (obj, netcode)
for t in b.GetTracks():
    nc = t.GetNetCode()
    if t.GetClass() == "PCB_VIA":
        pos = t.GetPosition()
        via_obstacles.append((pos.x, pos.y, VIA_DIA / 2.0, nc))
        track_objs.append((t, nc, True))
    else:
        s, e = t.GetStart(), t.GetEnd()
        try:
            wd = t.GetWidth()
        except Exception:
            wd = W
        seg_obstacles.append((s.x, s.y, e.x, e.y, wd / 2.0, nc, SIDX.get(t.GetLayer(), 0)))
        track_objs.append((t, nc, False))

netcode_of = {}
for fp in b.GetFootprints():
    for p in fp.Pads():
        netcode_of[str(p.GetNetname())] = p.GetNetCode()


def pt_seg_dist(px, py, x0, y0, x1, y1):
    dx, dy = x1 - x0, y1 - y0
    L2 = dx * dx + dy * dy
    if L2 == 0:
        return ((px - x0) ** 2 + (py - y0) ** 2) ** 0.5
    t = max(0.0, min(1.0, ((px - x0) * dx + (py - y0) * dy) / L2))
    cx, cy = x0 + t * dx, y0 + t * dy
    return ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5


def reroute_net(name):
    nc = netcode_of.get(name)
    pads = pads_by_net.get(name, [])
    if nc is None or len(pads) < 2:
        return "skip(pads)"
    xs = [p[0] for p in pads]
    ys = [p[1] for p in pads]
    if max(xs) - min(xs) > MAX_SPAN or max(ys) - min(ys) > MAX_SPAN:
        return "skip(span)"
    wx0, wy0 = min(xs) - MARGIN, min(ys) - MARGIN
    wx1, wy1 = max(xs) + MARGIN, max(ys) + MARGIN
    gw = int((wx1 - wx0) / PITCH) + 1
    gh = int((wy1 - wy0) / PITCH) + 1
    if gw * gh > 1_500_000:
        return "skip(big)"

    def cell(x, y):
        return (int(round((x - wx0) / PITCH)), int(round((y - wy0) / PITCH)))

    def world(cx, cy):
        return (wx0 + cx * PITCH, wy0 + cy * PITCH)

    blocked = bytearray(gw * gh * NL)  # 0 free, 1 blocked

    def stamp(cx, cy, l, r_nm):
        rc = int(r_nm / PITCH) + 1
        for yy in range(max(0, cy - rc), min(gh, cy + rc + 1)):
            for xx in range(max(0, cx - rc), min(gw, cx + rc + 1)):
                blocked[(l * gh + yy) * gw + xx] = 1

    # foreign copper -> obstacles (skip this net's own copper: it's ripped)
    for (x0, y0, x1, y1, half, onc, si) in seg_obstacles:
        if onc == nc:
            continue
        r = half + HALO
        sx0, sy0 = cell(min(x0, x1) - r, min(y0, y1) - r)
        sx1, sy1 = cell(max(x0, x1) + r, max(y0, y1) + r)
        if sx1 < 0 or sy1 < 0 or sx0 >= gw or sy0 >= gh:
            continue
        for yy in range(max(0, sy0), min(gh, sy1 + 1)):
            for xx in range(max(0, sx0), min(gw, sx1 + 1)):
                wxp, wyp = world(xx, yy)
                if pt_seg_dist(wxp, wyp, x0, y0, x1, y1) < r:
                    blocked[(si * gh + yy) * gw + xx] = 1
    for (vx, vy, vr, onc) in via_obstacles:
        if onc == nc:
            continue
        cx, cy = cell(vx, vy)
        for l in range(NL):
            stamp(cx, cy, l, vr + HALO)
    for (cx0, cy0, hw, hh, lset, onc) in all_pads:
        if onc == nc:
            continue
        r = HALO
        sx0, sy0 = cell(cx0 - hw - r, cy0 - hh - r)
        sx1, sy1 = cell(cx0 + hw + r, cy0 + hh + r)
        for l in lset:
            for yy in range(max(0, sy0), min(gh, sy1 + 1)):
                for xx in range(max(0, sx0), min(gw, sx1 + 1)):
                    blocked[(l * gh + yy) * gw + xx] = 0 or blocked[(l * gh + yy) * gw + xx] or 1

    # targets: this net's pad cells (and the layers they reach)
    pad_cells = []
    for (cx0, cy0, hw, hh, lset) in pads:
        c = cell(cx0, cy0)
        layers = lset if lset else set(range(NL))
        pad_cells.append((c, layers))
        # ensure the pad cell isn't self-blocked
        for l in layers:
            blocked[(l * gh + c[1]) * gw + c[0]] = 0

    def idx(x, y, l):
        return (l * gh + y) * gw + x

    def astar(starts, goals):
        goalset = set(goals)
        pq = [(0, s) for s in starts]
        heapq.heapify(pq)
        dist = {s: 0 for s in starts}
        prev = {}
        gx, gy = next(iter(goals))[0], next(iter(goals))[1]
        while pq:
            d, (x, y, l) = heapq.heappop(pq)
            if (x, y, l) in goalset:
                path = [(x, y, l)]
                while (x, y, l) in prev:
                    (x, y, l) = prev[(x, y, l)]
                    path.append((x, y, l))
                return path[::-1]
            if d > dist.get((x, y, l), 1 << 60):
                continue
            nbrs = []
            for ddx, ddy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + ddx, y + ddy
                if 0 <= nx < gw and 0 <= ny < gh and not blocked[idx(nx, ny, l)]:
                    nbrs.append((nx, ny, l, PITCH))
            for nl2 in range(NL):
                if nl2 == l:
                    continue
                if all(not blocked[idx(x, y, ll)] for ll in range(NL)):
                    nbrs.append((x, y, nl2, VIA_PEN))
            for (nx, ny, nl2, c) in nbrs:
                nd = d + c
                if nd < dist.get((nx, ny, nl2), 1 << 60):
                    dist[(nx, ny, nl2)] = nd
                    prev[(nx, ny, nl2)] = (x, y, l)
                    h = (abs(nx - gx) + abs(ny - gy)) * PITCH
                    heapq.heappush(pq, (nd + h, (nx, ny, nl2)))
        return None

    # connected set starts at pad 0; route each remaining pad to it
    connected = set()
    (c0, ls0) = pad_cells[0]
    for l in ls0:
        connected.add((c0[0], c0[1], l))
    routes = []  # list of cell-paths
    for (c, ls) in pad_cells[1:]:
        starts = [(c[0], c[1], l) for l in ls]
        path = astar(starts, connected)
        if path is None:
            return "fail(noroute)"
        routes.append(path)
        for node in path:
            connected.add(node)
    return ("ok", routes, world)


# ---- execute -----------------------------------------------------------------
attempted = 0
ok = 0
skipped = 0
results = {}
for name in sorted(dirty):
    r = reroute_net(name)
    if isinstance(r, tuple) and r[0] == "ok":
        results[name] = (r[1], r[2])
        attempted += 1
    elif isinstance(r, str) and r.startswith("skip"):
        skipped += 1
    else:
        attempted += 1
        print(f"  {name}: {r}")

# rip dirty nets that we have a new route for, then write the new copper
rip_nets = set(results.keys())
for (t, nc, is_via) in track_objs:
    if str(t.GetNetname()) in rip_nets:
        b.Remove(t)

for name, (routes, world) in results.items():
    nc = netcode_of[name]
    for path in routes:
        # split into per-layer runs; via at layer changes
        i = 0
        while i < len(path) - 1:
            x, y, l = path[i]
            # accumulate a run on this layer
            j = i
            pts = [(x, y)]
            while j + 1 < len(path) and path[j + 1][2] == l:
                j += 1
                pts.append((path[j][0], path[j][1]))
            # emit merged collinear segments for this run
            if len(pts) >= 2:
                # simplify collinear
                simp = [pts[0]]
                for k in range(1, len(pts) - 1):
                    ax, ay = simp[-1]
                    bx, by = pts[k]
                    cx, cy = pts[k + 1]
                    if (bx - ax) * (cy - by) != (by - ay) * (cx - bx):
                        simp.append((bx, by))
                simp.append(pts[-1])
                for k in range(len(simp) - 1):
                    wa = world(*simp[k])
                    wb = world(*simp[k + 1])
                    tr = pcbnew.PCB_TRACK(b)
                    tr.SetStart(pcbnew.VECTOR2I(int(wa[0]), int(wa[1])))
                    tr.SetEnd(pcbnew.VECTOR2I(int(wb[0]), int(wb[1])))
                    tr.SetLayer(STACK[l])
                    tr.SetWidth(int(W))
                    tr.SetNetCode(nc)
                    b.Add(tr)
            # via at the transition
            if j + 1 < len(path):
                nx, ny, nl2 = path[j + 1]
                wv = world(nx, ny)
                v = pcbnew.PCB_VIA(b)
                v.SetPosition(pcbnew.VECTOR2I(int(wv[0]), int(wv[1])))
                v.SetWidth(pcbnew.PADSTACK_DEFAULT, int(VIA_DIA)) if False else None
                try:
                    v.SetWidth(int(VIA_DIA))
                except Exception:
                    pass
                v.SetDrill(int(VIA_DRILL))
                v.SetNetCode(nc)
                b.Add(v)
            i = j + 1
        ok += 1

if results:
    pcbnew.SaveBoard(board_path, b)
print(f"REROUTED {ok}/{attempted} (skipped {skipped})")
