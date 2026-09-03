#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-http://127.0.0.1:3001}"
curl --fail --silent --show-error --max-time 10 --retry 3 --retry-delay 2 "${base_url%/}/api/health"
printf '\n'
curl --fail --silent --show-error --max-time 10 --retry 3 --retry-delay 2 "${base_url%/}/api/ready" >/dev/null
curl --fail --silent --show-error --max-time 10 "${base_url%/}/" | grep -q '<title>Scout'

if docker compose version >/dev/null 2>&1; then
  docker compose exec -T chromium node -e 'fetch("http://127.0.0.1:3000/pressure").then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))'
  docker compose exec -T scout node -e 'fetch("http://127.0.0.1:3001/api/settings").then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))'
fi

printf 'Compose readiness, dashboard delivery, and Browserless checks passed at %s\n' "${base_url%/}"
