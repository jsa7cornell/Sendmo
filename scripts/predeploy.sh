#!/usr/bin/env bash
# predeploy.sh — run BEFORE pushing to main.
#
# Catches the failure modes Vercel's build won't:
#   - Type errors that vitest/esbuild silently strip
#   - Lint regressions
#   - Broken unit tests
#   - Forgotten Supabase migrations and Edge Function deploys
#
# Vercel auto-deploys the FRONTEND on every push to main. Supabase deploys
# are MANUAL — this script automates them so you stop shipping a frontend
# that depends on an Edge Function or migration that isn't live yet.
#
# Usage:
#   ./scripts/predeploy.sh                 # frontend checks only
#   ./scripts/predeploy.sh --with-supabase # also push migrations + deploy edge functions
#   ./scripts/predeploy.sh --supabase-only # skip frontend checks (useful after a frontend-clean run)

set -euo pipefail

PROJECT_REF="fkxykvzsqdjzhurntgah"
MODE="${1:-frontend}"

run_frontend() {
  echo "▸ Type check (tsc -b --noEmit)..."
  npx tsc -b --noEmit

  echo "▸ Lint (non-blocking — 60+ pre-existing errors; surface count, don't gate)..."
  if ! npm run lint; then
    echo "  ⚠ Lint failed. NOT blocking the deploy — but please don't add new errors."
  fi

  echo "▸ Unit tests..."
  npm run test:unit
}

run_supabase() {
  if ! command -v supabase >/dev/null 2>&1 && ! npx --no-install supabase --version >/dev/null 2>&1; then
    echo "✗ supabase CLI not found. Install it or run: npm i -g supabase"
    exit 1
  fi

  echo "▸ Push migrations..."
  npx supabase db push --project-ref "$PROJECT_REF"

  echo "▸ Deploy edge functions (skipping empty dirs)..."
  for fn in supabase/functions/*/; do
    name=$(basename "$fn")
    [[ "$name" == _* ]] && continue
    if [[ ! -f "$fn/index.ts" ]]; then
      echo "  — skip $name (no index.ts)"
      continue
    fi
    echo "  — deploy $name"
    npx supabase functions deploy "$name" --project-ref "$PROJECT_REF"
  done
}

case "$MODE" in
  frontend)
    run_frontend
    echo "✓ Frontend checks passed."
    echo "  Note: did you change anything under supabase/? Re-run with --with-supabase."
    ;;
  --with-supabase)
    run_frontend
    run_supabase
    echo "✓ Frontend + Supabase deploy complete. Safe to git push."
    ;;
  --supabase-only)
    run_supabase
    echo "✓ Supabase deploy complete."
    ;;
  *)
    echo "Unknown mode: $MODE"
    echo "Usage: $0 [--with-supabase|--supabase-only]"
    exit 2
    ;;
esac
