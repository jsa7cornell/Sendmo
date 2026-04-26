#!/usr/bin/env bash
# smoke.sh — post-deploy health probe.
#
# Run after a `git push` to confirm sendmo.co and the Supabase Edge Functions
# came up cleanly. Designed to fail loudly: exit 0 = healthy, exit 1 = broken.
#
# Usage:
#   ./scripts/smoke.sh                    # production (sendmo.co)
#   ./scripts/smoke.sh --url <base>       # custom base URL (e.g. preview deploy)

set -euo pipefail

APP_URL="https://sendmo.co"
SUPABASE_URL="https://fkxykvzsqdjzhurntgah.supabase.co"

if [[ "${1:-}" == "--url" && -n "${2:-}" ]]; then
  APP_URL="$2"
fi

fail=0

# Returns the HTTP status code of a request. Curl prints "000" itself on
# network failure (DNS, timeout, refused), so we don't need an `|| echo`
# fallback — that would double-print and produce "000000".
status() {
  curl -s -o /dev/null -w "%{http_code}" -m 10 "$@" 2>/dev/null
}

check() {
  local label="$1" expected="$2" actual="$3"
  if [[ ",$expected," == *",$actual,"* ]]; then
    printf "  ✓ %-40s %s\n" "$label" "$actual"
  else
    printf "  ✗ %-40s got %s, expected %s\n" "$label" "$actual" "$expected"
    fail=1
  fi
}

echo "▸ Frontend ($APP_URL)"
check "GET /"             "200"     "$(status "$APP_URL/")"
check "GET /faq"          "200"     "$(status "$APP_URL/faq")"
check "GET /login"        "200"     "$(status "$APP_URL/login")"
check "GET /nonexistent"  "200"     "$(status "$APP_URL/nonexistent-route")" # SPA rewrite -> index.html

echo
echo "▸ Edge Functions ($SUPABASE_URL/functions/v1)"
check "GET tracking?number=BOGUS" "200,404" "$(status "$SUPABASE_URL/functions/v1/tracking?number=BOGUS")"
check "OPTIONS addresses (CORS)"  "200,204" "$(status -X OPTIONS "$SUPABASE_URL/functions/v1/addresses")"
check "OPTIONS rates (CORS)"      "200,204" "$(status -X OPTIONS "$SUPABASE_URL/functions/v1/rates")"
check "OPTIONS links (CORS)"      "200,204" "$(status -X OPTIONS "$SUPABASE_URL/functions/v1/links")"
check "OPTIONS email (CORS)"      "200,204" "$(status -X OPTIONS "$SUPABASE_URL/functions/v1/email")"

echo
if [[ $fail -eq 0 ]]; then
  echo "✓ Smoke checks passed."
  exit 0
else
  echo "✗ Smoke checks FAILED. Investigate before assuming deploy is healthy."
  exit 1
fi
