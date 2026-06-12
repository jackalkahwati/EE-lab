# FL-1 Relay/Probe Matrix — PCBA Rev A

Electronics project for the FirstLight FL-1 custom board (architecture and
requirements: `relay-probe-matrix-rev-a.md` in this directory).

## Toolchain — same stack as resonant-computer Tile-0

Mirrors `github.com/jackalkahwati/resonant-computer/Tile-0/elec` exactly:

1. **atopile** — schematics as code. `elec/src/*.ato` modules compile to a
   KiCad netlist (`ato build`). Project config: `ato.yaml`.
2. **KiCad 8** — layout in `elec/layout/`, ERC/DRC, custom design rules.
3. **kicad-mcp** — AI-driven placement/routing seeded by
   `elec/layout/.kicad-mcp/project_spec.json` (critical nets, analog
   island, placement intent, 160x100 mm 4-layer outline).
4. **Output pipeline** (as Tile-0 `output/`): gerbers, `bom.csv`,
   `pick_and_place.csv`, `board.step`, ERC/DRC JSON reports, quality-gate
   JSONs, stackup profile.

## Module map

| File | Module | Content |
|---|---|---|
| `main.ato` | `MatrixRevA` | Top level: composition + connectors J2/J20-J24 |
| `power.ato` | `PowerTree` | 24V in -> 5V coil (INA219 shunt) -> 3V3 dig/ana |
| `matrix.ato` | `Matrix`, `LaneSelector` | 8 trees x 11 relays (G6K-2F-Y + reed) |
| `protection.ato` | `ProbeProtection`, `ReferenceBlock` | PTC/TVS/steering, window comparator pre-connect check, cal references |
| `mcu.ato` | `Control` | RP2040 + USB-C + 12x TPIC6B595 + TPS3823 watchdog |
| `cartridge.ato` | `CartridgeInterface` | J10 blind-mate, ID I2C, presence detect |

## Build

```sh
uv tool install atopile          # needs Python >= 3.11
cd hardware/pcba-rev-a
ato build                        # compile -> netlist for KiCad sync
```

## Status / known gaps (Rev A bring-up list)

- `.ato` syntax follows Tile-0's atopile ^0.2 conventions; current atopile
  releases changed the language — expect a migration pass on first
  `ato build` (pin the toolchain or port syntax; whichever is less work).
- Pin maps on RP2040 QSPI flash and TPS54331 are abbreviated; finalize at
  netlist sync against real symbols (Tile-0 pattern: vendor symbols pulled
  into `output/symbols/`).
- +/-15V clamp rails: source TBD (charge pump vs external) — net stubs in
  `main.ato`, decision before layout.
- J1 USB-C lives in `mcu.ato` (control); J11 MMCX bypass and J25 chassis
  stud are panel-mount, not board-mount — excluded from the netlist.
- 91 coil channels mapped to 96 sink bits; channel map doc goes in
  firmware (`software/station` driver + RP2040 firmware share it).
