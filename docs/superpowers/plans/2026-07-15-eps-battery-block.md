# EPS Battery Block Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `block_eps` compose block — single-cell Li-ion charging (TP4056), pack protection (DW01A + FS8205A), 3.3V regulation from the battery (AP2112K-3.3), JST-PH battery connector, charge-status LEDs — so "battery powered" prompts produce a DRC-clean board that charges from USB-C and runs from the cell.

**Architecture:** Follows the proven hardcoded-block pattern (like `block_mcu_esp32c3`): pin maps verified against fetched datasheet pins BEFORE trust, footprints served by the shared registry via easyeda2kicad (real pad geometry), honesty entry in the devices manifest. Protection sits in the battery-negative line (industry-standard DW01/8205 topology). The EPS provides +3V3 via its own LDO; +5V exists only when a USB inlet co-exists (charge path). Fuel gauge is NOT hand-wired — a prompt naming one (e.g. MAX17048) rides the existing catalog/I2C sourced-part path with its verification ladder.

**Tech Stack:** compose.py block system, tools/parts registry (SQLite, easyeda2kicad), the production chain (export_dsn → flroute → import_ses → stitch → kicad-cli DRC), KiCad 10 python for verification.

**Honest v1 limits (state them in the devices manifest, do not hide):**
- LDO regulation: +3V3 valid while VBAT ≥ ~3.55V (AP2112 dropout). Buck-boost full-cell-range regulation is a follow-on.
- No solar/MPPT input (CubeSat EPS variant adds it later).
- Charge current fixed by PROG resistor (2kΩ → ~580 mA), documented on silk.

---

### Task 1: Locate and pin-verify the four parts in the shared registry

**Files:**
- Create: `tools/blocks/tests/eps_parts_check.py`
- Registry DB: `tools/parts/registry.sqlite` (writes via CLI, no schema change)

- [ ] **Step 1: Find the catalog entries (the 684k-part catalog is local)**

```bash
cd "/Volumes/T9 Backup/EE-lab"
python3 tools/parts/registry.py search "TP4056"   | head -5
python3 tools/parts/registry.py search "DW01"     | head -5
python3 tools/parts/registry.py search "FS8205"   | head -5   # also try "8205A"
python3 tools/parts/registry.py search "AP2112K-3.3" | head -5
```

Expected: each search returns at least one in-stock hit with an LCSC id (Cxxxxx). Record the four ids. Likely candidates: TP4056 → C16581, AP2112K-3.3 → C51118; take DW01A and FS8205A ids from the search output — do NOT guess them.

- [ ] **Step 2: Fetch real footprints into the registry (easyeda2kicad path)**

```bash
for ID in <TP4056_ID> <DW01A_ID> <FS8205A_ID> <AP2112_ID>; do
  python3 tools/parts/registry.py save-footprint "$ID"
  python3 tools/parts/registry.py footprint "$ID" | head -1   # non-empty = stored
done
```

Expected: each prints a `(footprint` or `(module` header line. (`_upgrade_mod` in compose.py normalizes legacy `(module` at load time — no action needed.)

- [ ] **Step 3: Write the pin-anchor verification script**

The block code in Task 2 hardcodes pin maps. This script makes the datasheet the authority: it fetches each part's pins through the existing datasheet path and asserts the anchors the block relies on. Wrong anchor = loud failure BEFORE any board is composed.

```python
# tools/blocks/tests/eps_parts_check.py
"""EPS block pin-anchor verification — run before trusting Task 2's pin maps.

Fetches datasheet pins via the registry/datasheet path used by source_part
and asserts the exact pins block_eps wires. A mismatch means the sourced
package differs from the plan's assumption: STOP and fix the pmap.
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "parts"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "hardware", "blocks"))
import registry

# id -> {pin_number: expected_name_regex}
ANCHORS = {
    "<TP4056_ID>": {"3": "GND", "4": "VCC", "5": "BAT", "2": "PROG"},
    "<DW01A_ID>":  {"1": "OD",  "2": "CS",  "3": "OC",  "5": "VCC", "6": "GND"},
    "<FS8205A_ID>": {},   # fill from datasheet in Step 4 — dual-FET pinouts vary by package
    "<AP2112_ID>": {"1": "VIN", "2": "GND", "3": "EN", "5": "VOUT"},
}

import re
fail = 0
for pid, anchors in ANCHORS.items():
    e = registry.get(pid)
    pins = {str(p.get("number")): str(p.get("name", "")) for p in (e.get("pins") or [])}
    if not pins:
        print(f"{pid}: NO PINS in registry — run the datasheet fetch first"); fail += 1; continue
    for num, pat in anchors.items():
        got = pins.get(num, "<missing>")
        ok = re.search(pat, got, re.I)
        print(f"{pid} pin {num}: want /{pat}/ got {got!r} {'OK' if ok else 'FAIL'}")
        fail += 0 if ok else 1
sys.exit(1 if fail else 0)
```

