#!/usr/bin/env bash
#
# SessionStart hook — is what you are about to read current?
# Registered in: sendmo/.claude/settings.json
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
#   • Silence means correct. No "all clear" line, and no speculation: if the
#     fetch age cannot be determined, say nothing rather than nag. Noise on
#     every session start is exactly how a warning becomes wallpaper.
#   • Always exits 0, and never prints a shell error. Advisory only.
#   • Tiered by severity so a legitimately-resumed one-day-old PR branch does
#     not get the same banner as a dead branch 44 behind (twelve PRs merged in
#     ~22h on 2026-08-18, so "a few commits behind" is normal and healthy).
#
set -uo pipefail

# Match the sibling hooks (check-browser-verified.sh, check-deploy-green.sh):
# fall back to the script's own location, never to `.`. A bare `.` reports on
# whatever directory the session happened to start in, which may be a
# different clone entirely.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$PROJECT_DIR" 2>/dev/null || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

# Pathspecs below resolve relative to CWD, so a session started in a subdir
# would silently list no missing migrations or proposals. Anchor at the root.
toplevel=$(git rev-parse --show-toplevel 2>/dev/null) && cd "$toplevel" 2>/dev/null

# Always compare against the fully-qualified remote ref. The bare shorthand
# `origin/main` resolves refs/heads/ FIRST, so a local branch literally named
# "origin/main" silently shadows the remote and every count comes back 0 —
# the hook would go quiet on exactly the tree it exists to flag.
REF=refs/remotes/origin/main
git rev-parse --verify --quiet "$REF" >/dev/null 2>&1 || exit 0

# ── Unborn HEAD ────────────────────────────────────────────────────────────
# Zero commits but origin/main is fetched: you hold NONE of main. That is
# maximum staleness, and rev-list would fail here and be swallowed silently.
if ! git rev-parse --verify --quiet HEAD >/dev/null 2>&1; then
  main_count=$(git rev-list --count "$REF" 2>/dev/null || echo "?")
  echo "⚠ EMPTY TREE — no commits checked out, but origin/main has ${main_count}."
  echo "  Fix: git checkout main"
  exit 0
fi

behind=$(git rev-list --count "HEAD..$REF" 2>/dev/null) || exit 0
ahead=$(git rev-list --count "$REF..HEAD" 2>/dev/null) || exit 0

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
[ "$branch" = "HEAD" ] && branch="detached HEAD"

# ── Fetch age ─────────────────────────────────────────────────────────────
# FETCH_HEAD is PER-WORKTREE, not a common-dir file — it is absent from git's
# common_list[], so `git fetch` writes it under .git/worktrees/<name>/. An
# earlier version read --git-common-dir and was therefore reading a file git
# never writes for that worktree: it reported another worktree's fetch time,
# and in the worst shape its own remediation could not clear its own warning
# (fetch here, the nag reads the other worktree's stale mtime, repeat forever).
# This repo has nine worktrees, so that was the common case, not an edge one.
# `--git-path` is the canonical resolver and is correct in both layouts.
#
# KNOWN LIMIT, deliberately accepted: any fetch rewrites FETCH_HEAD, including
# one that never touched main (`gh pr checkout` fetches refs/pull/N/head), so
# this age can read fresher than origin/main really is. The reflog of
# refs/remotes/origin/main was evaluated as an alternative and is worse — it
# only records when the ref MOVED, so a repo fetched hourly whose main has not
# moved in three days reports three days, and it is empty in a fresh clone.
# This line is a hint; the behind-count above it is the real signal.
fetch_head=$(git rev-parse --git-path FETCH_HEAD 2>/dev/null)
mtime=""
if [ -n "$fetch_head" ] && [ -f "$fetch_head" ]; then
  # GNU and BSD disagree on stat's flags and getting the order wrong is silent:
  # GNU's -f is --file-system and takes no argument, so `stat -f %m FILE` reads
  # %m as a filename, prints a filesystem block and exits non-zero. GNU form
  # first, BSD second, both muted.
  mtime=$(stat -c %Y "$fetch_head" 2>/dev/null) || mtime=$(stat -f %m "$fetch_head" 2>/dev/null) || mtime=""
