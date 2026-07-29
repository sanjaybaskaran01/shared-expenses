#!/bin/zsh
set -euo pipefail

: "${EXPENSES_ENV_FILE:?Set EXPENSES_ENV_FILE to a permissions-restricted production env file}"
[[ -f "$EXPENSES_ENV_FILE" ]] || { print -u2 "Environment file does not exist"; exit 1; }

set -a
source "$EXPENSES_ENV_FILE"
set +a
: "${EXPENSES_BUN_PATH:?Set EXPENSES_BUN_PATH in the production env file}"

if [[ -n "${BETTER_AUTH_SECRET_KEYCHAIN_SERVICE:-}" ]]; then
  export BETTER_AUTH_SECRET="$(security find-generic-password -a "${USER}" -s "$BETTER_AUTH_SECRET_KEYCHAIN_SERVICE" -w)"
fi
if [[ -n "${SMTP_APP_PASSWORD_KEYCHAIN_SERVICE:-}" ]]; then
  : "${SMTP_USER:?Set SMTP_USER when using a Keychain-backed SMTP password}"
  export SMTP_APP_PASSWORD="$(security find-generic-password -a "$SMTP_USER" -s "$SMTP_APP_PASSWORD_KEYCHAIN_SERVICE" -w)"
fi
if [[ -n "${GOOGLE_CLIENT_SECRET_KEYCHAIN_SERVICE:-}" ]]; then
  : "${GOOGLE_CLIENT_ID:?Set GOOGLE_CLIENT_ID when using a Keychain-backed Google client secret}"
  export GOOGLE_CLIENT_SECRET="$(security find-generic-password -a "${USER}" -s "$GOOGLE_CLIENT_SECRET_KEYCHAIN_SERVICE" -w)"
fi

repository_root="${0:A:h:h}"
runtime_root="${0:A:h}"
if [[ -f "$runtime_root/current/server/index.js" ]]; then
  default_server_entry="$runtime_root/current/server/index.js"
else
  default_server_entry="$repository_root/apps/server/dist/index.js"
fi
server_entry="${EXPENSES_SERVER_ENTRY:-$default_server_entry}"
exec "$EXPENSES_BUN_PATH" "$server_entry"
