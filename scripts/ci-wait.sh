#!/usr/bin/env bash
#
# Wait for a PR's CI to reach a conclusive result, then report it.
#
# Replaces the hand-rolled `until [ "$(gh run view ...)" = "completed" ]` loops
# that agents keep writing. Those loops share one bug: they compare a command
# substitution against a literal, so ANY gh failure — an empty run id, a 404, a
# rate limit — yields "", which never equals "completed", and the loop sleeps
# forever. On 2026-08-19 one ran 6h23m against a run that had finished in 3m45s.
# It only stopped because it had been launched as a background task, which is
# exempt from the agent Bash tool's 10-minute ceiling.
#
# This wraps `gh pr checks --watch`, the supported scripted waiter, and closes
# the three gaps it has on its own:
#
#   1. Queue race. GitHub takes 30-90s to register checks after a push. Called
#      in that window, `gh pr checks` exits 1 with "no checks reported" — which
#      a naive caller reads as failure. We retry until QUEUE_GRACE elapses.
#   2. No deadline. Neither `gh pr checks --watch` nor `gh run watch` bounds its
#      own runtime, and macOS ships no timeout(1) to wrap them with. We enforce
#      one ourselves.
#   3. Absence is not a pass. A PR with merge conflicts gets NO check-suite at
#      all: `gh pr checks` shows only Vercel green, which reads exactly like
#      "checks are fine" (PLAYBOOK Rule 21; incident 2026-08-18, PR #64 sat
#      with zero test coverage while the session reported "waiting on CI").
#      We require a github-actions suite on the head SHA before trusting green.
#
# THE INVARIANT, learned from the loop this replaces: never report a negative
# answer when what you actually have is NO answer. The 6h loop treated "gh
# failed" as "not finished yet". The first cut of this script treated "the API
# call errored" as "no tests ran". Both are the same mistake. Anything this
# script cannot determine exits 2, never 0 or 1.
#
# Two modes. With a PR (the usual case) it waits on that PR's checks. With no
# PR — pushes to `main`, which is where PLAYBOOK Rule 21 actually applies — it
# falls back to waiting on the checks for the current commit. The first cut had
# no fallback, so the Rule 21 Stop hook, which fires ONLY on main, recommended a
# command that could only ever exit 2 there.
#
# Usage:  scripts/ci-wait.sh [<pr-number>|<branch>]     # defaults to current branch
# Exit:   0 = conclusive green
#         1 = conclusive bad — red, or confirmed no tests ran
#         2 = INDETERMINATE — timed out, interrupted, or could not reach GitHub
#
# Env:    CI_WAIT_DEADLINE     overall seconds before giving up  (default 900)
#         CI_WAIT_QUEUE_GRACE  seconds to allow for queueing     (default 120)

set -uo pipefail

TARGET="${1:-}"
DEADLINE="${CI_WAIT_DEADLINE:-900}"
QUEUE_GRACE="${CI_WAIT_QUEUE_GRACE:-120}"

command -v gh >/dev/null 2>&1 || { echo "ci-wait: gh not installed" >&2; exit 2; }
gh auth status >/dev/null 2>&1 || { echo "ci-wait: gh not authenticated" >&2; exit 2; }

# `gh -q` throughout, never a raw `jq` pipe: gh embeds its own jq, so shelling
# out adds a dependency that is not otherwise required and was not checked for.
pr_field() { gh pr view ${TARGET:+"$TARGET"} --json "$1" -q ".$1" 2>/dev/null; }

SLUG=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)
if [ -z "$SLUG" ]; then
  echo "ci-wait: could not determine the repository (gh repo view failed)." >&2
  exit 2
fi

PR=$(pr_field number)
SHA=$(pr_field headRefOid)