- [ ] **Step 4: Populate pins + fill the FS8205A anchors from its real datasheet**

Run the existing datasheet-pin fetch (the same path `source_catalog` uses — see `hardware/blocks/source_part.py`, function that caches datasheet pins) for each of the four ids. Then open the FS8205A rows it stored, read the actual S1/G1/S2/G2/D pin numbers for the sourced package (SOT-23-6 and TSSOP-8 DIFFER), and fill the `ANCHORS["<FS8205A_ID>"]` dict and the Task 2 pmap accordingly.

Run: `python3 tools/blocks/tests/eps_parts_check.py`
Expected: every line `OK`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add tools/blocks/tests/eps_parts_check.py
git commit -m "eps: part discovery + datasheet pin-anchor verification"
```

---

### Task 2: block_eps in compose.py

**Files:**
- Modify: `hardware/blocks/compose.py` (insert block before `def block_imu`, same neighborhood as `block_som_carrier`)

- [ ] **Step 1: Write the block**

Substitute the four verified LCSC ids and the FS8205A pin numbers from Task 1. The FS8205A pmap below is written for the common SOT-23-6 (1=G1, 2=S1, 3=D1/D2 … whatever Task 1 verified) — USE THE VERIFIED NUMBERS, the letters here name the ROLES:

```python
def block_eps(x, y, n, nets):
    """Single-cell Li-ion EPS: TP4056 USB charger, DW01A+FS8205A pack
    protection in the battery-negative line, AP2112K-3.3 LDO so the BOARD
    RUNS FROM THE CELL, JST-PH cell connector, CHRG/STDBY LEDs.
    Pin maps are datasheet-anchor-verified (tools/blocks/tests/
    eps_parts_check.py) — never edit one without re-running it.
    HONEST LIMITS (also in the devices manifest): LDO 3V3 valid while
    VBAT >= ~3.55 V; charge current fixed ~580 mA (PROG 2k); no solar
    input in v1."""
    b = ""
    # charger: 5V (USB inlet) -> cell positive. TEMP tied to GND disables
    # the NTC function per datasheet; CE tied high = always enabled.
    b += place("registry", "<TP4056_ID>", _next_ref("U"), x + 6, y + 8, 0, {
        "4": "+5V", "3": "GND", "1": "GND", "8": "+5V",
        "5": "VBAT", "2": "EPS_PROG",
        "7": "EPS_CHRG_N", "6": "EPS_STDBY_N"}, nets)
    b += res(_next_ref("R"), x + 6, y + 14, "EPS_PROG", "GND", nets, value="2k")
    # status LEDs (existing statusled pattern: LED + series R to +5V)
    b += res(_next_ref("R"), x + 12, y + 14, "+5V", "EPS_LED_C", nets, value="1k")
    b += place("LED_SMD", "LED_0603_1608Metric", _next_ref("D"), x + 12, y + 17, 0,
               {"1": "EPS_CHRG_N", "2": "EPS_LED_C"}, nets)
    b += res(_next_ref("R"), x + 16, y + 14, "+5V", "EPS_LED_S", nets, value="1k")
    b += place("LED_SMD", "LED_0603_1608Metric", _next_ref("D"), x + 16, y + 17, 0,
               {"1": "EPS_STDBY_N", "2": "EPS_LED_S"}, nets)
    label("CHG FULL", x + 14, y + 19, 0.6)
    # protection: DW01A senses, FS8205A switches the NEGATIVE line.
    # Cell-side negative = EPS_BATT_N; board GND = pack negative.
    b += place("registry", "<DW01A_ID>", _next_ref("U"), x + 6, y + 22, 0, {
        "5": "EPS_DW_VCC", "6": "EPS_BATT_N",
        "1": "EPS_OD", "3": "EPS_OC", "2": "EPS_CS"}, nets)
    b += res(_next_ref("R"), x + 2, y + 22, "VBAT", "EPS_DW_VCC", nets, value="470")
    b += cap(_next_ref("C"), x + 2, y + 26, "EPS_DW_VCC", "EPS_BATT_N", nets)
    b += res(_next_ref("R"), x + 10, y + 26, "EPS_CS", "GND", nets, value="1k")
    b += place("registry", "<FS8205A_ID>", _next_ref("U"), x + 14, y + 22, 0, {
        "<G1>": "EPS_OD", "<S1>": "EPS_BATT_N",
        "<G2>": "EPS_OC", "<S2>": "GND",
        "<D1>": "EPS_FET_D", "<D2>": "EPS_FET_D"}, nets)
    # cell connector: pin1 = VBAT (cell +), pin2 = cell - (protected side)
    b += place("Connector_JST", "JST_PH_S2B-PH-K_1x02_P2.00mm_Horizontal",
               _next_ref("J"), x + 26, y + 8, 0,
               {"1": "VBAT", "2": "EPS_BATT_N"}, nets)
    label("BAT + -", x + 26, y + 3, 0.6)
    # regulation: the board runs from the cell
    b += place("registry", "<AP2112_ID>", _next_ref("U"), x + 24, y + 22, 0, {
        "1": "VBAT", "2": "GND", "3": "VBAT", "5": "+3V3"}, nets)
    b += cap(_next_ref("C"), x + 21, y + 26, "VBAT", "GND", nets, value="1uF")
    b += cap(_next_ref("C"), x + 27, y + 26, "+3V3", "GND", nets, value="1uF")
    _DEVICES.append({"ref": "(eps)", "type": "power", "family": "li-ion-1s",
                     "name": "EPS: TP4056 charge + DW01A/8205 protect + AP2112 3V3",
                     "honesty": "datasheet-anchor-verified pin maps; LDO 3V3 "
                                "valid while VBAT>=3.55V; ~580mA charge; no "
                                "solar input; protection in battery-negative "
                                "line — cell minus is EPS_BATT_N, NOT board GND"})
    return b, 34, 30