fi

now=$(date +%s 2>/dev/null)
# `date` is the one external call whose failure could otherwise be swallowed by
# the skew clamp below and rendered as a reassuring "0h ago" — an unreadable
# clock must read as unknown, not as just-fetched.
case "${now:-x}" in *[!0-9]*|'') now="" ;; esac

fetch_age_h=-1
fetch_label="unknown"
case "${mtime:-x}" in
  *[!0-9]*) : ;;                     # non-numeric (incl. empty via the :-x) → unknown
  *)
    if [ -n "$now" ]; then
      # 10# forces base 10. An all-digit value is NOT automatically safe for
      # $(( )): a leading zero is parsed as octal, and 8/9 are invalid octal
      # digits, which errors mid-branch and leaves these variables unset —
      # fatal under `set -u`.
      fetch_age_h=$(( (10#$now - 10#$mtime) / 3600 ))
      # Clock skew (VM resume, restored backup, drifting container clock) must
      # never render as a negative hour count.
      [ "$fetch_age_h" -lt 0 ] && fetch_age_h=0
      fetch_label="${fetch_age_h}h ago"
    fi
    ;;
esac

# ── Current tree ───────────────────────────────────────────────────────────
# Being level with origin/main only certifies HEAD against the LOCAL snapshot
# of it. Warn only when the age is KNOWN and genuinely old: a fresh clone has
# no FETCH_HEAD at all, and nagging the freshest possible state is how the
# warning loses its force.
if [ "$behind" -eq 0 ]; then
  if [ "$fetch_age_h" -ge 24 ]; then
    echo "ℹ Level with the local origin/main ref, but last fetch: ${fetch_label}. \`git fetch origin\` before trusting it."
  fi
  exit 0
fi

# ── Behind, but plausibly an active branch ─────────────────────────────────
# Silent at 1-4. Twelve PRs merged in ~22h on 2026-08-18, so any live feature
# branch is a few commits behind within minutes — printing here would fire on
# nearly every session start, which is precisely how a warning becomes
# wallpaper. An earlier version printed a one-liner and was observed doing
# exactly that on a real worktree. The incident this hook exists for was 44
# behind; 5 is the threshold where "behind" stops being ordinary.
if [ "$behind" -lt 5 ]; then
  exit 0
fi

# ── Meaningfully stale ─────────────────────────────────────────────────────
echo "⚠ STALE TREE — you are on '${branch}', ${behind} commits behind origin/main (${ahead} ahead)."
echo "  Last fetch: ${fetch_label}."

# A branch whose tip is already an ancestor of origin/main has been merged;
# every commit on it is in main and there is nothing to preserve. That is a
# materially different situation from an active branch with unmerged work,
# and it was this incident's exact shape.
if git merge-base --is-ancestor HEAD "$REF" 2>/dev/null; then
  echo "  This branch is already MERGED into origin/main — it holds nothing main lacks."
fi

echo "  Everything you read — source, migrations, proposals, LOG — is ${behind} commits out of date."

# Truncate loudly, never silently (PLAYBOOK: "No silent caps").
list_missing() {
  local label=$1 path=$2 all n
  all=$(git diff --name-only --diff-filter=A "HEAD..$REF" -- "$path" 2>/dev/null) || return 0
  [ -z "$all" ] && return 0
  n=$(printf '%s\n' "$all" | wc -l | tr -d ' ')
  echo "  Missing ${label}:"
  printf '%s\n' "$all" | head -8 | sed 's/^/    /'
  [ "$n" -gt 8 ] && echo "    …and $(( n - 8 )) more"
  return 0
}
list_missing "migrations" "supabase/migrations/"
list_missing "proposals"  "proposals/"

echo "  Fix: git fetch origin && git worktree add .claude/worktrees/<slug> -b claude/<slug> origin/main"

exit 0