# ---------------------------------------------------------------- commit mode
# No PR for this ref. Wait on the current commit's checks instead of refusing.
# Queries check-runs (GitHub Actions) and the commit status (Vercel) — the same
# two surfaces a push to `main` triggers, and the same pair
# scripts/claude-hooks/check-deploy-green.sh already reads, rather than a second
# way of asking the same question.
if [ -z "$PR" ] || [ -z "$SHA" ]; then
  SHA=$(git rev-parse HEAD 2>/dev/null)
  if [ -z "$SHA" ]; then
    echo "ci-wait: no PR for '${TARGET:-current branch}' and no git HEAD to fall back to." >&2
    exit 2
  fi
  echo "ci-wait: no PR for '${TARGET:-current branch}' — waiting on commit ${SHA:0:7} (deadline ${DEADLINE}s)"

  commit_rows() {
    gh api "repos/$SLUG/commits/$SHA/check-runs" \
      --jq '.check_runs[] | .name + "\t" + (
        if .status != "completed" then "PENDING"
        elif (.conclusion // "") | test("^(success|neutral|skipped)$") then "GREEN"
        else "RED" end)' 2>/dev/null
    gh api "repos/$SLUG/commits/$SHA/status" \
      --jq '.statuses[] | .context + "\t" + (
        if .state == "success" then "GREEN"
        elif .state == "pending" then "PENDING"
        else "RED" end)' 2>/dev/null
  }

  START=$SECONDS
  DEADLINE_AT=$((SECONDS + DEADLINE))
  while true; do
    ROWS=$(commit_rows)
    if [ -z "$ROWS" ]; then
      # Same queue race as PR mode, same rule: no checks yet is not a verdict.
      if [ $((SECONDS - START)) -ge "$QUEUE_GRACE" ]; then
        echo "ci-wait: no checks registered on ${SHA:0:7} after ${QUEUE_GRACE}s." >&2
        echo "         Absence of a run is not a pass. Was this commit pushed?" >&2
        exit 1
      fi
      sleep 5; continue
    fi
    echo "$ROWS" | grep -q "PENDING" || break
    if [ "$SECONDS" -ge "$DEADLINE_AT" ]; then
      echo "$ROWS" | sed 's/^/  /'
      echo "ci-wait: still pending after ${DEADLINE}s — no verdict." >&2
      exit 2
    fi
    sleep 10
  done

  echo "$ROWS" | sed 's/^/  /'
  if echo "$ROWS" | grep -q "RED"; then
    echo "ci-wait: commit ${SHA:0:7} is RED." >&2
    exit 1
  fi
  # Same suite requirement as PR mode: Vercel green alone is not tests passing.
  # This matches the job name from .github/workflows/test.yml. Renaming that job
  # without updating this string fails LOUDLY ("NO TESTS RAN") rather than
  # silently passing — the safe direction for a check whose whole purpose is to
  # refuse to call an unverified commit green.
  if ! echo "$ROWS" | grep -q "Lint, Unit, and E2E Tests"; then
    echo "ci-wait: no \"Lint, Unit, and E2E Tests\" run on ${SHA:0:7} — NO TESTS RAN." >&2
    exit 1
  fi
  echo "ci-wait: commit ${SHA:0:7} is green and the test workflow reported. Conclusive."
  exit 0
fi
# ------------------------------------------------------------------- PR mode

echo "ci-wait: PR #$PR @ ${SHA:0:7} (deadline ${DEADLINE}s)"

# Gap 3, first half. A conflicting PR will never produce a run, so waiting for
# one is waiting forever.
#
# mergeStateStatus is computed LAZILY by GitHub and reads UNKNOWN for a window
# after every push — measured 2026-08-19: PRs #85/#86/#87 all UNKNOWN, only the
# idle #88 CLEAN. A guard that only tests for DIRTY is therefore inert in
# exactly the post-push case it exists for. Querying is itself what triggers the
# computation, so poll briefly for a definite answer.
merge_state() { gh pr view "$PR" --json mergeStateStatus -q .mergeStateStatus 2>/dev/null; }

conflict_check() {
  case "$(merge_state)" in
    DIRTY|CONFLICTING)
      echo "ci-wait: PR #$PR has merge conflicts — GitHub creates NO workflow run" >&2
      echo "         for a PR it cannot merge. Resolve, then re-run." >&2
      exit 1 ;;
  esac
}

MS_START=$SECONDS
while [ "$(merge_state)" = "UNKNOWN" ] && [ $((SECONDS - MS_START)) -lt 30 ]; do
  sleep 3
done
conflict_check

# Gap 1. Poll until checks register or the grace period runs out.
START=$SECONDS
while true; do
  OUT=$(gh pr checks "$PR" 2>&1); RC=$?
  # Exit 8 = pending, 0 = all done. Either means checks exist; stop waiting.
  { [ "$RC" -eq 0 ] || [ "$RC" -eq 8 ]; } && break
  case "$OUT" in
    *"no checks reported"*) : ;;   # queue race — keep waiting
    *) echo "ci-wait: gh pr checks failed:" >&2; echo "$OUT" | sed 's/^/  /' >&2; exit 2 ;;
  esac
  if [ $((SECONDS - START)) -ge "$QUEUE_GRACE" ]; then
    # Before blaming the queue, re-ask about conflicts: mergeability may have
    # resolved to DIRTY while we waited, which is the real, actionable reason
    # no checks ever appeared.
    conflict_check
    echo "ci-wait: no checks registered after ${QUEUE_GRACE}s — nothing is running." >&2
    echo "         Not a timeout on a slow run; no run exists to wait for." >&2
    exit 1
  fi
  sleep 5
