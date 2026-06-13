# Zone-rail stitching — FL-1 Rev A

flroute deliberately skips the two zone-served nets — `lv` (low-voltage logic
supply, poured on In1.Cu + B.Cu) and `sel_p4-coil_bus-hv` (relay coil rail,
poured on In2.Cu) — because the pours are meant to carry them. But those pours
live on inner/bottom layers while the nets' **145 SMD pads sit on F.Cu**, so
each pad needs a stitching via down to its plane. `scripts/stitch_vias.py`
adds them.

## Result

| | before stitch | after stitch |
|---|---|---|
| zone-net unconnected | 157 | **24** |
| stitch-introduced DRC defects | — | **0** (delta vs baseline, every type) |
| zone SMD pads connected | 0/145 | **136/145** |

136 pads stitched: 76 via-in-pad (same-net via fully inside the host pad —
merges on F.Cu, adds no copper, so it cannot create a new clearance defect),
60 fanout (a standard via in the nearest open spot, joined by a short
collision-checked F.Cu stub).

Every via honors the board rules: ≥ 0.5 mm diameter / 0.3 mm drill, 0.5 mm
copper-edge clearance, 0.25 mm hole-to-hole, and full layer-aware clearance
to other-net copper on **every layer the through-via punches** (the early bug
was checking only F.Cu and shorting to inner-layer routing — 109 shorts).

Tightening the zone fill clearance from the shipped 0.5 mm to 0.25 mm (lv) /
0.3 mm (hv coil) — both still above the 0.2 mm design rule — let the planes
flood through track gaps and reconnected several dead islands.

## The residual 24 (why it is structural, not a stitcher defect)

- **9 pads** have no legal via location within 3 mm on any layer: they are IC
  power/GND pins (U1.2, U9.19, U12.19, U13.11, U14.11) and a few R/relay pads
  boxed in by routing on all four layers. Pour clearance cannot help — there
  is simply no open copper for a via.
- **~15** are pads stranded on, or fragments of, isolated pour islands: pieces
  of a plane walled off from the main body by routed tracks on that same inner
  layer.

Both reduce to one architectural choice: **In1/In2 serve as both routing and
plane layers.** flroute needed all four layers to hit 174/174, which swiss-
cheeses the planes. The fix is a design decision, not more stitching heuristics:

1. **6-layer stackup** — 2 outer signal, 2 solid planes, 2 inner signal. Planes
   stay solid; every pad stitches with a trivial via-in-pad. Cleanest; +fab cost.
2. **Solid In1/In2 planes, route only F.Cu + B.Cu** — planes never fragment,
   but routing drops to 2 layers (flroute got 150/174 there) so the board must
   grow or parts must spread out.
3. **Keep the 4-layer board, hand-finish the 9 pins** — re-route the few tracks
   boxing them in, or jog a short connection. Lowest cost for EVT; ~1 hr manual.

For EVT, option 3 is the pragmatic call. The 9 pins and island list are emitted
by `stitch_vias.py` on every run.

## Run

```
# from pcba-rev-a/, KiCad bundled python:
PY=/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3
$PY -c "import pcbnew; b=pcbnew.LoadBoard('elec/layout/rev-a-routed.kicad_pcb'); \
        pcbnew.ImportSpecctraSES(b,'/tmp/flroute.ses'); \
        pcbnew.ZONE_FILLER(b).Fill(b.Zones()); pcbnew.SaveBoard('elec/layout/rev-a-routed.kicad_pcb',b)"
$PY scripts/stitch_vias.py
kicad-cli pcb drc elec/layout/rev-a-routed.kicad_pcb
```
