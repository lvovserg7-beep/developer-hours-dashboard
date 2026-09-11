#!/usr/bin/env bash
# На боевом Linux: записать CLIENT_QUALITY_INGEST_TOKEN в dashboard/.env
# и прокинуть в процесс pm2 (v2.0.2 читает токен из process.env, не только из файла).
set -euo pipefail

ROOT="${CUK_ROOT:-/node/developer-hours-dashboard}"
ENV_FILE="${ROOT}/dashboard/.env"
KEY="CLIENT_QUALITY_INGEST_TOKEN"
PM2_APP="${PM2_APP:-server}"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  echo "Usage: sudo bash set-client-quality-token.sh [токен]"
  echo "Без аргумента — генерирует случайный токен."
  echo "Тот же токен вставьте в панель сборщика на ПК (Токен выгрузки на ЦУК)."
  exit 0
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Запустите с sudo: sudo bash $0"
  exit 1
fi

if [[ -n "${1:-}" ]]; then
  TOKEN="$1"
else
  if command -v openssl >/dev/null 2>&1; then
    TOKEN="$(openssl rand -hex 32)"
  else
    TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
fi

if [[ ! "$TOKEN" =~ ^[A-Za-z0-9._~+/-]+=*$ ]]; then
  echo "Токен содержит недопустимые символы. Используйте латиницу, цифры, _ . ~ + / -"
  exit 1
fi

mkdir -p "$(dirname "$ENV_FILE")"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Нет $ENV_FILE — создаю."
  touch "$ENV_FILE"
fi

cp -a "$ENV_FILE" "${ENV_FILE}.bak.$(date +%Y%m%d%H%M%S)"

TMP="$(mktemp)"
grep -vE "^${KEY}=" "$ENV_FILE" > "$TMP" || true
printf '%s=%s\n' "$KEY" "$TOKEN" >> "$TMP"
cat "$TMP" > "$ENV_FILE"
rm -f "$TMP"

echo "Записано в $ENV_FILE"

if command -v pm2 >/dev/null 2>&1; then
  env "${KEY}=${TOKEN}" pm2 restart "${PM2_APP}" --update-env
  pm2 save
  pm2 status
else
  echo "pm2 не найден. Перезапустите процесс ЦУК сами, с переменной ${KEY}."
fi

echo
echo "Скопируйте эту же строку в панель http://127.0.0.1:8791/ → Токен выгрузки на ЦУК:"
echo "${TOKEN}"