done

# Gap 2. `gh pr checks --watch` blocks with no timeout of its own. Supervise it
# from THIS shell rather than a background `( sleep N; kill )` watchdog: killing
# such a watchdog kills the subshell but orphans the `sleep` inside it, which
# then survives reparented to init for the full deadline — one stray process per
# invocation, confirmed with ps.
#
# --fail-fast returns as soon as one check goes red rather than waiting out the
# healthy ones. Output is discarded because --watch reprints the whole checks
# table every interval; on a 4-minute run that is ~24 near-identical blocks in
# the caller's log. One authoritative re-query below covers every path.
echo "ci-wait: watching (quiet) — final result below"
gh pr checks "$PR" --watch --fail-fast --interval 10 >/dev/null 2>&1 &
WATCHER=$!

TIMED_OUT=0
DEADLINE_AT=$((SECONDS + DEADLINE))
while kill -0 "$WATCHER" 2>/dev/null; do
  if [ "$SECONDS" -ge "$DEADLINE_AT" ]; then
    TIMED_OUT=1
    kill "$WATCHER" 2>/dev/null
    break
  fi
  sleep 2
done
wait "$WATCHER"; RC=$?

gh pr checks "$PR" 2>/dev/null | sed 's/^/  /'

# An explicit flag, not `RC -gt 128`: `wait` returns 128+N for EVERY signal, so
# testing the range reports a user's Ctrl-C (130) as "still not conclusive after
# 900s", asserting a deadline that never elapsed.
if [ "$TIMED_OUT" -eq 1 ]; then
  echo "ci-wait: still not conclusive after ${DEADLINE}s — killed the watcher." >&2
  echo "         This is a stuck run, not a slow one. Inspect it:" >&2
  echo "           gh run list --branch \$(git branch --show-current) --limit 3" >&2
  exit 2
fi
if [ "$RC" -gt 128 ]; then
  echo "ci-wait: watcher was interrupted (signal $((RC - 128))) — no verdict." >&2
  exit 2
fi

# The head may have moved while we waited: --watch follows the PR's live head,
# but the suite check below is pinned to the SHA read at start. This repo runs
# concurrent agent sessions, so a mid-wait push is a real scenario. Verifying a
# different commit than the one watched is precisely the "answered a question
# you were not asked" failure this script exists to prevent.
SHA_NOW=$(pr_field headRefOid)
if [ -n "$SHA_NOW" ] && [ "$SHA_NOW" != "$SHA" ]; then
  echo "ci-wait: head moved during the wait (${SHA:0:7} -> ${SHA_NOW:0:7})." >&2
  echo "         The result above is not about the commit this run started on." >&2
  echo "         Re-run to wait on ${SHA_NOW:0:7}." >&2
  exit 2
fi

# Gap 3, second half. Green from `gh pr checks` counts only if GitHub Actions
# actually reported. Vercel alone passing is the exact shape of the 2026-08-18
# silent-no-coverage failure.
#
# stderr is CAPTURED, not discarded, and the exit status is checked. Swallowing
# it made a rate limit or network blip indistinguishable from a genuinely absent
# suite, so the script announced "NO TESTS RAN" on a green PR — the same
# no-answer-read-as-negative-answer bug as the loop it replaces. Retried,
# because the alternative to a transient failure is a false alarm.
SUITES=""; SUITE_RC=1
for attempt in 1 2 3; do
  SUITES=$(gh api "repos/$SLUG/commits/$SHA/check-suites" --jq '.check_suites[].app.slug' 2>&1)
  SUITE_RC=$?
  [ "$SUITE_RC" -eq 0 ] && break
  [ "$attempt" -lt 3 ] && sleep 3
done

if [ "$SUITE_RC" -ne 0 ]; then
  echo "ci-wait: could NOT verify whether GitHub Actions ran on ${SHA:0:7}." >&2
  echo "         The API call failed 3 times — this is not evidence either way." >&2
  echo "$SUITES" | sed 's/^/  /' >&2
  exit 2
fi

if ! echo "$SUITES" | grep -qx "github-actions"; then
  echo "ci-wait: no github-actions check-suite on ${SHA:0:7} — NO TESTS RAN." >&2
  echo "         Absence of a run is not a pass. Suites present: ${SUITES:-none}" >&2
  exit 1
fi

if [ "$RC" -ne 0 ]; then
  echo "ci-wait: PR #$PR is RED." >&2
  exit 1
fi

echo "ci-wait: PR #$PR is green and GitHub Actions reported. Conclusive."
