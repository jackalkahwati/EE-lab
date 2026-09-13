# Planner CI KiCad library inputs

`hardware/planner/ci_toolchain.py` is an offline, fail-closed preflight. Run it
before pytest and before importing planner modules, which cache library paths.
It requires explicit absolute `FL_KICAD_SYMBOLS` and `FL_KICAD_FOOTPRINTS`
directories. Missing files, changed bytes, missing symbols, changed inherited
bases, and wrong pin counts fail with exit status 1, never a test skip.

## Exact provenance

Both public upstream repositories are pinned to the peeled `10.0.1` tag commits:

| Repository | Commit |
| --- | --- |
| `https://gitlab.com/kicad/libraries/kicad-symbols` | `7058584a0fbe9aa2f1c9ff2acf7847726ff6922c` |
| `https://gitlab.com/kicad/libraries/kicad-footprints` | `3d2b27e687a44c97f02109afb2acfeebbc8dd75f` |

On 2026-09-13, 35 named footprint files (251,541 bytes) and 33 named symbol
source files including inherited bases (176,617 bytes) were fetched at those
immutable raw URLs. All footprint bytes and all extracted symbol blocks matched
the installed Mac copies. The Mac CLI and application plist independently report
10.0.1; that application version alone was **not** treated as library provenance.
No full library installation or copy was performed on the Mac.

Print the complete machine-readable list of inspected source paths and SHA256s:

```sh
python3 hardware/planner/ci_toolchain.py --manifest
```

Each footprint hash covers the entire upstream file. Each symbol entry records
both the upstream source-file hash and the exact symbol-block hash preserved in
the packed library. The preflight validates packed blocks, including inherited
bases, not an unverified whole-library hash. This is bounded dependency coverage,
not attestation of every file in an installed KiCad distribution.

## KiCad 10 symbol packing is required

The upstream 10.x symbols repository contains
`<Library>.kicad_symdir/<Symbol>.kicad_sym`, not root-level packed
`<Library>.kicad_sym` files. Pointing `FL_KICAD_SYMBOLS` at a raw checkout fails
this preflight and the current production resolver.

The pinned upstream `README.md`, `CMakeLists.txt`, and
`tools/kicad_lib_pack.py` were inspected. The official packer uses Python's
standard library, requires Python 3.10 or newer, sorts source files and symbols,
and preserves their blocks. No KiCad binary, pcbnew binding, geometry synthesis,
or custom replacement symbols are needed to pack libraries.

The following setup is intended for a clean CI runner with sufficient disk
space, not the disk-constrained Mac. The full-repository fetch/packing sequence
was not run locally; the named dependency fetches and local preflight were.
Use fresh destinations so cached or untracked files cannot affect resolution.

```sh
set -eu
ROOT="$(mktemp -d)"
SYMBOLS="$ROOT/symbols-source"
FOOTPRINTS="$ROOT/footprints"

git init "$SYMBOLS"
git -C "$SYMBOLS" remote add origin https://gitlab.com/kicad/libraries/kicad-symbols.git
git -C "$SYMBOLS" fetch --depth=1 origin 7058584a0fbe9aa2f1c9ff2acf7847726ff6922c
git -C "$SYMBOLS" checkout --detach FETCH_HEAD
test "$(git -C "$SYMBOLS" rev-parse HEAD)" = 7058584a0fbe9aa2f1c9ff2acf7847726ff6922c
python3 "$SYMBOLS/tools/kicad_lib_pack.py" --input "$SYMBOLS" --output "$ROOT/symbols-packed"

git init "$FOOTPRINTS"
git -C "$FOOTPRINTS" remote add origin https://gitlab.com/kicad/libraries/kicad-footprints.git
git -C "$FOOTPRINTS" fetch --depth=1 origin 3d2b27e687a44c97f02109afb2acfeebbc8dd75f
git -C "$FOOTPRINTS" checkout --detach FETCH_HEAD
test "$(git -C "$FOOTPRINTS" rev-parse HEAD)" = 3d2b27e687a44c97f02109afb2acfeebbc8dd75f

export FL_KICAD_SYMBOLS="$ROOT/symbols-packed"
export FL_KICAD_FOOTPRINTS="$FOOTPRINTS"
python3 hardware/planner/ci_toolchain.py
python3 -m pytest -q hardware/planner
```

No packages3d download is needed. This preflight does not claim that text-based
planner tests require kicad-cli or pcbnew, nor that it validates binary-based
board generation, rendering, or DRC. Those stages need separate compatible
binary checks. Existing deployment Dockerfile references to KiCad 8 are not
proof that it can consume these KiCad 10 library files.

## Bounded required inputs

Every `planner.run` builds the entire seed list, even for a single requested
part. The checked symbol families are therefore broader than BME280 alone:

