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
