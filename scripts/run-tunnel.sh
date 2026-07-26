#!/bin/zsh
set -euo pipefail

: "${CLOUDFLARED_PATH:?Set CLOUDFLARED_PATH to the cloudflared executable}"
: "${CLOUDFLARED_TOKEN_KEYCHAIN_SERVICE:?Set CLOUDFLARED_TOKEN_KEYCHAIN_SERVICE}"

export TUNNEL_TOKEN="$(security find-generic-password \
  -a "${CLOUDFLARED_TOKEN_KEYCHAIN_ACCOUNT:-$USER}" \
  -s "$CLOUDFLARED_TOKEN_KEYCHAIN_SERVICE" \
  -w)"

exec "$CLOUDFLARED_PATH" tunnel --protocol "${CLOUDFLARED_PROTOCOL:-auto}" run
