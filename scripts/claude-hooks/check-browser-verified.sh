#!/usr/bin/env bash
#
# Stop hook — SendMo PLAYBOOK Rule 19 advisory.
# Reminds the agent at session close to include a `Browser-verified:` block in
# the LOG entry if product-surface files were modified.
#
# Advisory only. Exits 0. The rule is in PLAYBOOK §19; this hook surfaces the
# rule at the moment it would otherwise be forgotten.
#
# Sibling: agentenvoy/app/scripts/claude-hooks/check-browser-verified.sh (Rule 29).
# Registered in: sendmo/.claude/settings.json under hooks.Stop.

set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$PROJECT_DIR" || exit 0

CHANGED=$(git status --porcelain 2>/dev/null | awk '{print $2}' || true)

if [ -z "$CHANGED" ]; then
  exit 0
fi

# Product-surface globs per Rule 19. Keep in sync with the rule body.
SURFACE_HIT=$(echo "$CHANGED" | grep -E '^(src/components/|src/pages/|src/hooks/|supabase/functions/|src/contexts/)' || true)

if [ -z "$SURFACE_HIT" ]; then
  exit 0
fi

# Check whether LOG.md picked up a Browser-verified block. We look for the
# structured-block sub-keys (spec / mcp-session / n/a-category), not the
# `Browser-verified:` string itself — that string also appears in doc references
# inside the LOG.md header which would cause false-negatives.
LOG_DIFF=$(git diff -- LOG.md 2>/dev/null | grep -E '^\+\s*(spec|mcp-session|n/a-category):' || true)
LOG_STAGED=$(git diff --cached -- LOG.md 2>/dev/null | grep -E '^\+\s*(spec|mcp-session|n/a-category):' || true)

if [ -n "$LOG_DIFF" ] || [ -n "$LOG_STAGED" ]; then
  exit 0
fi

cat <<EOF >&2

────────────────────────────────────────────────────────────────────────
[Stop hook · SendMo PLAYBOOK Rule 19 reminder]

Files modified this session touch product surface:

$(echo "$SURFACE_HIT" | sed 's/^/  /')

Rule 19 requires the LOG entry to include a structured \`Browser-verified:\` block.
Three valid shapes (exactly one):

  Browser-verified:
    spec: tests/e2e/<path>.spec.ts
    variants-covered: [<list of variants exercised>]

  Browser-verified:
    mcp-session: <snapshot/screenshot artifact path>
    variants-covered: [<list of variants exercised>]

  Browser-verified:
    n/a-category: pure-logic | agent-internal | infra | copy-only | migration
    n/a-reason: <one line — why no DOM/wire-shape consumer is affected>

If you haven't run a browser check yet:
  - Playwright MCP (in-conversation): \`browser_navigate\` → \`browser_snapshot\` → assert
  - npm script (CI shape):           \`npm run test:e2e:browser\`
  - Full rule:                       PLAYBOOK.md §19

This is advisory — hook exits 0. The blocking gate is reviewer duty (Rule 19).
────────────────────────────────────────────────────────────────────────

EOF

exit 0