```

- [ ] **Step 2: Register the block**

In `BLOCK_TABLE` (after `"somcarrier": block_som_carrier,`):

```python
    "eps": block_eps,
```

In `ROW` add `"eps": 0,` and in `COL` add `"eps": 1,`.

In `CAPABILITIES` (after the somcarrier entry):

```python
    {"key": "eps", "label": "Battery EPS (single-cell Li-ion: USB charging, "
        "pack protection, 3.3V regulation from the cell, JST-PH connector; "
        "LDO valid while VBAT>=3.55V — buck-boost is a follow-on)"},
```

- [ ] **Step 3: Syntax check**

Run: `python3 -c "import sys; sys.path.insert(0,'hardware/blocks'); import compose; print('ok')"`
Expected: `ok`

- [ ] **Step 4: Commit**

```bash
git add hardware/blocks/compose.py
git commit -m "eps: single-cell Li-ion EPS block (charge/protect/regulate)"
```

---

### Task 3: Classifier — battery phrases route to eps, power dedup stays sane

**Files:**
- Modify: `hardware/blocks/compose.py` (`_block_keys`, `classify`)

- [ ] **Step 1: Write the failing classify test**

```bash
python3 - <<'EOF'
import sys; sys.path.insert(0, 'hardware/blocks'); import compose
cases = {
    'battery powered sensor node': 'eps',
    'lipo charging': 'eps',
    '18650 power': 'eps',
    'rechargeable tracker': 'eps',
}
bad = 0
for s, want in cases.items():
    ks = compose._block_keys(s)
    print(repr(s), '->', ks)
    bad += 0 if want in ks else 1
# eps present must suppress the auto 'power' inlet but count as a power source
keys, dropped, _ = compose.classify(['battery powered', 'bme280'])
print('classify:', keys)
bad += 1 if 'power' in keys else 0
bad += 0 if 'eps' in keys else 1
sys.exit(1 if bad else 0)
EOF
```

Expected now: FAIL (`eps` unknown).

- [ ] **Step 2: Implement keywords + dedup**

In `_block_keys`, ABOVE the final power check, add:

```python
    if any(k in s for k in ("battery", "batteries", "lipo", "li-ion", "lithium",
                            "18650", "charging", "charger", "rechargeable")):
        add("eps")
