#!/usr/bin/env bash
# Build a board from a prompt with NO server and NO auth: the same planner →
# netlist → router chain the pipeline's electronics stage runs.
#
#   tools/cli/fl-board.sh "RP2040 sensor hub: BME280 over I2C, 2x3 SWD header" [outdir]
#
# Env:  FL_WALL_MS=285000  emulate the prod wall (the ladder sizes itself to it;
#                          a SIGTERM at the wall still ships the best rung)
#       FL_ONLY_RUNG=...   run one strategy rung (see deploy/OPS.md)
# Outputs in <outdir>: design.json (planner), spec.json (parts/nets/gnd),
# board.json (runner result: ok, drc, drcScore, drcRepair, kicadPcb …),
# board.kicad_pcb, run.log (the runner's [t] timing lines).
set -euo pipefail
PROMPT="${1:?usage: fl-board.sh \"<prompt>\" [outdir]}"
OUT="${2:-$(mktemp -d /tmp/fl-board.XXXXXX)}"; mkdir -p "$OUT"
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
PY="${FL_PYTHON:-python3}"
echo "▸ planning → $OUT/design.json"
( cd "$HERE/hardware/planner" && "$PY" plan_cli.py "$PROMPT" 2>"$OUT/plan.log" | tail -1 ) > "$OUT/design.json"
"$PY" - "$OUT/design.json" <<'PY'
import json,sys; d=json.load(open(sys.argv[1]))
print("  parts:", ", ".join(p.get("mpn","?") for p in d.get("final_design",[])), "| mcu:", (d.get("intent") or {}).get("mcu"))
for h in d.get("honest_report",[]):
    if h.get("outcome")!="built": print("  ⚠", h.get("request"), "→", h.get("outcome"), h.get("mpn") or h.get("reason",""))
PY
echo "▸ netlist → $OUT/spec.json"
( cd "$HERE/hardware/planner" && "$PY" synth.py --netlist "$OUT/design.json" ) > "$OUT/spec.json"
"$PY" -c 'import json,sys; s=json.load(open(sys.argv[1])); print("  parts", len(s["parts"]), "nets", len(s["nets"]), "gnd pins", len(s["gnd"]), "| dropped:", [d.get("name") or d.get("mpn") for d in s["honest"]["dropped"]])' "$OUT/spec.json"
echo "▸ routing (run_board.mjs)${FL_WALL_MS:+, wall ${FL_WALL_MS}ms} → $OUT/board.json"
cd "$HERE/tools/tscircuit"
if [ -n "${FL_WALL_MS:-}" ]; then
  timeout -s TERM "$(( FL_WALL_MS / 1000 ))" node run_board.mjs < "$OUT/spec.json" > "$OUT/board.json" 2> "$OUT/run.log" || true
else
  node run_board.mjs < "$OUT/spec.json" > "$OUT/board.json" 2> "$OUT/run.log"
fi
node -e '
const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1])); const d=j.drc||{}; const S=x=>JSON.stringify(x??null)
if (j.kicadPcb) fs.writeFileSync(process.argv[2], j.kicadPcb)
console.log(`  ok=${j.ok}${j.wallHit?" wallHit":""} errors=${d.errors} ${S(d.errorTypes)} score=${j.drcScore} winner=${j.drcRepair?.winningStrategy} ground=${S(j.drcRepair?.groundPlane)}`)
if (j.error) console.log("  error:", j.error)
for (const it of j.drcRepair?.iterations||[]) console.log("   ", (it.strategy||"").padEnd(42), "|", it.skipped||`errors=${it.errors} ${S(it.errorTypes||{})} unrouted=${it.unrouted}`)
' "$OUT/board.json" "$OUT/board.kicad_pcb"
echo "▸ done: $OUT"
