#!/usr/bin/env bash
#
# SessionStart hook — is what you are about to read current?
#
# WHY THIS EXISTS
# On 2026-08-19 a session read the whole repo from a branch that had been
# merged (PR #64) and left checked out. It was 44 commits behind origin/main.
# Every file it cited was stale, and it produced a proposal re-proposing five
# merged PRs and two shipped migrations. The same class of failure had already
# happened twice before (2026-07-06 duplicate-arc; 2026-08-18 stale docs).
#
# The trap is that the usual commands cannot show it:
#   • `git log --oneline`  shows the history you are standing on.
#   • `git status`         compares against the BRANCH'S OWN upstream
#                          (origin/fix/e2e-infra-audit), which was in sync —
#                          so git correctly reported everything was fine.
# Only a direct HEAD..origin/main comparison reveals the gap, and nobody runs
# it unprompted. Hence a hook rather than a rule in a doc: written guidance
# already existed for this and did not hold three times running.
#
# DESIGN
#   • Never fetches. A network call at session start is a latency and failure
#     surface, and the incident proves it is unnecessary — the local
#     origin/main ref was already current. Report fetch age instead and let
#     the agent decide.
#   • Silence means correct. No "all clear" line: noise on every session start
#     is exactly how a warning becomes wallpaper.
#   • Always exits 0. Advisory only. A SessionStart hook that can block or
#     hang is worse than the failure it prevents.
#   • Tiered by severity so a legitimately-resumed one-day-old PR branch does
#     not get the same banner as a dead branch 44 behind (twelve PRs merged in
#     ~22h on 2026-08-18, so "a few commits behind" is normal and healthy).
#
set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

# The remote-tracking ref may legitimately not exist (fresh clone of a fork,
# renamed default branch). Nothing to compare against, so say nothing.
git rev-parse --verify --quiet refs/remotes/origin/main >/dev/null 2>&1 || exit 0

behind=$(git rev-list --count HEAD..origin/main 2>/dev/null) || exit 0
ahead=$(git rev-list --count origin/main..HEAD 2>/dev/null) || exit 0

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
[ "$branch" = "HEAD" ] && branch="a detached HEAD"

# FETCH_HEAD lives in the COMMON git dir. In a linked worktree `.git` is a
# file, not a directory, so reading ./.git/FETCH_HEAD silently misses and
# reports an epoch-age fetch (~496436h). Ask git where it actually is.
common_dir=$(git rev-parse --git-common-dir 2>/dev/null)
fetch_head="${common_dir}/FETCH_HEAD"
if [ -f "$fetch_head" ]; then
  now=$(date +%s)
  # BSD stat (macOS) first, GNU stat second.
  mtime=$(stat -f %m "$fetch_head" 2>/dev/null || stat -c %Y "$fetch_head" 2>/dev/null)
  if [ -n "${mtime:-}" ]; then
    fetch_age_h=$(( (now - mtime) / 3600 ))
    fetch_label="${fetch_age_h}h ago"
  else
    fetch_age_h=-1
    fetch_label="unknown"
  fi
else
  # No FETCH_HEAD at all — never fetched in this clone. Not "epoch ago".
  fetch_age_h=-1
  fetch_label="never"
fi

# ── Current tree ───────────────────────────────────────────────────────────
# Being level with origin/main only certifies HEAD against the LOCAL snapshot
# of it. This incident's snapshot happened to be fresh because a push had
# updated it; after an offline stretch it will not be. One quiet line.
if [ "$behind" -eq 0 ]; then
  if [ "$fetch_age_h" -ge 24 ] || [ "$fetch_age_h" -lt 0 ]; then
    echo "ℹ Level with the local origin/main ref, but last fetch: ${fetch_label}. \`git fetch origin\` before trusting it."
  fi
  exit 0
fi

# ── Behind, but plausibly an active branch ─────────────────────────────────
# Quiet at 1-4 so ordinary in-flight work does not train you to ignore this.
if [ "$behind" -lt 5 ]; then
  echo "ℹ '${branch}' is ${behind} behind origin/main (${ahead} ahead). Last fetch: ${fetch_label}."
  exit 0
fi

# ── Meaningfully stale ─────────────────────────────────────────────────────
echo "⚠ STALE TREE — you are on '${branch}', ${behind} commits behind origin/main (${ahead} ahead)."
echo "  Last fetch: ${fetch_label}."

# A branch whose tip is already an ancestor of origin/main has been merged;
# every commit on it is in main and there is nothing to preserve. That is a
# materially different situation from an active branch with unmerged work,
# and it was this incident's exact shape.
if git merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
  echo "  This branch is already MERGED into origin/main — it holds nothing main lacks."
fi

echo "  Everything you read — source, migrations, proposals, LOG — is ${behind} commits out of date."

missing_migrations=$(git diff --name-only --diff-filter=A HEAD origin/main -- supabase/migrations/ 2>/dev/null | head -8)
if [ -n "$missing_migrations" ]; then
  echo "  Missing migrations:"
  echo "$missing_migrations" | sed 's/^/    /'
fi

missing_proposals=$(git diff --name-only --diff-filter=A HEAD origin/main -- proposals/ 2>/dev/null | head -8)
if [ -n "$missing_proposals" ]; then
  echo "  Missing proposals:"
  echo "$missing_proposals" | sed 's/^/    /'
fi

echo "  Fix: git fetch origin && git worktree add .claude/worktrees/<slug> -b claude/<slug> origin/main"

exit 0
