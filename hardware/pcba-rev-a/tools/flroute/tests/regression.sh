#!/bin/bash
# flroute regression: route the Rev A reference board from source and
# referee the result. Asserts 100% completion, zero failed nets, and a
# time ceiling. Run from anywhere; needs KiCad 10 + cargo.
#
#   tools/flroute/tests/regression.sh [--with-drc]
#
# --with-drc additionally imports the SES into a stripped copy of the
# board and runs the KiCad referee (slower; swig teardown noise is
# expected and ignored — sentinel files are the contract, not exit
# codes, per the pipeline's KiCad 10 notes).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
FLROUTE_DIR="$(dirname "$HERE")"
REVA="$(cd "$FLROUTE_DIR/../.." && pwd)"
KIPY="/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3"
KICLI="/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli"
BOARD="$REVA/elec/layout/rev-a-routed.kicad_pcb"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
SKIPS=(--skip-net lv --skip-net sel_p4-coil_bus-hv)
TIME_CEILING_S=120

echo "== build =="
(cd "$FLROUTE_DIR" && ~/.cargo/bin/cargo build --release 2>&1 | tail -1) || exit 1

echo "== export DSN from the placed reference =="
"$KIPY" - "$BOARD" "$WORK/board.dsn" <<'PY' 2>/dev/null
import sys
import pcbnew
b = pcbnew.LoadBoard(sys.argv[1])
ok = pcbnew.ExportSpecctraDSN(b, sys.argv[2])
print("DSN export:", ok)
sys.exit(0 if ok else 1)
PY
[ -s "$WORK/board.dsn" ] || { echo "FAIL: no DSN"; exit 1; }

echo "== route =="
T0=$(date +%s)
"$FLROUTE_DIR/target/release/flroute" "$WORK/board.dsn" "$WORK/board.ses" \
    "${SKIPS[@]}" 2>&1 | tail -3 | tee "$WORK/route.tail"
T1=$(date +%s)
ELAPSED=$((T1 - T0))

SUMMARY=$(grep -Eo '[0-9]+ attempted, [0-9]+ routed, [0-9]+ failed' "$WORK/route.tail")
ATTEMPTED=$(echo "$SUMMARY" | cut -d' ' -f1)
ROUTED=$(echo "$SUMMARY" | cut -d' ' -f3)
FAILED=$(echo "$SUMMARY" | cut -d' ' -f5)

RC=0
[ -n "$SUMMARY" ] || { echo "FAIL: no summary line"; RC=1; }
if [ -n "$SUMMARY" ]; then
  [ "$FAILED" = "0" ] || { echo "FAIL: $FAILED nets failed"; RC=1; }
  [ "$ROUTED" = "$ATTEMPTED" ] || { echo "FAIL: $ROUTED/$ATTEMPTED"; RC=1; }
  [ "$ELAPSED" -le "$TIME_CEILING_S" ] || { echo "FAIL: ${ELAPSED}s > ${TIME_CEILING_S}s ceiling"; RC=1; }
fi

if [ "$RC" = "0" ] && [ "${1:-}" = "--with-drc" ]; then
  echo "== referee (SES import + zone fill + DRC) =="
  "$KIPY" - "$BOARD" "$WORK" <<'PY' 2>/dev/null
import sys
import pcbnew
board, work = sys.argv[1], sys.argv[2]
b = pcbnew.LoadBoard(board)
for t in list(b.GetTracks()):
    b.Remove(t)
b.Save(work + "/placed.kicad_pcb")
PY
  "$KIPY" "$REVA/../../software/prompt-to-pcb-ui/scripts/import_ses.py" \
      "$WORK/placed.kicad_pcb" "$WORK/board.ses" 2>/dev/null | grep IMPORT_OK \
      || { echo "FAIL: SES import"; exit 1; }
  "$KICLI" pcb drc --format json --severity-error -o "$WORK/drc.json" \
      "$WORK/placed.kicad_pcb" >/dev/null 2>&1
  python3 - "$WORK/drc.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
v = d.get("violations", [])
u = d.get("unconnected_items", [])
sig = 0
for x in u:
    for it in x.get("items", []):
        desc = it.get("description", "")
        if "[" in desc:
            net = desc.split("[")[1].split("]")[0]
            if net not in ("lv", "sel_p4-coil_bus-hv"):
                sig += 1
            break
print("referee: {} violations, {} signal-net unconnected "
      "(zone nets excluded: stitch vias are downstream)".format(len(v), sig))
# pre-stitch contract: clearance-class violations only from known
# relaxed snaps; hard ceiling so a regression is loud
assert len(v) <= 8, "violations regressed: {}".format(len(v))
assert sig <= 2, "signal opens regressed: {}".format(sig)
print("referee PASS (pre-stitch ceilings)")
PY
  RC=$?
fi

if [ "$RC" = "0" ]; then
  echo "REGRESSION PASS: ${ROUTED}/${ATTEMPTED} in ${ELAPSED}s"
else
  echo "REGRESSION FAIL"
fi
exit $RC
