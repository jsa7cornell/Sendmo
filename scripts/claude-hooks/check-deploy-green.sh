#!/usr/bin/env bash
#
# Stop hook — SendMo PLAYBOOK Rule 21 advisory.
# At session close, if the working branch is `main`, reports the deploy/CI
# status of the current `main` HEAD so a red or still-running deploy is never
# left unnoticed.
#
# Covers both surfaces a push to `main` triggers:
#   - GitHub Actions  → check-runs  ("Lint, Unit, and E2E Tests",
#                                    "Deploy changed Edge Functions")
#   - Vercel          → commit status (context "Vercel")
#
# Advisory only. Exits 0. The blocking gate is agent duty (Rule 21); this hook
# surfaces the status at the moment it would otherwise be forgotten.
#
# Reference incident: 2026-05-21 — a `tsc -b` error sat red on Vercel + CI for
# ~18h across 5 pushes because no agent checked the deploy after pushing.
#
# Sibling: scripts/claude-hooks/check-browser-verified.sh (Rule 19).
# Registered in: sendmo/.claude/settings.json under hooks.Stop.

set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$PROJECT_DIR" || exit 0

# Rule 21 is about pushes to main — only act when the working branch is main.
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
[ "$BRANCH" = "main" ] || exit 0

# Need gh, authenticated, to query CI/deploy status. Bail silently otherwise.
command -v gh >/dev/null 2>&1 || exit 0
gh auth status >/dev/null 2>&1 || exit 0

SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
[ -n "$SHA" ] || exit 0
SLUG=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "")
[ -n "$SLUG" ] || exit 0

# GitHub Actions jobs (check-runs) + Vercel (commit status), one line each:
#   <name>\t<RED|PENDING|GREEN>
ROWS=$(
  {
    gh api "repos/$SLUG/commits/$SHA/check-runs" \
      --jq '.check_runs[] | .name + "\t" + (
        if .status != "completed" then "PENDING"
        elif (.conclusion // "") | test("^(success|neutral|skipped)$") then "GREEN"
        else "RED" end)' 2>/dev/null || true
    gh api "repos/$SLUG/commits/$SHA/status" \
      --jq '.statuses[] | .context + "\t" + (
        if .state == "success" then "GREEN"
        elif .state == "pending" then "PENDING"
        else "RED" end)' 2>/dev/null || true
  }
)

# No checks reported yet — CI may not have registered. Nudge, don't assert.
if [ -z "$ROWS" ]; then
  cat <<EOF >&2

────────────────────────────────────────────────────────────────────────
[Stop hook · SendMo PLAYBOOK Rule 21 reminder]

On branch \`main\` at ${SHA:0:7}, but no CI/deploy checks are reporting yet.
If you pushed this session, wait for them to register, then confirm green:
  gh run list --branch main --limit 5
────────────────────────────────────────────────────────────────────────

EOF
  exit 0
fi

RED=$(echo "$ROWS" | awk -F'\t' '$2=="RED"' || true)
PENDING=$(echo "$ROWS" | awk -F'\t' '$2=="PENDING"' || true)

# All green — nothing to surface.
if [ -z "$RED" ] && [ -z "$PENDING" ]; then
  exit 0
fi

{
  echo ""
  echo "────────────────────────────────────────────────────────────────────────"
  echo "[Stop hook · SendMo PLAYBOOK Rule 21 reminder]"
  echo ""
  echo "Deploy/CI status for \`main\` HEAD (${SHA:0:7}):"
  echo ""
  echo "$ROWS" | sed 's/^/  /'
  echo ""
  if [ -n "$RED" ]; then
    echo "  ⛔ A check is RED. A red \`main\` is a production deploy failure —"
    echo "     the work is NOT done. Fix forward immediately (Rule 21)."
  fi
  if [ -n "$PENDING" ]; then
    echo "  ⏳ A check is still running. CI takes ~12 min — wait for a"
    echo "     conclusive result before calling the work done:"
    echo "       gh run watch \$(gh run list --branch main --limit 1 --json databaseId -q '.[0].databaseId')"
  fi
  echo ""
  echo "This is advisory — hook exits 0. Satisfying Rule 21 is agent duty."
  echo "────────────────────────────────────────────────────────────────────────"
  echo ""
} >&2

exit 0
