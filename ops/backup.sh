#!/bin/sh
set -eu
umask 077

# Overrides are for isolated restore/backup tests. Production uses these defaults.
source_db=${KH_LINK_BACKUP_SOURCE:-/var/lib/fengzhu-agent-bridge/fengzhu-bridge.db}
dest=${KH_LINK_BACKUP_DIR:-/var/backups/fengzhu-agent-bridge}
[ -f "$source_db" ] || { echo 'Backup source is missing' >&2; exit 1; }
source_db=$(realpath -e -- "$source_db")
mkdir -p "$dest"
dest=$(cd "$dest" && pwd -P)
case "$dest" in
  /|/var|/var/backups|*"'"*) echo 'Unsafe backup destination' >&2; exit 1 ;;
esac
[ "$dest" != "$(dirname -- "$source_db")" ] || { echo 'Backup destination must differ from source directory' >&2; exit 1; }
latest="$dest/bridge-latest.db"
[ ! -L "$latest" ] || { echo 'Backup target must not be a symbolic link' >&2; exit 1; }

exec 9>"$dest/.backup.lock"
flock -n 9 || { echo 'Another backup is already running' >&2; exit 1; }
pending=$(mktemp "$dest/.bridge-latest.XXXXXXXX.db")
cleanup() {
  if [ -n "${pending:-}" ]; then
    rm -f -- "$pending" "$pending-wal" "$pending-shm" "$pending-journal"
  fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

# Hold a read snapshot while copying. Without it, busy WAL writers can restart
# SQLite's online backup repeatedly and keep a multi-GB copy running for hours.
sqlite3 -bail -readonly "$source_db" <<SQL >/dev/null
.timeout 10000
BEGIN;
SELECT COUNT(*) FROM sqlite_master;
.backup '$pending'
COMMIT;
SQL

# Only the new snapshot is changed. DELETE mode makes it a standalone file,
# so restoring it does not depend on a WAL/SHM sidecar. Never prune a good
# backup when creation or validation of its replacement fails.
mode=$(sqlite3 -bail "$pending" 'PRAGMA journal_mode=DELETE;')
[ "$mode" = 'delete' ] || { echo 'Backup journal conversion failed' >&2; exit 1; }
check=$(sqlite3 -bail -readonly "$pending" 'PRAGMA quick_check;')
[ "$check" = 'ok' ] || { echo 'Backup integrity check failed' >&2; exit 1; }
chmod 600 "$pending"
sync -f "$pending"
mv -f -- "$pending" "$latest"
pending=''
sync -f "$dest"

# The directory contains this product's backups only. Limit deletion to its
# established filenames, at this depth, after the verified atomic replacement.
find "$dest" -maxdepth 1 -type f \
  \( -name 'bridge-*.db' -o -name 'bridge-*.db-wal' -o -name 'bridge-*.db-shm' -o -name 'bridge-*.db-journal' \) \
  ! -name 'bridge-latest.db' -delete
echo 'Verified latest backup retained: bridge-latest.db'