```

In the final power check, drop `"battery"` and `"charg"` from its keyword tuple (they now mean EPS), and change its guard to `if "usbc" not in out and "eps" not in out and any(...)`.

In `classify()`, next to the esp32c3/somcarrier dedups:

```python
    # the EPS IS the board's power source (3V3 from the cell) — drop the
    # auto power inlet; a USB-C inlet may still co-exist as the charge path
    if "eps" in seen and "power" in seen:
        uniq.remove("power")
        seen.discard("power")
```

And add `"eps"` to the power-baseline set: `if not (seen & {"power", "usbc", "eps"}):`.

- [ ] **Step 3: Re-run the Step 1 test**

Expected: all lines show `eps`, classify shows `eps` without `power`, exit 0.

- [ ] **Step 4: Commit**

```bash
git add hardware/blocks/compose.py
git commit -m "eps: classifier keywords + power-inlet dedup"
```

---

### Task 4: Netlist safety assertions (protection topology can never silently regress)

**Files:**
- Create: `tools/blocks/tests/eps_netlist_check.py`

- [ ] **Step 1: Write the checker (runs on a composed board, pre-route)**

```python
# tools/blocks/tests/eps_netlist_check.py
"""EPS safety topology assertions on a composed .kicad_pcb.
1. The cell's negative pin lands on EPS_BATT_N, NEVER directly on GND
   (that would bypass the protection FETs).
2. VBAT and +5V are distinct nets (no charger bypass).
3. The FS8205A has both gate nets (EPS_OD, EPS_OC) attached.
Run under KiCad python:  KPY eps_netlist_check.py <board>
"""
import sys
import pcbnew

b = pcbnew.LoadBoard(sys.argv[1])
nets = {}
for fp in b.GetFootprints():
    for p in fp.Pads():
        nets.setdefault(str(p.GetNetname()), []).append(
            "%s-%s" % (fp.GetReference(), p.GetNumber()))
fail = 0
jst = [t for n in ("EPS_BATT_N",) for t in nets.get(n, []) if t.startswith("J")]
if not jst:
    print("FAIL: no battery-connector pin on EPS_BATT_N (protection bypassed?)"); fail = 1
if not nets.get("VBAT"):
    print("FAIL: VBAT net missing"); fail = 1
if any(t in nets.get("GND", []) for t in jst):
    print("FAIL: battery negative tied to GND directly"); fail = 1
for g in ("EPS_OD", "EPS_OC"):
    if len(nets.get(g, [])) < 2:
        print("FAIL: %s not wired to both DW01A and FS8205A" % g); fail = 1
