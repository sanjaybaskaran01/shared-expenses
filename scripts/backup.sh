#!/bin/zsh
set -euo pipefail

: "${EXPENSES_DATABASE_PATH:?Set EXPENSES_DATABASE_PATH}"
: "${EXPENSES_ATTACHMENTS_PATH:?Set EXPENSES_ATTACHMENTS_PATH}"
: "${EXPENSES_BACKUP_DESTINATION:?Set EXPENSES_BACKUP_DESTINATION}"
: "${EXPENSES_AGE_RECIPIENT:?Set EXPENSES_AGE_RECIPIENT}"

for dependency in sqlite3 age tar shasum; do
  command -v "$dependency" >/dev/null || { print -u2 "Missing dependency: $dependency"; exit 1; }
done

backup_workdir="$(mktemp -d "${TMPDIR:-/tmp}/expenses-backup.XXXXXX")"
trap 'rm -rf -- "$backup_workdir"' EXIT INT TERM
umask 077

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
snapshot_path="$backup_workdir/expenses.sqlite"
archive_path="$backup_workdir/expenses-$timestamp.tar.gz"
encrypted_name="expenses-$timestamp.tar.gz.age"

sqlite3 "$EXPENSES_DATABASE_PATH" ".backup '$snapshot_path'"
integrity="$(sqlite3 "$snapshot_path" 'PRAGMA integrity_check;')"
[[ "$integrity" == "ok" ]] || { print -u2 "SQLite integrity check failed"; exit 1; }

mkdir -p "$backup_workdir/payload/attachments"
cp "$snapshot_path" "$backup_workdir/payload/expenses.sqlite"
if [[ -d "$EXPENSES_ATTACHMENTS_PATH" ]]; then
  cp -R "$EXPENSES_ATTACHMENTS_PATH/." "$backup_workdir/payload/attachments/"
fi

(
  cd "$backup_workdir/payload"
  find . -type f ! -name MANIFEST.sha256 -exec shasum -a 256 {} \; | LC_ALL=C sort > MANIFEST.sha256
  tar -czf "$archive_path" .
)

mkdir -p "$EXPENSES_BACKUP_DESTINATION"
age -r "$EXPENSES_AGE_RECIPIENT" -o "$backup_workdir/$encrypted_name" "$archive_path"
mv "$backup_workdir/$encrypted_name" "$EXPENSES_BACKUP_DESTINATION/$encrypted_name"
print "$EXPENSES_BACKUP_DESTINATION/$encrypted_name"