`74xx`, `Analog_ADC`, `Analog_DAC`, `Battery_Management`, `Connector`,
`Driver_Motor`, `FPGA_Lattice`, `Interface_Expansion`, `Interface_UART`, `LED`,
`Logic_LevelTranslator`, `MCU_RaspberryPi`, `Memory_EEPROM`, `Memory_Flash`,
`Reference_Voltage`, `Regulator_Linear`, `Regulator_Switching`, `Sensor`,
`Sensor_Energy`, `Sensor_Motion`, `Timer_RTC`, `Transistor_Array`.

The exact footprint list is `FOOTPRINTS` in the preflight. It covers seed
resolution and the native connector/STM32/BME280/ULN2803 synthesis paths, plus
direct legacy ingestion, chipdown, inherited-symbol, multi-rail, and BGA checks.
Notable required files include:

* `Module:RaspberryPi_Pico_SMD_HandSolder`
* `TerminalBlock:TerminalBlock_MaiXu_MX126-5.0-02P_1x02_P5.00mm`
* `Connector_PinHeader_2.54mm:PinHeader_2x03_P2.54mm_Vertical`
* `Connector_PinHeader_2.54mm:PinHeader_2x05_P2.54mm_Vertical` for ULN2803 outputs
* `Package_QFP:LQFP-48_7x7mm_P0.5mm`
* `Package_SO:SOIC-18W_7.5x11.6mm_P1.27mm`
* `Package_LGA:Bosch_LGA-8_2.5x2.5mm_P0.65mm_ClockwisePinNumbering`

This is not a proof of the smallest sufficient download for the complete
planner suite. Broad symbol substring matching and footprint ranking inspect
other installed candidates; a reduced catalog can change selected components.
CI should fetch both complete pinned repositories, pack the symbols, and use
the bounded preflight as an early diagnostic. Legacy saved-board artifacts are
separate dependencies; the preflight neither reads nor manufactures them.

## Validation and path findings

Local validation passed the full preflight and the native
`test_requested_connector_row_starts_past_the_test_points` test against installed
real libraries. Negative checks confirmed exit failure for missing environment,
an empty footprint root, modified footprint bytes, and a missing exact symbol.
No installed library was modified for those checks.

Path issues observed in existing production code, not changed by this work:

* `resolve_part._find_symbol_file` expects flat `.kicad_sym` files and calls
  `os.listdir` without guarding a nonexistent symbol root. An unpacked KiCad 10
  checkout resolves no symbols; an absent root raises `FileNotFoundError`.
* `resolve_part._fp_index` likewise raises on a missing footprint root.
* `compose._load` reads exact `<lib>.pretty/<name>.kicad_mod` paths. Missing MCU,
  passive, or requested connector footprints can escape `synth` as exceptions;
  only the generic per-device placement loop catches its missing-file failures.
* Defaults in `hardware/blocks/toolchain.py` are Mac application paths. Linux
  must set both library environment variables before importing these modules.

Do not fix missing-library failures by skipping tests, inventing footprint
geometry, or copying unrelated private run data.

## Remaining release gates (2026-09-13)

Local Python 3.11 validation passed 33 snapshot/collection tests and all 17
requested-parts pytest tests. The latter ran inside a guarded source snapshot
with these read-only installed libraries. Pytest logging was disabled for that
nested invocation because its default `/dev/null` write is outside the guard's
write policy; the guard itself was not weakened. Local pytest was 9.1.1, while
CI pins 8.4.2, so GitHub execution is a separate required verification.

All 62 legacy scripts were executed independently through the guarded bridge:
5 passed and 57 failed. C2, M3 and M9–M12 now generate their own report inputs;
benchmark/signoff and validation pass their synthetic policy checks but still
fail separate historical linkage checks. Missing artifacts remain failures, not
skips. The manifest inventories 1,025 static check sites, **not** 1,025 executed
assertions: scripts that stop on missing inputs do not reach later checks.

Versioned-source research found an original calibration-board emitter and
power-entry architecture inputs, but not complete input recipes for the later
calibration v3/v4 variants or exact historical core-board component choices.
Representative remaining dependencies include genuine calibration finegrid/DRC
outputs, `fl1-core-controller` and `fl1-core6-bare-rp2040-combination-v1` boards,
backplane routing evidence, and the saved realboard replay inputs. Expected
report fields and golden counters cannot substitute for those source boards.

The snapshot only permits copied Python children. Native KiCad/router/ngspice
integration is not provisioned by this harness or the library-fetch step and
must not be claimed as executed coverage. The release remains blocked until
required historical inputs and real-tool coverage are restored and all CI
checks pass. No production deployment follows from the partial results above.
