#!/usr/bin/env bash
# Sync real KiCad board artifacts into the frontend.
# Layer SVGs + 3D renders + DRC JSON + board stats + BOM + .ato sources.
#
#   bash scripts/sync-board.sh            # uses hardware/pcba-rev-a
#   HW_DIR=/path/to/board bash scripts/sync-board.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HW_DIR="${HW_DIR:-$(cd "$APP_DIR/../../hardware/pcba-rev-a" && pwd)}"
BOARD="${BOARD:-$HW_DIR/elec/layout/rev-a-routed.kicad_pcb}"

KCLI="/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli"
KPY="/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3"

OUT_BOARD="$APP_DIR/public/board"
OUT_DATA="$APP_DIR/public/data"
mkdir -p "$OUT_BOARD" "$OUT_DATA"

echo "== sync-board: $BOARD"

# 1. per-layer SVGs (negative B&W -> used as luminance masks, tinted in CSS)
for L in F.Cu In1.Cu In2.Cu B.Cu Edge.Cuts F.SilkS; do
  "$KCLI" pcb export svg --mode-single --page-size-mode 2 \
    --exclude-drawing-sheet --black-and-white --negative \
    -l "$L" -o "$OUT_BOARD/$L.svg" "$BOARD" > /dev/null
  echo "   layer $L.svg"
done

# 2. raytraced renders
for SIDE in top bottom; do
  "$KCLI" pcb render --side "$SIDE" --background opaque --quality basic \
    --width 1600 --height 1400 -o "$OUT_BOARD/render-$SIDE.png" "$BOARD" > /dev/null
  echo "   render-$SIDE.png"
done

# 3. DRC — the neutral referee
"$KCLI" pcb drc --format json --severity-error -o "$OUT_DATA/drc.json" "$BOARD" > /dev/null
echo "   drc.json"

# 4. board stats (pcbnew: nets, HPWL, placement gate, copper inventory)
"$KPY" "$APP_DIR/scripts/extract_stats.py" "$BOARD" "$OUT_DATA/drc.json" "$OUT_DATA/board.json"

# 5. BOM + .ato sources from the atopile build
python3 "$APP_DIR/scripts/build_data.py" "$HW_DIR" "$OUT_DATA"

echo "== sync-board: done -> public/board, public/data"
