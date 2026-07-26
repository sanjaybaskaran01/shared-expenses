#!/bin/zsh
set -euo pipefail

: "${EXPENSES_ENV_FILE:?Set EXPENSES_ENV_FILE to a permissions-restricted production env file}"
[[ -f "$EXPENSES_ENV_FILE" ]] || { print -u2 "Environment file does not exist"; exit 1; }

set -a
source "$EXPENSES_ENV_FILE"
set +a
: "${EXPENSES_BUN_PATH:?Set EXPENSES_BUN_PATH in the production env file}"

repository_root="${0:A:h:h}"
exec "$EXPENSES_BUN_PATH" "$repository_root/apps/server/dist/index.js"
