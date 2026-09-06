#!/usr/bin/env bash
# Build a product through the FULL pipeline over the programmatic API (same
# stages as Compose: architect → electronics → mechanical/sim/docs), then poll
# until it finishes and print the honest verdict.
#
#   FL_API_KEY=flk_live_… tools/cli/fl-api.sh "<prompt>"
#
# Mint a key at <base>/enterprise/integrations (read_write scope). Never put the
# key on the command line; export it. FL_BASE defaults to the production app.
set -euo pipefail
PROMPT="${1:?usage: FL_API_KEY=flk_live_... fl-api.sh \"<prompt>\"}"
: "${FL_API_KEY:?export FL_API_KEY=flk_live_... (mint at /enterprise/integrations)}"
BASE="${FL_BASE:-https://app.firstlight.build}"
resp=$(curl -sS -X POST "$BASE/api/v1/boards" -H "Authorization: Bearer $FL_API_KEY" -H 'content-type: application/json' -H 'X-Requested-With: fl-api.sh' --data "$(jq -cn --arg p "$PROMPT" '{prompt:$p}')")
echo "$resp" | jq -r '"▸ " + ((.runId // .run_id // "no runId: " + (.error // tostring)))'
RUN=$(echo "$resp" | jq -r '.runId // .run_id // empty'); [ -n "$RUN" ] || exit 1
while :; do
  s=$(curl -sS "$BASE/api/v1/runs/$RUN" -H "Authorization: Bearer $FL_API_KEY" -H 'X-Requested-With: fl-api.sh')
  st=$(echo "$s" | jq -r '.status // .job.status // "?"')
  printf '  %s %s\n' "$(date +%H:%M:%S)" "$st"
  case "$st" in complete|failed|done|error) break;; esac
  sleep 20
done
echo "$s" | jq '{status, electronics: (.electronics // .verdict // null), stages: (.stages // null)}'
