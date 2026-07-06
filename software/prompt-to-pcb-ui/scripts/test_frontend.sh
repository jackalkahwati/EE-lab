#!/usr/bin/env bash
# Frontend regression (Phase 10, Phase 8 items) — verifies the workspace redesign
# preserves every view + demo, keeps artifacts reachable, and doesn't fake data.
# Assumes the server is up on :4500 and COOKIE points at an authed session.
set -uo pipefail
BASE=${BASE:-http://localhost:4500}
COOKIE=${COOKIE:-/tmp/fl-jar3.txt}
PAGE="app/page.tsx"
pass=0; fail=0
ck() { if [ "$1" = "1" ]; then echo "  [PASS] $2"; pass=$((pass+1)); else echo "  [FAIL] $2"; fail=$((fail+1)); fi; }

# 1-2. every existing view is still wired (no view removed by the redesign)
for v in Board Code BOM Checks Constraints Advanced Pinout Ingest Patterns Recovery Assembly Review FL-1 Order; do
  grep -q "tab === '$v'" "$PAGE" && r=1 || r=0
  ck "$r" "view '$v' still rendered"
done
# new views exist
for v in Overview Artifacts; do
  grep -q "tab === '$v'" "$PAGE" && r=1 || r=0; ck "$r" "new view '$v' wired"
done

# 3. grouped nav replaces the single tab row (no overflow-by-design)
grep -q "GROUPS" "$PAGE" && grep -q "FUTURE_PHASES" "$PAGE" && r=1 || r=0
ck "$r" "grouped nav + future-phase roadmap present"

# 4. future phases are disabled placeholders, not fake data
grep -q "not generated" "$PAGE" && grep -q "cursor-not-allowed" "$PAGE" && r=1 || r=0
ck "$r" "future phases disabled (not faked)"

# 5-8. existing demos still render (their run data is reachable)
demo_data() { curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE" "$BASE/runs/$1/data/$2"; }
for run in golden-sensor-hub fl1-meas-v2; do
  code=$(demo_data "$run" board.json)
  [ "$code" = "200" ] && r=1 || r=0; ck "$r" "demo '$run' board reachable ($code)"
done
# advanced-routing data reachable for the advanced demo
code=$(demo_data fl1-meas-v2 advanced-routing-report.json)
[ "$code" = "200" ] && r=1 || r=0; ck "$r" "advanced-routing data reachable ($code)"
# recovery data reachable
code=$(demo_data fl1meas-rec2-a3 recovery-loop.json)
[ "$code" = "200" ] && r=1 || r=0; ck "$r" "recovery data reachable ($code)"
# ingest + pattern libraries reachable (global)
code=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE" "$BASE/api/ingest/library")
[ "$code" = "200" ] && r=1 || r=0; ck "$r" "ingest library reachable ($code)"
code=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE" "$BASE/api/patterns")
[ "$code" = "200" ] && r=1 || r=0; ck "$r" "pattern library reachable ($code)"

echo "$pass passed, $fail failed"
[ "$fail" = "0" ]
