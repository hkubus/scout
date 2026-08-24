#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-http://127.0.0.1:3001}"
curl --fail --silent --show-error "${base_url%/}/api/health"
printf '\nCompose health endpoint is reachable at %s\n' "${base_url%/}"
