# Thermal Analysis — Bring-Up Station Enclosure

Date: 2026-06-11. First-principles heat budget + ventilation sizing for the
flagship enclosure (870 × 920 × 482 mm, smoked front glass, R30 side shells).
Verdict up front: **passive cooling is fine for idle/motion, but full-test
load requires fans, and the current vent holes are in the wrong place for
the job they need to do.**

## 1. Heat budget

Sources from `flagship-cots-sourcing-bom.md` (sustained dissipation inside
the enclosure, worst case):

| Source | Idle / motion | Full test |
|---|---|---|
| Fanless industrial PC (i5/i7, 24 VDC) | 45 W | 45 W |
| Galil DMC-4133 motion controller | 10 W | 10 W |
| 3× ClearPath-SD NEMA 23 servos | 15 W (hold) | 45 W (active duty) |
| 75 V motor bus PSU loss | 8 W | 8 W |
| 24 V control PSU loss | 8 W | 8 W |
| Cameras, LED light bar, sensors, relays | 15 W | 15 W |
| USB hub + misc | 5 W | 5 W |
| DUT power supply conversion loss | — | 35 W |
| **Electronic load sinking DUT output** | — | **120 W** |
| Scope/DMM/DAQ instrument modules | — | 40 W |
| **Total** | **~106 W** | **~331 W** |

With the 300 W-class COTS e-load (NI PXIe-4051) at full sink instead of the
120 W custom board, full-test rises to **~511 W**. The e-load is the
dominant and most concentrated source — it dissipates the *entire* DUT
output power as heat, by design.

## 2. What the enclosure can shed passively

Sealed-enclosure rule of thumb (combined convection + radiation,
h ≈ 5.5 W/m²K) over the 2.53 m² of exposed skin:

| Internal rise ΔT | Passive capacity |
|---|---|
| 10 °C | 139 W |
| 15 °C | 208 W |
| 20 °C | 278 W |
| 25 °C | 347 W |

Electronics want ≤ 45–50 °C internal ambient in a 25 °C room, i.e. ΔT ≤ 20 °C.

- **Idle/motion (106 W): passive is fine** — settles around ΔT ≈ 12 °C.
- **Full test (331 W): not fine** — sealed equilibrium is ΔT ≈ 24 °C *if heat
  were uniformly distributed, which it is not*; the e-load corner runs far
  hotter. With the 300 W COTS load (511 W) the enclosure is unambiguously
  over budget.

## 3. The current vent holes don't help

Current geometry: 132 Ø5 mm holes per side, 16 mm grid, **Y −420..−260
(front portion of the sides), Z 240..420 (high, chamber height)**.
Open area: 25.9 cm² per side, 51.8 cm² total.

Three problems:

1. **No stack effect.** Both fields are at the same height, so the only
   chimney driver is the half-height of the field itself (~90 mm). Computed
   natural draft: 0.29 m/s, ~0.5 L/s → removes **~8 W**. Effectively
   decorative. Even moved ideally (intake at the base, ΔH = 300 mm) the same
   open area only buys ~15 W.
2. **Wrong compartment.** They ventilate the *probe chamber*. The heat lives
   in the electronics bay (base pan / plinth and rear bay): PC, PSUs,
   controller, e-load, instruments.
3. **Airflow through the chamber corrupts thermal inspection.** The FLIR
   Lepton 3.5 anomaly-detection pass (`hardware-expansion-spec.md` §4)
   needs still air over the DUT — forced draft across the chamber adds
   convective cooling that masks hot spots. The chamber should be a
   still-air zone during test, which is exactly when heat load peaks.

## 4. Forced-air sizing

CFM = Q / (ρ·cp·ΔT):

| Load | ΔT = 10 °C | ΔT = 15 °C |
|---|---|---|
| 255 W (full test minus passive skin) | 45 CFM | 30 CFM |
| 435 W (300 W e-load case minus skin) | 76 CFM | 51 CFM |

Pushing 60 CFM through the existing 51.8 cm² of holes means 5.5 m/s face
velocity — above the ~3 m/s whistle/backpressure threshold. Intake area
must grow to **≥ 113 cm²** to stay under 2.5 m/s.

## 5. Recommendations

**Add fans — required, not optional:**

- **2× 120 mm filtered exhaust fans on the rear panel**, high in the
  electronics bay (the Rear Vent Baffle zone already exists in the CAD).
  Industrial 120 mm fans (ebm-papst/Delta, ~100 CFM free air) derate to
  ~50 % with filters → ~100 CFM net for the pair: covers the 76 CFM worst
  case with margin. PWM off the interlock/utility board (already in the
  BOM as the fan aggregator), thermostatically idle-stopped so the machine
  is silent between tests.
- **Dedicated heatsink + fan (or duct to the exhaust path) on the
  electronic load board.** 120–300 W concentrated in one board cannot ride
  on bay ambient. This matches the BOM note "thermal management" on the
  custom load board.

**Move/extend the vent holes:**

- **Add low intake fields**: same Ø5 / 16 mm-grid visual language, both
  sides at plinth level (Z 40..160), front-biased — sized so total intake
  ≥ 113 cm² (≈ 290 additional holes per side, or relax to Ø6 to cut count).
  Airflow path becomes: low-front intake → across electronics bay → rear-high
  exhaust. Cool air washes the PC/PSUs/e-load directly.
- **Keep the existing high side fields** as passive chamber relief — they
  read well cosmetically and let the chamber breathe between tests — but
  seal the chamber from the fan path (the base pan is the divider) so the
  probing volume stays still-air for the thermal camera.

**Net verdict:** yes to fans (2× 120 mm rear exhaust + load-board spot
cooling), yes to new low intake vents at plinth level; the existing high
vents stay but are reclassified as passive chamber relief, not the cooling
path.

## 6. Implemented in CAD (2026-06-11)

`tools/onshape/thermal_pass.py` executed against the live model:

- **Thermal - Intake Vents Cut v2** — 200 Ø6 holes per side (16 mm grid,
  25 × 8, Y −420..−36, Z −276..−164) through both side shells at
  electronics-bay level. Total intake 113 cm².
- **Thermal - Fan Cutouts Cut** — 2× Ø116 openings + 4× Ø4.5 mounts on a
  105 mm square, Rear Matte Black Panel, centers (±220, Z −75).
- **Exhaust Fan 120mm L/R + hubs** — placeholder fan frames
  (120×120×25, Ø112 face pocket, Ø36 hub) behind the cutouts.

Residue to delete in the UI when the GET /features rate limit clears:
sketch `Thermal - Intake Vent Holes` + the two INFO no-op cuts from the
first (mm-unit) run — see thermal_pass.py docstring.

## 7. Assumptions / sensitivity

- Servo dissipation assumes bring-up-station duty (point moves + dwell),
  not continuous contouring. ClearPath-SD integrated drives keep drive
  loss in the motor envelope — vented bay air is the spec'd cooling.
- Bench-prototype configuration (SPD1305X in the service bay) self-cools
  with its own fan but still dumps its loss into the bay — included in the
  35 W PSU-loss line.
- h = 5.5 W/m²K is the standard sealed-cabinet figure for painted metal;
  plastic shells run lower, which only strengthens the fan conclusion.
- If the production custom e-load board caps at 150 W, the full-test load
  is ~360 W — still ~150 W over passive capacity at ΔT 15 °C. The fan
  requirement is robust to every parameter in this analysis.
