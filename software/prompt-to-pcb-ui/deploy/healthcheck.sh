#!/usr/bin/env bash
#
# healthcheck.sh — end-to-end health probe for the FirstLight Compose
# single-Mac deployment.
#
# Checks every link in the serving path and exits non-zero with a clear
# diagnosis if any is down:
#   (a) external drive mounted            -> /Volumes/T9 Backup
#   (b) local app answering               -> http://localhost:4500/
#   (c) public endpoint answering         -> https://app.firstlight.build/
#   (d) cloudflared tunnel process alive
#   (e) launchd compose job loaded        -> build.firstlight.compose
#
# On failure, if $FL_ALERT_WEBHOOK is set, POSTs a JSON alert to it.
# If unset, failures are only printed.
#
# Usage:  ./healthcheck.sh
# Exit:   0 = all green; 1 = one or more checks failed.

set -uo pipefail   # NOTE: not -e; we want to run every check and aggregate.

DRIVE="${FL_DRIVE_MOUNT:-/Volumes/T9 Backup}"
LOCAL_URL="${FL_LOCAL_URL:-http://localhost:4500/}"
PUBLIC_URL="${FL_PUBLIC_URL:-https://app.firstlight.build/}"
COMPOSE_LABEL="${FL_COMPOSE_LABEL:-build.firstlight.compose}"
WEBHOOK="${FL_ALERT_WEBHOOK:-}"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { printf '[%s] %s\n' "$(ts)" "$*"; }

FAILURES=()

check_drive() {
  if [ -d "$DRIVE" ] && mount | grep -q " on $DRIVE "; then
    log "OK   (a) external drive mounted: $DRIVE"
  elif [ -d "$DRIVE" ]; then
    # Directory exists but is not a mount point: a stale mountpoint after an
    # unclean unmount. The data is NOT there. Fail, don't reassure.
    log "FAIL (a) drive path exists but is NOT mounted: $DRIVE"
    FAILURES+=("'$DRIVE' exists as a bare directory but no volume is mounted there — data + app working dir are gone")
  else
    log "FAIL (a) external drive NOT mounted: $DRIVE"
    FAILURES+=("external drive '$DRIVE' is not mounted — data + app working dir are gone")
  fi
}

check_local() {
  if curl -fsS -m 10 -o /dev/null "$LOCAL_URL"; then
    log "OK   (b) local app answering: $LOCAL_URL"
  else
    log "FAIL (b) local app NOT answering: $LOCAL_URL"
    FAILURES+=("local Next server ($LOCAL_URL) not answering — check job '$COMPOSE_LABEL' and /tmp/firstlight-compose.err")
  fi
}

check_public() {
  if curl -fsS -m 15 -o /dev/null "$PUBLIC_URL"; then
    log "OK   (c) public endpoint answering: $PUBLIC_URL"
  else
    log "FAIL (c) public endpoint NOT answering: $PUBLIC_URL"
    FAILURES+=("public endpoint ($PUBLIC_URL) not answering — tunnel/DNS/TLS or app down")
  fi
}

check_cloudflared() {
  if pgrep -f 'cloudflared.*tunnel.*run' >/dev/null 2>&1; then
    log "OK   (d) cloudflared tunnel process alive"
  else
    log "FAIL (d) cloudflared tunnel process NOT running"
    FAILURES+=("cloudflared tunnel process not running — check job 'build.firstlight.cloudflared' and /tmp/firstlight-cloudflared.err")
  fi
}

check_launchd() {
  if launchctl list 2>/dev/null | grep -q "$COMPOSE_LABEL"; then
    log "OK   (e) launchd job loaded: $COMPOSE_LABEL"
  else
    log "FAIL (e) launchd job NOT loaded: $COMPOSE_LABEL"
    FAILURES+=("launchd job '$COMPOSE_LABEL' not loaded — bootstrap it (see deploy/OPS.md)")
  fi
}

log "FirstLight Compose healthcheck starting"
check_drive
check_local
check_public
check_cloudflared
check_launchd

if [ "${#FAILURES[@]}" -eq 0 ]; then
  log "ALL GREEN — end-to-end path healthy"
  exit 0
fi

# --- Failure path ------------------------------------------------------------
log "UNHEALTHY — ${#FAILURES[@]} check(s) failed:"
detail=""
for f in "${FAILURES[@]}"; do
  log "  - $f"
  detail+="- $f"$'\n'
done

if [ -n "$WEBHOOK" ]; then
  host="$(hostname)"
  # Build a minimal JSON payload. Use python3 if available for safe escaping.
  if command -v python3 >/dev/null 2>&1; then
    payload="$(FL_HOST="$host" FL_DETAIL="$detail" python3 - <<'PY'
import json, os
msg = "FirstLight Compose UNHEALTHY on %s:\n%s" % (
    os.environ.get("FL_HOST", "?"), os.environ.get("FL_DETAIL", ""))
print(json.dumps({"text": msg, "service": "firstlight-compose",
                  "status": "unhealthy", "host": os.environ.get("FL_HOST","?")}))
PY
)"
  else
    # Fallback: crude single-line message (newlines stripped).
    oneline="$(printf '%s' "$detail" | tr '\n' ' ')"
    payload="{\"text\":\"FirstLight Compose UNHEALTHY on ${host}: ${oneline}\",\"service\":\"firstlight-compose\",\"status\":\"unhealthy\"}"
  fi
  if curl -fsS -m 10 -X POST -H 'Content-Type: application/json' \
       -d "$payload" "$WEBHOOK" >/dev/null 2>&1; then
    log "alert POSTed to FL_ALERT_WEBHOOK"
  else
    log "WARNING: failed to POST alert to FL_ALERT_WEBHOOK"
  fi
else
  log "FL_ALERT_WEBHOOK unset — printed diagnosis only (no alert sent)"
fi

exit 1
