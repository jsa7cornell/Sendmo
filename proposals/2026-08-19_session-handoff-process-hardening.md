---
title: Handoff — 2026-08-19 process-hardening session, and the overlaps it leaves behind
slug: session-handoff-process-hardening
project: sendmo
status: handoff
created: 2026-08-19
last_updated: 2026-08-19
author: Claude Opus 5 — session that began as "package the shipping-flow design handoff into a build proposal," discovered it was working from a 44-commit-stale tree, and spent the rest of the session hardening how SendMo ships code. Eight PRs merged (#74, #76, #77, #79, #80, #81, #82, plus review of #75).
---

> **Read this first if you are picking up SendMo work on or after 2026-08-19.** How you ship changed today. There is also one open PR that collides with what shipped, and a shared checkout that will shout at you.

---

## 1. What changed about shipping — read this before you push

**`main` is gated.** Ruleset `21062139`, enforcement active, **zero bypass actors**:

- Pull request required. Direct pushes to `main` are refused.
- `Lint, Unit, and E2E Tests` is a **required status check**.
- Force-push and deletion blocked.

Your workflow is now `gh pr create --fill && gh pr merge --squash --auto`. Auto-merge is the right default — the required check often re-runs on the current head, so a PR that looked green can sit `BLOCKED` for a few minutes before landing.

**Two settings are load-bearing; do not "fix" them.** Zero bypass actors, because every agent authenticates as `jsa7cornell` — a bypass for the account is a bypass for every agent, which restores the honour system for exactly the sessions the gate exists to catch. And `required_approving_review_count: 0`, because John is the only human and GitHub forbids self-approval; setting it to 1 freezes the repo permanently with no route out but deleting the rule.

If it ever genuinely blocks real work: `gh api -X DELETE repos/jsa7cornell/Sendmo/rulesets/21062139`.

**A SessionStart hook now warns when your tree is behind `origin/main`.** Silent when current. It fires at ≥5 commits behind with the specific migrations and proposals you are missing. If you see that banner, stop and rebase before reading anything — the banner exists because a session ignored this exact situation and wrote a proposal re-proposing five merged PRs.

**The CI docs were wrong until today.** PLAYBOOK and TESTING both claimed a red e2e suite does not block. It has blocked since 2026-08-18 and is a required check since 2026-08-19. Current truth:

| Step | Blocking? |
|---|---|
| ESLint | No — `\|\| true`, 27 known errors |
| `tsc -b`, unit | **Yes** |
| Playwright e2e (mocked) | **Yes** |
| Authed e2e (live Supabase) | No — `continue-on-error`, visible warning |

A green run certifies the mocked suite, not the authed step. Check the run's annotations for that one.

---

## 2. The overlaps you need to resolve

### 2.1 PR #78 is now partly redundant, and has never run CI

[#78](https://github.com/jsa7cornell/Sendmo/pull/78) — *"docs: record the CI install finding; make Rule 21's number self-defending"* — is open from `fix/e2e-infra-audit`, the dead branch this session's RCA was about. Three problems, in order of how easily they bite:

1. **It has no CI run at all.** `mergeStateStatus` reads `CONFLICTING`/`DIRTY` (GitHub uses both), and `check-suites` on its head (`693a943`) contains **no `github-actions` entry**. This is finding A6: GitHub builds `pull_request` events against a merge ref, a conflicting PR has no computable merge ref, so no run and no check-suite is created. `gh pr checks` shows only Vercel passing, which reads exactly like "checks are fine." **Absence of a run is not a pass.** The new required check now catches this — the PR cannot merge while the check is absent — but do not read its green Vercel as coverage.
2. **One of its three files is already on `main`.** It adds `proposals/2026-08-18_session-durability-and-auth-architecture_reviewed-2026-08-18_decided-2026-08-18.md`, which [#81](https://github.com/jsa7cornell/Sendmo/pull/81) rescued from that same branch earlier today. Verified **byte-identical** (`df49291c3c45` on both). That part of the diff is a no-op at best and a conflict at worst.
3. **Its other two files are the ones this session rewrote.** `LOG.md` (five new entries today) and `proposals/README.md` (rewritten in #76 and #81). Both are same-position prepends — resolve as a **union**, keep both sets of entries, and drop the duplicate session-durability line rather than the rescued file.

**What #78 uniquely carries and is worth keeping:** its LOG content about the CI install finding, and the Rule 21 "self-defending number" change. Note [#75](https://github.com/jsa7cornell/Sendmo/pull/75) already landed the related fix — job `timeout-minutes: 45`, install step `timeout-minutes: 8`, and it **dropped `--with-deps`** (ubuntu-latest already ships Chromium's shared libraries; a missing one now fails loudly in seconds rather than stalling on apt). Reconcile #78's prose against what #75 actually shipped before merging; some of it may describe a state that no longer exists.

**Recommended:** rebase #78 onto current `main`, drop the proposal file from its diff, union the LOG and README, and re-verify its Rule 21 claims against `.github/workflows/test.yml` at HEAD.

### 2.2 The shared checkout is on a dead branch and will banner every session

`/Users/ja/AI-Brain/sendmo` is on `fix/e2e-infra-audit` at `693a943` — merged as PR #64 on 2026-08-17, now 50+ commits behind. The new hook will print a full stale-tree banner on **every session that starts there, indefinitely**, which is precisely how a warning becomes wallpaper.

```bash
git -C /Users/ja/AI-Brain/sendmo checkout main && git -C /Users/ja/AI-Brain/sendmo pull
```

Two caveats: `sendmo-who-sending-wt` currently holds `main`, and git refuses to check out a branch already claimed by another worktree — release it first or use a detached checkout. And the shared tree has a modified `_archive/backend` submodule plus untracked files that are now duplicates of what is on `main`.

**This is gated on resolving #78 first** — that PR's head *is* this branch, so switching before it merges strands the work.

### 2.3 Other sessions are live in this repo

Five worktrees belong to sessions other than this one. Do not remove them:

`sendmo-who-sending-wt` (holds `main`) · `.claude/worktrees/elastic-robinson-c4f7b2` · `funny-edison-6a9ecf` · `priceless-cray-b8a429` · and a `ci-timeout` worktree under a different session's scratchpad on branch `docs/ci-install-findings` — likely the source of #78.

Before starting any roadmap item, run the concurrency check: `git fetch`, `git log origin/main -10`, `git branch -a`, `git worktree list`, `gh run list`. The 2026-07-06 duplicate-arc incident is what this prevents — two sessions ran the full propose→review→decide→execute arc on the same item the same morning.

---

## 3. What shipped today, and why each one matters later

| PR | What | The durable part |
|---|---|---|
| #74 | SessionStart stale-tree hook; `.claude/settings.json` + `commands/` now tracked | `.claude/` was gitignored wholesale, so the two existing Stop hooks and `/runtest`, `/buildtest`, `/verifyfix` existed only in whichever checkout held them locally |
| #75 | CI job/step timeouts (not this session's — reviewed and merged here) | GitHub's default job timeout is **6 hours**; a hung install burned all of it |
| #76 | Two reviewed proposals + the design handoff | — |
| #77 | Branch protection + the CI wedge | See §4 |
| #79 | Hook re-review fixes | See §4 — the most important gotcha here |
| #80 | Corrected the CI docs | §1 above |
| #81 | Rescued three decided proposals + fixed nine dangling links | See §4 |
| #82 | PR 1 reconnaissance amendment | See §5 |

---

## 4. Gotchas worth not rediscovering

**`git log` and `git status` structurally cannot reveal a stale branch.** `git log` shows the history you are standing on; `git status` compares against the branch's *own* upstream, which was in sync — so git correctly reported everything was fine while the tree was 44 behind. Only `git rev-list --count HEAD..origin/main` shows it, and it needs no network (~25ms). This session wrote an entire proposal on stale reads before a single question from John exposed it.

**`FETCH_HEAD` is per-worktree, not common-dir.** It is absent from git's `common_list[]`, so `git fetch` writes it under `.git/worktrees/<name>/`. Reading `--git-common-dir` in a linked worktree reads a file git never writes there. Use `git rev-parse --git-path FETCH_HEAD`. This shipped broken in #74 and was caught only by re-reviewing the rewrite; with nine worktrees it was the common case, and its worst shape was a warning that **could not be cleared by doing what it told you to do**.

**An all-digit string is not safe for `$(( ))`.** A leading zero is parsed as octal and `8`/`9` are invalid octal digits — the error aborts mid-branch, leaves variables unset, and kills the script under `set -u`. Use `10#$value`.

**A clamp can swallow an error and fail toward reassurance.** A skew clamp rewrote a failed `date +%s` into `0h ago` — "just fetched." Errors should fail loud, not comfortable.

**Renaming a proposal silently breaks every inbound link.** The filename convention appends `_reviewed-` / `_decided-` at each milestone, which is what makes `ls` show status at a glance — and it orphans every citation. Nine dangling links were found across seven files, including `SPEC.md:1052` pointing at a decided proposal that was not on `main`. Renaming is a two-part operation. Sweep with:

```bash
grep -oh '](\(2026-[^)]*\.md\))' proposals/*.md *.md | tr -d '](' | tr -d ')' | sort -u | while read t; do [ -f "proposals/$(basename "$t")" ] || echo "DANGLING: $t"; done
```

**When auditing what is missing from `main`, match by slug, not filename.** A naive diff returns seven "missing" proposals, four of which are correctly absent — pre-decision filenames superseded by the `_decided-` version `main` already has. Rescuing all seven restores four duplicates under stale names.

**`cancel-in-progress: false` on `main` turns one hung run into an indefinite queue.** Deliberate — main's runs should not cancel each other — but a hang blocks every later main run. #75 bounds this at 45 minutes; before it, the ceiling was six hours. If main's runs go `pending`, look for a hung one and `gh run cancel` it.

**Grepping `test.yml` for `|| true` finds its own documentation.** The authed step's comment contains the sentence "`|| true` is gone." Check the `run:` line, not the block.

**A green "Provide Tests" step does not mean the suite passed.** Download the report and read its stats — the numbers live in a `<script id="playwrightReportBase64">` tag inside `index.html`, base64 of a zip containing `report.json`.

---

## 5. Where the flow redesign stands, and how to start it

The design handoff is implemented as a decided proposal: [`2026-08-19_shipping-flow-redesign_reviewed-2026-08-19.md`](2026-08-19_shipping-flow-redesign_reviewed-2026-08-19.md) — reviewed (approve-with-changes, 4 blockers accepted), John's T1 decision recorded, and **amended with pre-implementation reconnaissance**. Read the amendment before writing code.

**The scope correction that matters:** the flow's *mechanics* are already done. PRs #67/#68/#70/#71/#72 plus migrations 041/042 shipped all three skippable questions. What is left is the UX refresh the design brief commissioned, of which **zero of its four founder asks are built**.

**The amendment's headline:** PR 1 reverses a decision recorded in the code — `RecipientStepFullShipping.tsx:55` says *"one component rather than an extraction: the rate fetch needs both halves' values and lives here either way."* It still supersedes, because under six steps the fetch moves to its own step downstream of both halves. **But it changes real behavior on the money path: live-updating prices while editing dimensions go away.** That is what the design intends; it is not a pure refactor.

**Start here, in this order:**

1. The redirect table, the six-slug map, its **90 rewritten unit assertions**, and the **24 hardcoded e2e URL literals** — all in **one commit**. The e2e suite is a required check, so there is no window where a half-migrated map merges.
2. Only then split `RecipientStepFullShipping` (672 lines → 3), against a map that is already green. Three latched behaviors must survive verbatim: `originWasCompleteOnOpen` (deriving it live destroyed focus mid-keystroke), the `fetchRef` stale-response guard, and `canFetchRates` gating.

---

## 6. Open items

| Item | State | Recommendation |
|---|---|---|
| PR #78 | Open, conflicting, no CI | Rebase, drop the duplicate proposal, union LOG/README (§2.1) |
| Shared checkout on dead branch | Live | Switch to `main` after #78 resolves (§2.2) |
| `scripts/new-session.sh` (RCA F3) | Not built | **Skip.** The SessionStart hook covers its failure mode automatically; F3 depends on remembering a command, and this class of failure has now recurred three times *despite* written guidance |
| Flow redesign PR 1 | Ready | §5 |
| Duplicate-migration-prefix CI check | Not built | Three lines, closes a class no staleness check can — two *current* worktrees minting `043_*.sql` the same afternoon and merging textually clean. Migration 036 was claimed twice on 2026-07-06 |

`SPEC.md` needs no update from today — nothing shipped changed product behavior, contracts, or architecture. The one real behavior change identified (live rates) is planned, not shipped.
