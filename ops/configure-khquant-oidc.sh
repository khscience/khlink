#!/usr/bin/env bash
set -euo pipefail

ENV_FILE=/etc/fengzhu-agent-bridge.env
BACKUP="${ENV_FILE}.before-kh-link-oidc-$(date -u +%Y%m%dT%H%M%SZ)"
cp -a "$ENV_FILE" "$BACKUP"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

grep -v '^KHQUANT_OIDC_' "$ENV_FILE" > "$TMP"
cat >> "$TMP" <<'EOF'
KHQUANT_OIDC_ISSUER=https://khsci.com/khQuant/
KHQUANT_OIDC_CLIENT_ID=kh-link-desktop
KHQUANT_OIDC_AUTHORIZE_URL=https://khsci.com/khQuant/?kh_link_oauth=authorize
KHQUANT_OIDC_TOKEN_URL=https://khsci.com/khQuant/wp-json/kh-link/v1/token
KHQUANT_OIDC_PROFILE_URL=https://khsci.com/khQuant/wp-json/kh-link/v1/profile
KHQUANT_OIDC_ENTITLEMENT_URL=https://khsci.com/khQuant/wp-json/kh-link/v1/entitlement
EOF
install -o root -g root -m 600 "$TMP" "$ENV_FILE"
systemctl daemon-reload
systemctl restart fengzhu-agent-bridge.service
systemctl is-active --quiet fengzhu-agent-bridge.service
printf 'configured and restarted; backup=%s\n' "$BACKUP"