print("EPS netlist check:", "FAIL" if fail else "OK")
sys.exit(fail)
```

- [ ] **Step 2: Commit**

```bash
git add tools/blocks/tests/eps_netlist_check.py
git commit -m "eps: netlist safety assertions (protection topology)"
```

---

### Task 5: Full production-chain test (the real gate)

**Files:**
- Create: `tools/blocks/tests/eps_chain_test.sh`

- [ ] **Step 1: Write the chain script (same chain the pipeline runs)**

```bash
#!/bin/bash
# EPS end-to-end: compose -> export_dsn -> flroute -> import_ses ->
# stitch -> DRC -> stitch_to_plane -> re-DRC -> netlist safety.
set -e
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
KPY=/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3
KCLI=/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli
WD=$(mktemp -d)
printf '{"blocks": ["usb-c power", "battery powered", "bme280 environmental sensor"]}' > "$WD/spec.json"
"$KPY" "$REPO/hardware/blocks/compose.py" "$WD/spec.json" "$WD/board.kicad_pcb" | grep -E "COMPOSE|COVERAGE"
OUT=$("$KPY" "$REPO/software/prompt-to-pcb-ui/scripts/export_dsn.py" "$WD/board.kicad_pcb" "$WD/board.dsn")
echo "$OUT" | grep -E "FANOUT|ZONE_NETS|KEEPOUTS" || true
SKIP=""
for n in $(echo "$OUT" | grep -o 'ZONE_NETS:.*' | cut -d: -f2 | tr ',' ' '); do SKIP="$SKIP --skip-net $n"; done
for n in $("$KPY" -c "import json;print(' '.join(sorted({e['net'] for e in json.load(open('$WD/board.preroute.json'))['entries']})))" 2>/dev/null); do SKIP="$SKIP --skip-net $n"; done
(cd "$REPO/hardware/pcba-rev-a" && ./tools/flroute/target/release/flroute "$WD/board.dsn" "$WD/board.ses" $SKIP | tail -1)
"$KPY" "$REPO/software/prompt-to-pcb-ui/scripts/import_ses.py" "$WD/board.kicad_pcb" "$WD/board.ses" | grep IMPORT_OK
"$KPY" "$REPO/software/prompt-to-pcb-ui/scripts/stitch_pads.py" "$WD/board.kicad_pcb" >/dev/null
"$KCLI" pcb drc --output "$WD/drc.json" --format json --severity-error "$WD/board.kicad_pcb" >/dev/null
"$KPY" "$REPO/software/prompt-to-pcb-ui/scripts/stitch_to_plane.py" "$WD/board.kicad_pcb" "$WD/drc.json" >/dev/null
"$KCLI" pcb drc --output "$WD/drc2.json" --format json --severity-error "$WD/board.kicad_pcb" >/dev/null
python3 - "$WD/drc2.json" <<'EOF'
import json, sys
r = json.load(open(sys.argv[1]))
errs = [v for v in r.get('violations', []) if v.get('severity') == 'error']
unc = r.get('unconnected_items', [])
print("DRC errors:", len(errs), "| unconnected:", len(unc))
sys.exit(1 if errs or unc else 0)
EOF
"$KPY" "$REPO/tools/blocks/tests/eps_netlist_check.py" "$WD/board.kicad_pcb"
echo "EPS CHAIN: CLEAN ($WD)"
```

- [ ] **Step 2: Run it — expect failures, iterate**

Run: `chmod +x tools/blocks/tests/eps_chain_test.sh && tools/blocks/tests/eps_chain_test.sh`

Reality check from the CM4 experience: the first run will surface geometry problems (courtyard overlaps, footprint anchor offsets on the registry parts, routing congestion). Iterate on block-internal coordinates ONLY (positions inside `block_eps`), re-running the script each time, until: `DRC errors: 0 | unconnected: 0` and `EPS netlist check: OK`. If a registry footprint's anchor is far from its centroid (the CM4 lesson), measure it once with pcbnew's bounding box and bake the measured offset into the place() call with a comment.

- [ ] **Step 3: Regressions (the classifier and power-dedup changes touch every board)**

```bash
for SPEC in '{"blocks":["rp2040 mcu","usb-c power","imu"]}' \
            '{"blocks":["esp32-c3 wifi","usb-c power","status led"]}' \
            '{"blocks":["cm4 compute module carrier","usb-c power","bme280"]}'; do
  WD=$(mktemp -d); printf '%s' "$SPEC" > "$WD/spec.json"
  # run the same chain as eps_chain_test.sh against $WD/spec.json (copy the loop or extract a helper)
done
```

Expected: all three report 0 DRC errors / 0 unconnected, and their COMPOSE_BLOCKS lines contain no unexpected `eps` (none of these prompts mention batteries).

- [ ] **Step 4: Commit**

```bash
git add tools/blocks/tests/eps_chain_test.sh
git commit -m "eps: full production-chain test — DRC-clean battery board"
```

---

### Task 6: Ship

- [ ] **Step 1: Typecheck the UI (CAPABILITIES flows into the interview LLM)**

Run: `cd software/prompt-to-pcb-ui && npx tsc --noEmit`
Expected: silent.

- [ ] **Step 2: Push + rebuild prod**

```bash
git push origin repo-review-hardening-auth-ux
cd software/prompt-to-pcb-ui && npm run build
launchctl kickstart -k gui/501/build.firstlight.compose
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/   # expect 307
```

- [ ] **Step 3: Live smoke test**

Run one real Compose job with prompt "battery powered temperature logger with usb-c charging" and confirm: eps in COMPOSE_BLOCKS, DRC clean in the run log, devices.json carries the EPS honesty entry.

- [ ] **Step 4: Update memory**

Append the shipped state + any new traps (footprint anchors, classifier collisions) to `firstlight-funnel-widening.md` or a new `firstlight-eps-block.md`, and index it in MEMORY.md.
