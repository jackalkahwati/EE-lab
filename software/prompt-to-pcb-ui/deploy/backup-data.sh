#!/usr/bin/env bash
#
# backup-data.sh — snapshot FirstLight Compose production data.
#
# Snapshots the live data dirs (data/ and public/runs/) into a timestamped,
# rotated local backup directory, and optionally mirrors that snapshot to an
# off-drive/remote target (rsync/scp destination) via $FL_BACKUP_REMOTE.
#
# This script is COPY-ONLY. It never deletes, moves, or mutates the live data.
# The only thing it prunes is OLD SNAPSHOTS inside the backup directory.
#
# Usage:
#   ./backup-data.sh
#
# Environment:
#   FL_APP_DIR        App root. Default: the repo this script lives in.
#   FL_BACKUP_DIR     Where snapshots go. Default: ~/firstlight-backups
#   FL_BACKUP_KEEP    How many snapshots to retain. Default: 14
#   FL_BACKUP_REMOTE  Optional off-machine target for rsync, e.g.
#                       user@host:/path/firstlight-backups
#                       /Volumes/OtherDrive/firstlight-backups
#                     If unset, backups stay on THIS machine (warning printed).
#
# No secrets are read or written by this script.

set -euo pipefail

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
warn() { printf '[%s] WARNING: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; }

# --- Resolve paths -----------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
APP_DIR="${FL_APP_DIR:-$(cd "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd)}"
BACKUP_DIR="${FL_BACKUP_DIR:-$HOME/firstlight-backups}"
KEEP="${FL_BACKUP_KEEP:-14}"
REMOTE="${FL_BACKUP_REMOTE:-}"

STAMP="$(date '+%Y%m%d-%H%M%S')"
SNAP_DIR="$BACKUP_DIR/$STAMP"

# Sources to snapshot (space-separated, relative to APP_DIR).
SOURCES=("data" "public/runs")

log "FirstLight Compose data backup starting"
log "App dir:    $APP_DIR"
log "Backup dir: $BACKUP_DIR"
log "Snapshot:   $SNAP_DIR"
log "Retain:     last $KEEP snapshots"

mkdir -p "$SNAP_DIR"

# --- Copy each source (copy-only; live data untouched) -----------------------
copied_any=0
for rel in "${SOURCES[@]}"; do
  src="$APP_DIR/$rel"
  if [ ! -e "$src" ]; then
    warn "source not found, skipping: $src"
    continue
  fi
  dest="$SNAP_DIR/$rel"
  mkdir -p "$(dirname "$dest")"
  log "copying $rel ..."
  # -a preserves timestamps/perms; source is only read. Never --delete on live.
  if command -v rsync >/dev/null 2>&1; then
    rsync -a "$src/" "$dest/" 2>/dev/null || rsync -a "$src" "$(dirname "$dest")/"
  else
    cp -a "$src" "$(dirname "$dest")/"
  fi
  copied_any=1
done

if [ "$copied_any" -eq 0 ]; then
  warn "no sources were found under $APP_DIR — nothing was backed up"
  # Remove the empty snapshot dir we created.
  rmdir "$SNAP_DIR" 2>/dev/null || true
  exit 1
fi

# Record a small manifest for restore sanity.
{
  echo "snapshot: $STAMP"
  echo "app_dir:  $APP_DIR"
  echo "host:     $(hostname)"
  echo "created:  $(date '+%Y-%m-%d %H:%M:%S %z')"
  echo "sources:  ${SOURCES[*]}"
} > "$SNAP_DIR/MANIFEST.txt"

# Compute size for the log.
SNAP_SIZE="$(du -sh "$SNAP_DIR" 2>/dev/null | awk '{print $1}')"
log "snapshot complete: $SNAP_DIR (${SNAP_SIZE:-unknown})"

# --- Optional off-machine mirror ---------------------------------------------
if [ -n "$REMOTE" ]; then
  log "mirroring snapshot to remote: $REMOTE"
  if command -v rsync >/dev/null 2>&1; then
    # Trailing slash: push the snapshot dir's contents under a matching name.
    if rsync -az "$SNAP_DIR/" "$REMOTE/$STAMP/"; then
      log "remote mirror complete"
    else
      warn "remote mirror FAILED to $REMOTE — local snapshot is intact"
    fi
  else
    warn "rsync not available; cannot mirror to $REMOTE (local snapshot intact)"
  fi
else
  warn "FL_BACKUP_REMOTE is unset — backups live ONLY on this machine ($BACKUP_DIR)."
  warn "A drive/machine loss loses both the live data AND its backups. Set"
  warn "FL_BACKUP_REMOTE to an off-drive or remote target for real durability."
fi

# --- Prune old snapshots (backup dir only; never touches live data) ----------
# List snapshot dirs (timestamp-named), newest first, drop the first $KEEP.
prune_list="$(
  find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*-[0-9]*' \
    2>/dev/null | sort -r | tail -n +"$((KEEP + 1))"
)"
if [ -n "$prune_list" ]; then
  while IFS= read -r old; do
    [ -z "$old" ] && continue
    # Safety: only remove paths strictly inside BACKUP_DIR.
    case "$old" in
      "$BACKUP_DIR"/*)
        log "pruning old snapshot: $old"
        rm -rf "$old"
        ;;
      *)
        warn "refusing to prune path outside backup dir: $old"
        ;;
    esac
  done <<< "$prune_list"
else
  log "no snapshots to prune (<= $KEEP retained)"
fi

log "backup finished OK"
