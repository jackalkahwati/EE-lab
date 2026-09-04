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

# Alert credentials live OUTSIDE this repo and outside the plist: a launchd
# plist is world-readable and a repo is a repo. Anything in this file is
# sourced if present (mode 0600), so RESEND_API_KEY never appears in either.
ALERT_ENV="${FL_ALERT_ENV:-$HOME/.config/firstlight/alerts.env}"
# shellcheck disable=SC1090
[ -r "$ALERT_ENV" ] && . "$ALERT_ENV"

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
  # Recovery notice: only when we previously alerted, so a green run on a
  # healthy system stays silent. Knowing it came back matters as much as
  # knowing it went down — otherwise the last thing you saw was the failure.
  STATE_FILE="${FL_ALERT_STATE:-$HOME/.firstlight-healthcheck.state}"
  if [ -f "$STATE_FILE" ] && [ "$(sed -n 1p "$STATE_FILE" 2>/dev/null)" = "unhealthy" ]; then
    if [ -n "${RESEND_API_KEY:-}" ] && [ -n "${FL_ALERT_EMAIL:-}" ]; then
      payload="$(FL_T="$FL_ALERT_EMAIL" FL_F="${FL_ALERT_FROM:-FirstLight Monitor <onboarding@resend.dev>}" \
                 FL_H="$(hostname)" FL_W="$(ts)" python3 - <<'PY2'
import json, os
print(json.dumps({
    "from": os.environ["FL_F"],
    "to": [t.strip() for t in os.environ["FL_T"].split(",") if t.strip()],
    "subject": "FirstLight Compose RECOVERED on %s" % os.environ["FL_H"],
    "text": "All checks green again at %s.\n" % os.environ["FL_W"],
}))
PY2
)"
      curl -fsS -m 15 -X POST https://api.resend.com/emails \
        -H "Authorization: Bearer ${RESEND_API_KEY}" \
        -H 'Content-Type: application/json' -d "$payload" >/dev/null 2>&1 \
        && log "recovery emailed to $FL_ALERT_EMAIL"
    fi
    rm -f "$STATE_FILE"
  fi
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
  log "FL_ALERT_WEBHOOK unset — no webhook alert"
fi

# --- Email alert (Resend) ----------------------------------------------------
# A log file nobody reads is not monitoring. On 2026-09-03 this check correctly
# detected the data drive falling off the bus and the only record was a line in
# /tmp — the outage was found by hand hours later. Email is the channel that
# actually reaches a phone.
#
# Throttled deliberately: the job runs every 5 minutes, so alerting on every
# tick would train you to ignore it. One mail when the state flips to
# unhealthy, a reminder every FL_ALERT_REPEAT_MIN while it stays down, and one
# RECOVERED mail when it comes back.
send_email() {
  local subject="$1" body="$2"
  [ -n "${RESEND_API_KEY:-}" ] && [ -n "${FL_ALERT_EMAIL:-}" ] || return 1
  local from="${FL_ALERT_FROM:-FirstLight Monitor <onboarding@resend.dev>}"
  local payload
  payload="$(FL_S="$subject" FL_B="$body" FL_F="$from" FL_T="$FL_ALERT_EMAIL" python3 - <<'PY2'
import json, os
print(json.dumps({
    "from": os.environ["FL_F"],
    "to": [t.strip() for t in os.environ["FL_T"].split(",") if t.strip()],
    "subject": os.environ["FL_S"],
    "text": os.environ["FL_B"],
}))
PY2
)"
  curl -fsS -m 15 -X POST https://api.resend.com/emails \
    -H "Authorization: Bearer ${RESEND_API_KEY}" \
    -H 'Content-Type: application/json' -d "$payload" >/dev/null 2>&1
}

STATE_FILE="${FL_ALERT_STATE:-$HOME/.firstlight-healthcheck.state}"
REPEAT_MIN="${FL_ALERT_REPEAT_MIN:-60}"
now_ts="$(date +%s)"
prev_status=""; prev_ts=0
if [ -f "$STATE_FILE" ]; then
  prev_status="$(sed -n 1p "$STATE_FILE" 2>/dev/null)"
  prev_ts="$(sed -n 2p "$STATE_FILE" 2>/dev/null)"
fi
[ -n "$prev_ts" ] || prev_ts=0

should_mail=0
if [ "$prev_status" != "unhealthy" ]; then
  should_mail=1                                   # state flipped
elif [ "$(( (now_ts - prev_ts) / 60 ))" -ge "$REPEAT_MIN" ]; then
  should_mail=1                                   # still down, time to remind
fi

if [ "$should_mail" -eq 1 ]; then
  if send_email "FirstLight Compose UNHEALTHY on $(hostname)" \
      "$(printf 'FirstLight Compose failed %s check(s) at %s\n\n%s\nFull log: /tmp/firstlight-healthcheck.log\n' "${#FAILURES[@]}" "$(ts)" "$detail")"; then
    log "alert emailed to $FL_ALERT_EMAIL"
    printf 'unhealthy\n%s\n' "$now_ts" > "$STATE_FILE"
  else
    log "WARNING: could not email alert (RESEND_API_KEY / FL_ALERT_EMAIL set?)"
    printf 'unhealthy\n%s\n' "$prev_ts" > "$STATE_FILE"
  fi
else
  log "still unhealthy; next reminder in $(( REPEAT_MIN - (now_ts - prev_ts) / 60 )) min"
  printf 'unhealthy\n%s\n' "$prev_ts" > "$STATE_FILE"
fi

exit 1
