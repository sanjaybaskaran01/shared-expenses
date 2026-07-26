#!/bin/zsh
set -euo pipefail

backup_path="${1:?Usage: verify-backup.sh BACKUP.age}"
: "${EXPENSES_AGE_IDENTITY:?Set EXPENSES_AGE_IDENTITY to the age identity file}"

for dependency in sqlite3 age tar shasum; do
  command -v "$dependency" >/dev/null || { print -u2 "Missing dependency: $dependency"; exit 1; }
done

restore_workdir="$(mktemp -d "${TMPDIR:-/tmp}/expenses-restore.XXXXXX")"
trap 'rm -rf -- "$restore_workdir"' EXIT INT TERM
umask 077

age -d -i "$EXPENSES_AGE_IDENTITY" -o "$restore_workdir/backup.tar.gz" "$backup_path"
mkdir "$restore_workdir/payload"
tar -xzf "$restore_workdir/backup.tar.gz" -C "$restore_workdir/payload"
(
  cd "$restore_workdir/payload"
  shasum -a 256 -c MANIFEST.sha256
)
integrity="$(sqlite3 "$restore_workdir/payload/expenses.sqlite" 'PRAGMA integrity_check;')"
[[ "$integrity" == "ok" ]] || { print -u2 "SQLite integrity check failed"; exit 1; }
print "Backup verified: $backup_path"
