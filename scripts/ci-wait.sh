#!/usr/bin/env bash
#
# Wait for a PR's CI to reach a conclusive result, then report it.
#
# Replaces the hand-rolled `until [ "$(gh run view ...)" = "completed" ]` loops
# that agents keep writing. Those loops share one bug: they compare a command
# substitution against a literal, so ANY gh failure — an empty run id, a 404, a
# rate limit — yields "" , which never equals "completed", and the loop sleeps
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
#      one ourselves with a background watchdog.
#   3. Absence is not a pass. A PR with merge conflicts gets NO check-suite at
#      all: `gh pr checks` shows only Vercel green, which reads exactly like
#      "checks are fine" (PLAYBOOK Rule 21; incident 2026-08-18, PR #64 sat
#      with zero test coverage while the session reported "waiting on CI").
#      We require a github-actions suite on the head SHA before trusting green.
#
# Usage:  scripts/ci-wait.sh [<pr-number>|<branch>]     # defaults to current branch
# Exit:   0 = conclusive green   1 = red, absent, or timed out
#
# Env:    CI_WAIT_DEADLINE  overall seconds before giving up   (default 900)
#         CI_WAIT_QUEUE_GRACE  seconds to allow for queueing   (default 120)

set -uo pipefail

TARGET="${1:-}"
DEADLINE="${CI_WAIT_DEADLINE:-900}"
QUEUE_GRACE="${CI_WAIT_QUEUE_GRACE:-120}"

command -v gh >/dev/null 2>&1 || { echo "ci-wait: gh not installed" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "ci-wait: gh not authenticated" >&2; exit 1; }

# Resolve the PR up front. Failing here is a real failure — an agent waiting on
# a PR that does not exist should hear about it now, not in fifteen minutes.
PR_JSON=$(gh pr view ${TARGET:+"$TARGET"} --json number,headRefOid,mergeStateStatus 2>&1) || {
  echo "ci-wait: no PR found for '${TARGET:-current branch}'" >&2
  echo "$PR_JSON" | sed 's/^/  /' >&2
  exit 1
}
PR=$(echo "$PR_JSON" | jq -r .number)
SHA=$(echo "$PR_JSON" | jq -r .headRefOid)
MERGE_STATE=$(echo "$PR_JSON" | jq -r .mergeStateStatus)
SLUG=$(gh repo view --json nameWithOwner -q .nameWithOwner)

echo "ci-wait: PR #$PR @ ${SHA:0:7} (deadline ${DEADLINE}s)"

# Gap 3, first half. A conflicting PR will never produce a run, so waiting for
# one is waiting forever. Say so immediately instead.
if [ "$MERGE_STATE" = "DIRTY" ] || [ "$MERGE_STATE" = "CONFLICTING" ]; then
  echo "ci-wait: PR #$PR has merge conflicts ($MERGE_STATE) — GitHub creates NO" >&2
  echo "         workflow run for a PR it cannot merge. Resolve, then re-run." >&2
  exit 1
fi

# Gap 1. Poll until checks register or the grace period runs out.
START=$SECONDS
while true; do
  OUT=$(gh pr checks "$PR" 2>&1); RC=$?   # captured, not printed
  # Exit 8 = pending, 0 = all done. Either means checks exist; stop waiting.
  { [ "$RC" -eq 0 ] || [ "$RC" -eq 8 ]; } && break
  case "$OUT" in
    *"no checks reported"*) : ;;   # queue race — keep waiting
    *) echo "ci-wait: gh pr checks failed:" >&2; echo "$OUT" | sed 's/^/  /' >&2; exit 1 ;;
  esac
  if [ $((SECONDS - START)) -ge "$QUEUE_GRACE" ]; then
    echo "ci-wait: no checks registered after ${QUEUE_GRACE}s — nothing is running" >&2
    exit 1
  fi
  sleep 5
done

# Gap 2. `gh pr checks --watch` blocks with no timeout of its own, so run it in
# the background and shoot it if it outlives the deadline. --fail-fast returns
# as soon as one check goes red rather than waiting out the healthy ones.
# Output goes to a temp file, not the terminal: --watch reprints the entire
# checks table every interval, which floods an agent's log with dozens of
# near-identical blocks. Only the final table is worth showing.
echo "ci-wait: watching (quiet) — final result below"
gh pr checks "$PR" --watch --fail-fast --interval 10 >/dev/null 2>&1 &
WATCHER=$!
# stdout/stderr closed: otherwise the watchdog inherits the caller's pipe and
# holds it open for the full deadline, hanging any `ci-wait.sh | tail`.
( sleep "$DEADLINE"; kill "$WATCHER" 2>/dev/null ) >/dev/null 2>&1 &
WATCHDOG=$!
# disown so bash prints no "Terminated" job-control line when we kill it below.
disown "$WATCHDOG" 2>/dev/null || true

wait "$WATCHER"; RC=$?
kill "$WATCHDOG" 2>/dev/null

# One authoritative re-query, on every path. The watcher's own output is
# discarded above because --watch reprints the whole table each interval; on
# a 4-minute run that is ~24 near-identical blocks in the caller's log. This
# also renders the pending state on the timeout path, which is the diagnostic
# that matters there.
gh pr checks "$PR" 2>/dev/null | sed 's/^/  /'

if [ "$RC" -gt 128 ]; then
  echo "ci-wait: still not conclusive after ${DEADLINE}s — killed the watcher." >&2
  echo "         This is a stuck run, not a slow one. Inspect it:" >&2
  echo "           gh run list --branch \$(git branch --show-current) --limit 3" >&2
  exit 1
fi

# Gap 3, second half. Green from `gh pr checks` counts only if GitHub Actions
# actually reported. Vercel alone passing is the exact shape of the 2026-08-18
# silent-no-coverage failure.
SUITES=$(gh api "repos/$SLUG/commits/$SHA/check-suites" --jq '.check_suites[].app.slug' 2>/dev/null)
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
