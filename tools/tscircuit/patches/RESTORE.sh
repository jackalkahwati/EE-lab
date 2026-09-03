#!/bin/bash
# Reapply FL dsn-converter patches after any npm install in tools/tscircuit.
# These fixes (via net-link is in run_board.mjs; inner-layer mapping + per-geometry
# image names are here) are what let freerouting route dense multi-layer boards
# without phantom shorts. See dsn-converter-FL-patches.txt for the hunks.
HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET="$HERE/../node_modules/dsn-converter/dist/index.js"
if grep -q "function flGeomSig" "$TARGET" 2>/dev/null; then
  echo "already patched — nothing to do"; exit 0
fi
cp "$HERE/dsn-converter-index.PATCHED.js" "$TARGET" && echo "restored patched dsn-converter" || echo "RESTORE FAILED"
