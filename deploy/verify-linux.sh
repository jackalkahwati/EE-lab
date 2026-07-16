#!/usr/bin/env bash
# Prove the electronics pipeline runs DRC-clean on LINUX — the hard cloud-move
# question. Runs the exact production chain (compose → export_dsn → flroute →
# import_ses → stitch → KiCad DRC) inside the toolchain container, using the
# Linux KiCad + the Linux-built flroute via FL_* env. Exits non-zero unless the
# board is 0 DRC errors / 0 unconnected — the same bar as the Mac.
#
#   docker run --rm -v "$PWD":/repo -w /repo firstlight-toolchain bash deploy/verify-linux.sh
set -euo pipefail
REPO=/repo
PY="${FL_KICAD_PYTHON:-/usr/bin/python3}"
CLI="${FL_KICAD_CLI:-/usr/bin/kicad-cli}"
FLROUTE="${FL_FLROUTE:-/opt/flroute/flroute}"
WD=$(mktemp -d)

echo "== toolchain =="
"$PY" -c "import pcbnew; print('pcbnew', pcbnew.Version())"
"$CLI" version
"$FLROUTE" --help >/dev/null 2>&1 && echo "flroute: ok" || true

printf '{"blocks":["rp2040 mcu","usb-c power","temperature sensor"]}' > "$WD/spec.json"

echo "== compose =="
"$PY" "$REPO/hardware/blocks/compose.py" "$WD/spec.json" "$WD/board.kicad_pcb" | grep -E "COMPOSE:" | tail -1

echo "== export_dsn =="
OUT=$("$PY" "$REPO/software/prompt-to-pcb-ui/scripts/export_dsn.py" "$WD/board.kicad_pcb" "$WD/board.dsn")
echo "$OUT" | grep -E "ZONE_NETS|FANOUT:" || true
SKIP=""
for n in $(echo "$OUT" | grep -o 'ZONE_NETS:.*' | cut -d: -f2 | tr ',' ' '); do SKIP="$SKIP --skip-net $n"; done
if [ -f "$WD/board.preroute.json" ]; then
  for n in $("$PY" -c "import json;print(' '.join(sorted({e['net'] for e in json.load(open('$WD/board.preroute.json'))['entries']})))" 2>/dev/null); do SKIP="$SKIP --skip-net $n"; done
fi

echo "== flroute (linux build) =="
(cd "$REPO/hardware/pcba-rev-a" && "$FLROUTE" "$WD/board.dsn" "$WD/board.ses" $SKIP | tail -1)

echo "== import_ses + stitch =="
"$PY" "$REPO/software/prompt-to-pcb-ui/scripts/import_ses.py" "$WD/board.kicad_pcb" "$WD/board.ses" | grep -E "IMPORT_OK" || true
"$PY" "$REPO/software/prompt-to-pcb-ui/scripts/stitch_pads.py" "$WD/board.kicad_pcb" >/dev/null 2>&1 || true

echo "== DRC (linux kicad-cli) =="
"$CLI" pcb drc --output "$WD/drc.json" --format json --severity-error "$WD/board.kicad_pcb" >/dev/null
"$PY" - "$WD/drc.json" <<'PYEOF'
import json, sys
r = json.load(open(sys.argv[1]))
errs = [v for v in r.get('violations', []) if v.get('severity') == 'error']
unc = r.get('unconnected_items', [])
print("DRC errors:", len(errs), "| unconnected:", len(unc))
sys.exit(1 if errs or unc else 0)
PYEOF

echo "LINUX PIPELINE: CLEAN — the electronics spine is cloud-portable"
