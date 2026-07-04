# FL-1 DFM Screen — Rev A (2026-07-03)

Honest scope statement: **a formal DFM pass had not been run before
this.** The EVT freeze deliberately deferred full DFM/DFA to DVT; what
existed was materials/PNs/finishes (Phase C), MBD sheets at ISO 2768-mK
with critical-feature callouts (Phase D), and process assignments in the
RFQ. This screen is a bbox/process-level review of every fabricated
part plus judgment flags — feature-level DFM (corner radii, bend
reliefs, tolerance stacks) still happens with vendors at DVT.

Verdicts: ✅ fine as specced · ⚠ flagged, fix noted · 🔴 fixed today.

| PN | Part | Process | Verdict | Notes |
|---|---|---|---|---|
| EE-FAB-FRAME | Base Frame | 6063 extrusion | 🔴 | Was solid 40×80 bar (20.2 kg). **Hollowed today to 4080-class twin-channel profile (6 mm walls + mid web), 12.45 kg**; corners + rail-support junctions left solid (act as joint closeouts). Drawer-tunnel top chord 8 mm — reinforce at DVT. |
| EE-FAB-BPAN | Enclosure Base Pan | 2 mm 5052 sheet | ⚠ | 940×920 flat at 2 mm = aspect 470:1 — will oil-can. D3 specced two stiffening beads; **never modeled**. Add beads or step to 2.5 mm at DVT. |
| EE-FAB-TRAY | Equipment Tray | 3 mm 5052 sheet | ⚠ | 870×730 at 3 mm, aspect ~290:1 — borderline; instrument feet load it. Flange edges (modeled flat) or add one center bead. |
| EE-FAB-TOP | Top Slab | CNC 6061, 30 thk | ⚠ | 920×870×30 from billet = huge hog-out (>80% chip). For EVT one-off it's money, not risk; for production switch to cast tooling plate skin-cut, or ribbed sheet weldment under a thin Class-A skin. |
| EE-FAB-SHL | Side Shells | CNC (EVT) / molded (prod) | ✅ | 5 mm wall ok both routes; corner bosses solid (feet inserts land there); stadium vent slots fine for CNC and molding. |
| EE-FAB-FSC | Plinth Fascia | 5052 sheet | ✅ | Laser etch + paint-fill callout on the drawing; aperture corners want R3 min (note added). |
| EE-FAB-FIXP | PCB Fixture Plate | CNC 6061, 18 thk | ✅ | 269× Ø4.2 grid = simple drill cycle; hole-edge margin 35 mm; chem-film per ESD spec. Flatness 0.05 callout already on sheet. |
| EE-FAB-STDF | Fixture Standoffs | CNC | ✅ | Simple turned/milled; chem-film. |
| EE-FAB-DRWTRAY→POST | Drawer rails/posts | CNC 6061 | ✅ | Prismatic, small. |
| EE-FAB-DRWRAIL | Drawer support rails | CNC | ✅ | — |
| EE-FAB-DOORRAIL | Door edge rails | 6063 extrusion | ✅ | True extrusion profile, cut + anodize; bond+screw to PMMA leaf. |
| EE-FAB-GLZ | Door leaf (amber PMMA) | Laser/waterjet | ⚠ | 750×424 at 4 mm with edge rails is stiff enough closed; check thermal bow near warm chamber at DVT (PMMA CTE); 5 mm upgrade path exists. |
| EE-FAB-STRTBKT | Strut brackets | CNC | ✅ | — |
| EE-FAB-ZSTOP | Z stop collars | CNC steel | ✅ | Hard-stop load path is compressive; black oxide. |
| EE-FAB-JNL | Screw journals | Turned steel | ✅ | 2 mm float trims already cut; concentricity callout on sheet. |
| EE-FAB-ARM/PHD/CLMP/CRDL/RACK etc. | Probe/fixture machined set | CNC 6061 | ✅ | Small prismatic parts; H7 bores called out on sheets; deburr notes present. |
| EE-CAL-FID/TOP/FCP | Calibration assets | CNC | ✅ | Touch-off pad hardening callout present. |
| EE-FAB-CAMBKT | Camera bracket posts/beam | CNC 6061 | ⚠ | Posts now 364 mm long after the +124 raise — check straightness/whip; consider 6063 box extrusion instead of billet. |
| EE-FAB-BAF/TRIM/DUTIF/DSPBZL | Sheet + bezel set | Sheet/CNC | ✅ | — |

**Top open DFM items (DVT backlog, in priority order):**
1. Base pan stiffening beads (or 2.5 mm) — flagged above, biggest ship-risk.
2. Drawer-tunnel top chord reinforcement (8 mm chord in the hollowed member).
3. Top slab production process decision (cast plate vs weldment).
4. Camera post section change after the +124 raise.
5. Vendor feature-level DFM on the drawing set (radii, reliefs, stacks).
