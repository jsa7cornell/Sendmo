---
title: Shipping process RCA — the 44-commit stale tree, and what should gate a session
slug: shipping-process-and-stale-branch-rca
project: sendmo
status: reviewed
created: 2026-08-19
last_updated: 2026-08-19 13:53
reviewed: 2026-08-19
decided: null
author: RCA session — investigated the 2026-08-19 stale-tree incident, audited SendMo's CI/hooks/branch state, and mined Inlet for comparison
reviewer: fresh-eyes review session — re-ran the incident reconstruction, executed the prototype hook against the incident state, and re-verified the GitHub/Inlet audits from a clean origin/main worktree
outcome: approve-with-changes
---

## 1. Context

### The honest win first: CI is not the problem

John's framing was *"clearly our CI is not working well."* I checked, and I disagree — respectfully and with evidence.

CI **was** badly broken, and it got fixed on 2026-08-18. That de-rot was real work and it landed:

- The mocked e2e suite reported `success` while 43 of 80 tests passed and **28 failed** (run `32100723813`). Root cause: every spec mocked `https://fkxykvzsqdjzhurntgah.supabase.co` while `test.yml` built the app against `http://localhost:54321`. The routes never matched.
- The suppression had two layers, and the load-bearing one was `|| true`, not `continue-on-error`. `|| true` made the shell exit 0, so `continue-on-error` never engaged and GitHub recorded a clean green instead of a yellow warning.
- Both were fixed. Measured before/after: `80 total / 43 passed / 28 failed`, `ok: false`, 14m40s → `81 / 75 / 0`, `ok: true`, **3m31s**.
- The Vercel Build Command override — `mkdir -p dist && cp index.html dist/`, a no-op that built nothing — was cleared the same day.

I verified the current state on `origin/main` myself. `.github/workflows/test.yml:54` is `run: npm run test:e2e` — bare, no `|| true`, no `continue-on-error`. It is genuinely blocking. `tsc -b` and unit tests are blocking. There is a concurrency group. The one remaining non-blocking step (authed e2e against live Supabase) is non-blocking for a stated reason — it would couple every merge to a third party's uptime — and its `|| true` was deliberately removed so a failure shows as a visible warning rather than a false green.

**That pipeline is fine.** It would not have caught what happened on 2026-08-19, because what happened on 2026-08-19 never reached CI.

### What actually happened

A session was asked to turn a design handoff into a build proposal. It read `PLAYBOOK.md`, `SPEC.md`, `LOG.md`, the proposals folder, and about fifteen source files. It wrote a detailed proposal citing file paths and line numbers.

Every read was against the working tree on branch `fix/e2e-infra-audit`, which was **44 commits behind `origin/main`**.

The timeline, reconstructed from reflog:

```
2026-08-17 21:36   branch fix/e2e-infra-audit cut from main
2026-08-17 23:16   PR #64 merges it into main (commit 72477d6)
                   ...but the working tree is left checked out on the branch
2026-08-18 07:43   4 more commits stacked onto the now-dead branch
        → 11:45   (a propose → review → respond → decide arc, docs only)
2026-08-18 21:44   local origin/main ref last advanced, to c0c5177
2026-08-19 08:43   a fetch ran; origin/main did not move (already current)
2026-08-19  ~09    the incident session starts reading the tree
```

The branch was merged and then kept being worked on. That is the mechanical cause. But it is not the interesting part.

### The interesting part: the truth was already local

The session's own instructions carry a rule — memory `feedback_verify-before-asserting` — to verify git facts with a command before stating them. It followed that rule. It ran `git log --oneline`.

That command returned this:

```
693a943 docs: session-durability decided — Phase 0+1 go, Phase 2 waits for evidence
eaed68d docs: author response to the session-durability review — ...
4378031 docs: review the session-durability proposal — approve-with-changes, 4 blockers
```

Recent. Plausible. Dated yesterday. Nothing looks wrong. **The command was honest and the answer was useless**, because `git log` shows you the history you are standing on, and says nothing about the history you are standing next to.

`git status` was no better. It printed:

```
## fix/e2e-infra-audit...origin/fix/e2e-infra-audit
```

No ahead/behind counts — because the branch tracks its own remote ref, which was in sync. Git reported "everything is fine," and by git's own definition it was.

Here is the finding that should shape every fix below. A different command, run in the same directory at the same moment, would have returned this:

```
$ git rev-list --count HEAD..origin/main
44
```

**That command makes no network call.** It reads `refs/remotes/origin/main`, which was already sitting on disk pointing at `c0c5177` — the true tip — since 21:44 the night before. It takes **22 milliseconds**.

So this was not a missing-fetch failure. The fetch had happened. The data was local, current, and free. Nobody asked for it, because no rule, hook, script, or CI job in SendMo asks for it.

For completeness: a fully up-to-date checkout of `main` was also sitting on the same disk the whole time, at `/Users/ja/AI-Brain/sendmo-who-sending-wt` (on `main` at `c0c5177`, clean). The truth was available twice over.

### The damage

**Nine merged PRs were invisible:** #62, #64 (the branch's own merge), #67, #68, #69, #70, #71, #72, #73.

**Two migrations were invisible**, and they are the punchline. The proposal's central findings were two database CHECK-constraint blockers. From the stale tree, whose newest migration is `040_seller_link_schema.sql`, those blockers are **real**. Migrations 041 and 042 exist only on `main`, and their own headers say what they do:

- `041_flexible_link_may_carry_origin.sql` — *"under 040 that INSERT throws `sendmo_links_addr_by_type_check`. The address was therefore being discarded."*
- `042_flexible_link_may_defer_destination.sql` — *"Unified-onboarding Phase 3 (proposal 2026-08-18, decision B: John chose 'any combination' of skips)."*

The session correctly diagnosed a bug that had been fixed two days earlier. Its analysis was sound for the tree it read.

**Four proposals were invisible**, including both ends of its own assignment:

| Missing from the working tree | Why it mattered |
|---|---|
| `2026-08-19_onboarding-ux-refresh-design-brief.md` | The brief that commissioned the work. It was committed to `main` at `c0c5177`; the session received the handoff out-of-band via an untracked `Handoffs/` folder. |
| `2026-08-18_unified-onboarding-every-question-skippable.md` | Holds decision B, which John made on 2026-08-18. The session filed it as an open question. |
| `2026-08-18_link-first-shipment-step.md` | Prior art on the same flow. |
| `2026-08-18_pr68-code-review-handoff.md` | Review findings on code the session was analysing. |

**Source divergence:** 70 files differ between the tree and `main`; 29 of them under `src/`, totalling 1,737 insertions and 507 deletions. `src/hooks/useRecipientFlow.ts` alone lost 186 lines to a refactor the session could not see.

### The near-miss, and why it is worse than the miss

The session wrote a document. Documents are cheap to throw away. Two things would not have been.

**Migration numbering.** An agent writing a migration from this tree reads `040` as the highest and names its file `041_*.sql`. That number is already taken on `main`. This is not hypothetical — memory `project_concurrent-sessions-worktree` records that *"migration number 036 was also claimed twice that day by different sessions"* on 2026-07-06. Migrations end up applied to the production database.

**LOG history.** `git diff --numstat origin/main HEAD -- LOG.md` returns `20 191`. A merge or push from this tree **removes 191 lines of LOG that `main` has**. The session-durability entry on `main` (from PR #69) and the one on the branch are different entries for the same work.

### This already happened, twice, and the guidance already existed

This is a recurrence, not a first occurrence. That reframing matters, because it means "write down the lesson" has already been tried and has already failed.

- **2026-07-06 — the duplicate-arc incident.** Two sessions were dispatched onto PRE-LAUNCH item T2-1 the same morning and independently ran the full propose → review → decide → execute arc, converging on the same bug and the same fix. Caught mid-execution by an unexpected `cron.job` row count, just before conflicting production writes. `LOG.md:830`: *"The duplicated cycle is a dispatch-coordination lesson: check prod state + in-flight branches before starting a PRE-LAUNCH item."*
- **T3-3 (`LOG.md:585`).** *"T3-3 was ~90% already shipped… The PRE-LAUNCH 'currently placeholders' text was stale."* The checklist was the stale artifact that caused the rework.
- **`LOG.md:113`.** Near-complete work found sitting uncommitted in the main checkout, discovered by accident.

The 2026-07-06 lesson was written into memory `project_concurrent-sessions-worktree` in exactly the right words: work in a worktree off `origin/main`; before starting an item run `git fetch` + `git log origin/main -10` + `git branch -a` + `gh run list`. The 2026-08-19 session had that memory loaded. It still failed.

**A rule an agent has to remember is not a mechanism.** Three incidents, one memory file, zero machines checking.

### Ongoing harm: decided proposals stranded on dead branches

The protocol says decided proposals are load-bearing institutional memory. Two of them are not on `main`:

| Proposal | Stranded on | Behind main |
|---|---|---|
| `2026-08-18_session-durability-and-auth-architecture_reviewed-2026-08-18_decided-2026-08-18.md` | `fix/e2e-infra-audit` | 44 |
| `2026-07-15_h2-carrier-adjustment-repair_reviewed-2026-07-15_decided-2026-07-15.md` | `claude/gallant-allen-5edd5d` | 111 |

I checked `origin/main` for both under every name. Neither is there. The session-durability *implementation* shipped via PR #69 and is live; the decision record that authorises it exists only on a branch that nothing will ever merge. A future session asking "why does auth work this way" will not find the answer.

### What the audit found beyond the incident

Three more things that are cheap to fix and are quietly load-bearing.

**Git hooks are dead in this repo.** `git config --local core.hookspath` is `/Users/ja/AI Brain/sendmo/.git/hooks` — the pre-rename path, with a space. That directory does not exist (`ls: /Users/ja/AI Brain: No such file or directory`). Any `pre-push` or `post-checkout` hook installed today would silently never run. This matters most as a trap: it is the same failure shape as the Vercel no-op build command, and it would silently defeat any git-hook-based fix proposed in response to this incident.

**Two docs that agents are told to read are wrong about CI, on `main`, in the same direction.**

- `PLAYBOOK.md:356` still says: *"A green 'Provide Tests' run does not mean the e2e suite passed. The ESLint and both Playwright steps run `|| true` and `continue-on-error: true`."* False since 2026-08-18.
- `TESTING.md:50` still says: *"The e2e steps are currently non-blocking (`continue-on-error`)."* False since 2026-08-18.

Both are stale on `main`, and both train an agent to discount a red suite that now means something real. The CI fix is only half-landed while its documentation says the opposite.

**There is no branch protection, and it would be free.** `gh api repos/jsa7cornell/Sendmo/branches/main/protection` returns `404 Branch not protected`. `gh api .../rulesets` returns `[]`. The repo is **public** (`"isPrivate": false`), so branch protection and rulesets cost nothing on GitHub Free.

Today "the e2e suite is blocking" means *the run turns red*. It does not mean the merge is prevented. Nothing stops a red PR being merged or a commit being pushed straight to `main`. Every gate in SendMo is honour-system.

This also leaves finding **A6** unfixed. From `proposals/2026-08-17_platform-infra-audit-handoff.md:387`: a PR with merge conflicts has no computable merge ref, so GitHub creates **no workflow run and no check-suite at all**. *"Not a failure — an absence."* Three commits on PR #64 sat with zero test coverage while the session reported waiting on CI. There is currently no mechanism that can tell absence from earliness — and required status checks are exactly that mechanism, because a check that never ran is not a check that passed.

### The verdict, plainly

CI is a solved problem that is documented as broken. The stale-tree failure is **session hygiene**, and it lives entirely upstream of CI.

Every mechanical gate SendMo has fires at `Stop` — after the work is finished and the cost is sunk. Both hooks in `.claude/settings.json` are `Stop` hooks, both `exit 0`, and `check-deploy-green.sh` short-circuits on line 29 with `[ "$BRANCH" = "main" ] || exit 0`, so on this branch **it has never once run**. There is no `SessionStart` hook, no `PreToolUse` hook, and no rule anywhere in `PLAYBOOK.md` about fetching, staleness, merge status, or checking whether work already exists. I grepped both the working copy and `origin/main` for all of it.

---

## 2. Architecture

### Where the gates are, and where they need to be

```
  SESSION LIFECYCLE                         WHAT GUARDS IT TODAY
  ─────────────────────────────────────────────────────────────────────
  session starts on whatever                ✗  nothing
  branch was left checked out

  agent reads PLAYBOOK / SPEC / LOG /       ✗  nothing
  proposals / source                            (this is where 2026-08-19 died)

  agent writes a proposal or code           ✗  nothing

  agent commits                             ✗  nothing (git hooks are dead)

  agent pushes / opens a PR                 ~  CI runs — good, but only sees
                                               the diff, never the baseline

  PR merges                                 ✗  nothing — no branch protection

  session ends                              ~  2 Stop hooks, advisory, exit 0
                                               (one is a no-op off `main`)
  ─────────────────────────────────────────────────────────────────────
```

The gap is not subtle. Everything mechanical happens at the bottom of that column. The failure happened at the top.

### What Inlet does, specifically

John said Inlet *"works reasonably well."* I read its process docs, hooks, workflows, scripts, and LOG. The comparison is not what I expected, and the surprise is the useful part.

**Inlet's CI is not better than SendMo's. It is arguably worse.** No branch protection (explicitly declined — `PLAYBOOK.md` Rule 13 records *"John declined GitHub Pro 2026-07-10 — no hard branch protection; the convention IS the gate"*). No merge queue. No required checks. No concurrency group on `ci.yml`. And its suite is documented-flaky: `LOG.md:2827`, *"THE TEST SUITE IS FLAKY, AND IT REACHES CI"* — a clean local run fails three tests, a different three each time. Explicitly not fixed.

**Inlet's branch hygiene is worse too.** 338 local branches to SendMo's 83; 162 of them more than 500 commits behind `main`. Pruning branches is not what makes Inlet work, and I want to be clear about that because it is the obvious fix and it is the wrong one.

What Inlet actually has is **three mechanisms**, and only three.

**1. A SessionStart hook.** `/Users/ja/AI-Brain/inlet/.claude/settings.json` registers one hook, on `SessionStart`, with no matcher. It runs `scripts/session-start-check.sh`, whose entire logic is:

```bash
case "$PWD" in
  */.claude/worktrees/*) exit 0 ;;
esac
cat <<'MSG'
⚠ You are in the SHARED checkout (~/AI-Brain/inlet), which is a read-only
hub kept on clean main — no session edits files here (PLAYBOOK Rule 14).
Before editing anything, run:

    scripts/new-session.sh <slug>
...
MSG
exit 0
```

It cannot block. It prints, and it prints **only when the state is wrong** — silence means you are fine. Because both the settings file and the script are tracked in git, every worktree carries the hook and correctly stays quiet inside one. It self-propagates.

**2. `scripts/new-session.sh` — the mechanism that does the real work.** Two lines:

```bash
git -C "$repo" fetch origin --quiet
git -C "$repo" worktree add "$wt" -b "wip/$slug" origin/main
```

The fetch and the branch point are **in the same command**. There is no code path where an Inlet session branches off anything but a just-fetched `origin/main`, because doing it correctly is one word and doing it wrong requires deliberate effort. This is why Inlet's 338 dead branches are harmless: nothing ever resumes one.

**3. `scripts/deploy.sh` — one hard ancestry gate, at the moment staleness costs money.**

```bash
if ! git merge-base --is-ancestor origin/main HEAD; then
  echo "✗ HEAD does not contain origin/main — another session has shipped." >&2
  exit 1
fi
git push origin HEAD:main
```

`exit 1`. It refuses. And the push comes *before* the deploy deliberately — the header records that *"a rejected push is still the collision alarm, and it must fire before anything ships (the 2026-07-09 chunk-T/build-1 overwrite happened when the push came second)."*

SendMo has none of these. `scripts/` contains `predeploy.sh` and `smoke.sh` and eight one-off backfills. `grep -rln 'merge-base\|is-ancestor'` across `scripts/` and `.claude/` returns nothing.

**Where SendMo is genuinely ahead of Inlet.** This is not a one-way comparison:

- SendMo's CI is stricter and faster: e2e blocking, a concurrency group, 3m31s. Inlet has none of that and knows its suite is flaky.
- SendMo has `Stop` hooks encoding Rules 19 and 21. Inlet has no Stop hook at all — its wrap-up ritual is entirely unenforced prose.
- SendMo has `TESTING.md` mapping four test layers, and `.claude/commands/` (`/verifyfix`, `/runtest`, `/buildtest`). Inlet has neither.
- SendMo's Rule 19 browser-verification block, with its closed `n/a-category` enum, is a stronger artifact than anything in Inlet.
- SendMo's repo is public, so the platform gates Inlet declined on cost are free here.

The pattern is clean: **SendMo built exit gates and Inlet built entry gates.** SendMo's are better built. Inlet's are better placed. This proposal is about adding the entry gates, not replacing what exists.

### The design principle

Rank fixes by whether they survive an agent forgetting. The failing session had the rule and failed anyway, so any fix whose mechanism is "the agent remembers" is already known not to work here.

That gives three tiers:

1. **Runs automatically, cannot be skipped** — hooks, CI jobs, platform settings. Prefer these.
2. **Makes the right thing the path of least resistance** — one command that does the correct thing, so doing it wrong takes more effort. This is `new-session.sh`.
3. **Written guidance** — necessary to explain the other two, insufficient alone. Already tried, three times.

---

## 3. File-by-file plan

Nine changes, ranked by leverage per unit of friction. **F1 and F2 are the two I would do if only two could land** — both are one-time work with near-zero recurring cost, and between them they cover the miss and the near-miss.

### F1 — SessionStart stale-tree hook  ★ cheap, automatic, do this first

**What it is.** A new script `scripts/claude-hooks/session-start-check.sh`, registered as a `SessionStart` hook in `.claude/settings.json` alongside the two existing `Stop` hooks.

It compares `HEAD` to the local `refs/remotes/origin/main` and prints nothing when they match. When they do not, it names the gap and the specific artifacts the session is about to read wrong.

**What failure it prevents.** Exactly this incident, and both prior ones. It answers "is what I am about to read current?" before the first read.

**Prototype and proof.** I wrote it in the scratchpad and ran it against the incident state. Output, verbatim:

```
⚠ STALE TREE — you are on 'fix/e2e-infra-audit', 44 commits behind origin/main.
  Last fetch: 3h ago.
  Everything you read — source, migrations, proposals, LOG — is 44 commits out of date.
  Missing migrations:
    supabase/migrations/041_flexible_link_may_carry_origin.sql
    supabase/migrations/042_flexible_link_may_defer_destination.sql
  Missing proposals:
    proposals/2026-08-18_link-first-shipment-step.md
    proposals/2026-08-18_pr68-code-review-handoff.md
    proposals/2026-08-18_unified-onboarding-every-question-skippable.md
    proposals/2026-08-19_onboarding-ux-refresh-design-brief.md
  Fix: git fetch origin && git worktree add .claude/worktrees/<slug> -b claude/<slug> origin/main
```

That is the incident's entire damage report, printed before any work started.

**Cost.** Measured at **81ms** wall-clock. Zero network calls — it reads local refs only, so it never blocks on a slow or absent connection. Zero tokens in the common case, because a current tree prints nothing. Roughly 120 tokens when it fires, which is precisely when you want them spent.

**Design notes.**
- Follow Inlet's shape: `exit 0` always, advisory. A `SessionStart` hook that can hang or block is worse than the failure it prevents.
- Silence means correct. Do not print an "all clear" — noise on every session is how a warning gets ignored.
- Do **not** fetch. A network call at session start is a latency and failure surface, and this incident proves it is unnecessary. Report `.git/FETCH_HEAD` age instead and let the agent decide.
- Do not try to detect "this branch was already merged" via `gh`. Squash merges make the ancestry test unreliable and `gh pr list` costs a network round-trip. The behind-count is sufficient signal.

### F2 — Branch protection ruleset on `main`  ★ cheap, automatic, free

**What it is.** A GitHub ruleset on `main`. John's action, in Settings → Rules, about five minutes, one time. Recommended:

- **Require a pull request before merging** — closes direct pushes to `main`.
- **Require status checks to pass** → require `Lint, Unit, and E2E Tests`.
- **Block force pushes.**

**What failure it prevents.** Three things.

1. A red PR being merged. Today "blocking" only means the run turns red; nothing refuses the merge.
2. **A6 — the conflicting PR that gets no CI run, silently.** This is the important one. Required status checks treat a check that never ran as *not passed*. That converts A6 from an invisible absence into a hard block, and it is the only mechanism proposed here that does so. The LOG says no mechanical detection exists for A6; this is it.
3. Accidental direct pushes to `main` from a stale tree — the scenario that would have deleted 191 lines of LOG.

**Cost.** Free (public repo). One-time setup. Per-PR cost is zero when green. The real friction is that docs-only commits currently going straight to `main` would need a PR — see Open Questions.

**What I deliberately am not proposing.** GitHub's *"require branches to be up to date before merging"* sub-option. It sounds like the exact fix, and it is the wrong trade here. SendMo merged six PRs in three hours on 2026-08-18; strict mode would force every open PR to re-merge `main` and re-run CI each time another lands, serialising the merge queue by hand. F4 gets most of the benefit without that.

### F3 — `scripts/new-session.sh`

**What it is.** A port of Inlet's `scripts/new-session.sh`, adapted to SendMo (`npm install` rather than `pnpm`, no native tree). The load-bearing property is that the fetch and the branch point live in one command:

```bash
git -C "$repo" fetch origin --quiet
git -C "$repo" worktree add "$wt" -b "claude/$slug" origin/main
```

**What failure it prevents.** Staleness arising at all, rather than being detected after the fact. This is the highest-leverage fix in the list and the reason Inlet's 338 dead branches are harmless.

**Cost.** Highest of the three top fixes, because it is the one that changes what happens every session rather than being set once. One `npm install` per worktree (real wall-clock). Disk. And it needs F1's hook message pointing at it, or nobody runs it.

**Why it is third and not first.** F1 and F2 are set-and-forget. F3 asks for a habit. Given that three written lessons have already failed to produce a habit, I would rather land the two automatic gates first and let F1's output do the teaching — its "Fix:" line is the nudge toward F3.

### F4 — staleness step in `.github/workflows/test.yml`

**What it is.** A step early in the `test` job, before the slow ones:

```yaml
- name: Check baseline freshness
  if: github.event_name == 'pull_request'
  run: |
    git fetch --no-tags --depth=200 origin main
    BASE=$(git merge-base HEAD origin/main)
    BEHIND=$(git rev-list --count "$BASE"..origin/main)
    echo "Branch cut $BEHIND commits behind current main." >> $GITHUB_STEP_SUMMARY
    if [ "$BEHIND" -gt 40 ]; then
      echo "::error::Baseline is $BEHIND commits behind main — rebase or merge main before merging."
      exit 1
    elif [ "$BEHIND" -gt 10 ]; then
      echo "::warning::Baseline is $BEHIND commits behind main."
    fi
```

**What failure it prevents.** The near-miss: code (or a migration) written against a stale baseline reaching `main`. It catches the semantic staleness that `actions/checkout`'s merge ref does not — a textually clean merge on top of a two-day-old baseline.

**Cost.** Two to three seconds per CI run. The threshold needs tuning; 40 is a starting point chosen because the incident was 44. Note this step needs a real fetch, but it runs on GitHub's runner where that is free.

**Caveat, stated honestly.** This only fires on PRs. It would not have caught the 2026-08-19 incident, which produced a document and never opened a PR. It exists to close the near-miss, not the miss.

### F5 — repair `core.hookspath`

**What it is.** One command:

```bash
git config --local --unset core.hookspath
```

**What failure it prevents.** Any future git hook silently not running. Right now the setting points at `/Users/ja/AI Brain/sendmo/.git/hooks` — the pre-rename path — which does not exist.

**Cost.** Seconds. Include it because it is a live trap: the natural response to this incident is "add a `post-checkout` hook," and that hook would have silently done nothing, wasting a whole cycle. Worth checking on John's other repos too, since the `AI Brain` → `AI-Brain` rename was machine-wide.

### F6 — fix the two stale CI claims in the docs

**What it is.** Two edits on `main`:

- `PLAYBOOK.md:356` — delete or rewrite *"A green 'Provide Tests' run does not mean the e2e suite passed…"*. The mocked suite is blocking; the authed step is non-blocking-by-design and no longer emits a false green.
- `TESTING.md:50` — replace *"The e2e steps are currently non-blocking (`continue-on-error`)"* with the current state.

**What failure it prevents.** An agent reading `PLAYBOOK.md` today is explicitly told that a red e2e suite means nothing. That is now false and it rationalises ignoring a real signal. Docs that lie in the permissive direction are worse than no docs.

**Cost.** Five minutes. This is the second half of the 2026-08-18 CI fix, which was never landed.

### F7 — rescue the two stranded decided proposals

**What it is.** One docs-only PR that brings onto `main`:

- `proposals/2026-08-18_session-durability-and-auth-architecture_reviewed-2026-08-18_decided-2026-08-18.md` (from `fix/e2e-infra-audit`)
- `proposals/2026-07-15_h2-carrier-adjustment-repair_reviewed-2026-07-15_decided-2026-07-15.md` (from `claude/gallant-allen-5edd5d`)

Plus their `proposals/README.md` entries, and a reconciliation of the branch's LOG entry against the one already on `main` from PR #69.

**Do this by cherry-picking the proposal files onto a fresh branch off `origin/main`.** Do not merge `fix/e2e-infra-audit` — its LOG is 191 lines behind and a merge risks exactly the clobber described above.

**What failure it prevents.** Permanent loss of two decision records the protocol calls load-bearing.

**Cost.** One small PR. Some care on the LOG reconciliation.

### F8 — pin the Playwright dev-server port

**What it is.** `playwright.config.ts:37` has `reuseExistingServer: !process.env.CI`. `LOG.md:109` documents the consequence: 17 of 28 specs "failed" against correct code because a stale `vite` from the main checkout held :5173 while the specs under test lived in a worktree. *"Playwright happily tested the other application… every result from that run is meaningless, passes included."*

Options: set `reuseExistingServer: false` locally, or derive a per-worktree port with `--strictPort`. `.claude/launch.json` already pins `5205` / `5199` for two worktrees, so the pattern exists — it is just not enforced.

**What failure it prevents.** Local test results that are silently about a different checkout. Directly aggravated by F3, which makes multiple checkouts the norm.

**Cost.** Small, but it needs a decision on which approach, so it is below the line rather than bundled with F1.

### F9 — branch pruning (recommended AGAINST as a fix)

SendMo has 83 local branches, many hundreds of commits behind. It is tempting to call that the problem.

Inlet has 338 local branches, 162 of them more than 500 commits behind, and does not have this failure mode. Pruning treats a symptom. If F1 and F3 land, dead branches become inert — nothing resumes them and nothing reads them. A `gc-worktrees.sh` port is reasonable housekeeping later; it is not a fix for this.

---

## 4. Test plan

Each fix needs a test that fails before it and passes after — the incident state is a ready-made fixture.

**F1 — SessionStart hook.** Three cases, all runnable today:

| Case | How | Expect |
|---|---|---|
| Stale tree | `CLAUDE_PROJECT_DIR=/Users/ja/AI-Brain/sendmo` (currently on `fix/e2e-infra-audit`, 44 behind) | The full warning, naming migrations 041/042 and the four proposals |
| Current tree | `CLAUDE_PROJECT_DIR=/Users/ja/AI-Brain/sendmo-who-sending-wt` (on `main` at `c0c5177`) | Empty output, exit 0 |
| No `origin/main` ref | A fresh clone before first fetch | Empty output, exit 0 — never error out of a session start |

Plus: hook fires at all (start a session in the stale checkout and confirm the warning appears in context, not just in a manual run); and a timing assertion that it stays under ~200ms.

**F2 — branch protection.** Open a throwaway PR that fails `tsc`. Confirm the merge button is disabled. Then confirm the A6 case: push a PR with a deliberate conflict against `main`, confirm no check-suite is created, and confirm the merge is **blocked** rather than showing as fine. That second test is the one that matters — it is the finding A6 says has no mechanical detection.

**F3 — `new-session.sh`.** Run it, then in the new worktree assert `git merge-base --is-ancestor origin/main HEAD` succeeds and `npm run test:unit` passes from a cold start. Then run F1's hook inside the worktree and confirm silence.

**F4 — CI staleness step.** Open a PR from `docs-linkfirst` (currently 32 behind) and confirm a warning. Open one from a branch >40 behind and confirm the job fails. Open one cut from current `main` and confirm no annotation.

**F5 — `core.hookspath`.** After unsetting: install a trivial `.git/hooks/post-checkout` that writes a file, check out a branch, confirm the file appears. Before the fix it does not.

**F6 — docs.** Grep `origin/main` for `continue-on-error` in `PLAYBOOK.md` and `TESTING.md`; expect no claim that the mocked e2e suite is suppressed.

**F7 — stranded proposals.** After the PR: `git ls-tree -r --name-only origin/main -- proposals/ | grep -E 'durability|carrier-adjustment-repair'` returns both files.

**F8 — port pinning.** With a `vite` deliberately running in another checkout on :5173, run the e2e suite in a worktree and confirm it either uses its own port or refuses, rather than testing the other application.

---

## 5. Out of scope

- **Rewriting CI.** It works. The remaining CI items here are F4 (one step) and F6 (docs catching up). No changes to the test suite, the workflow structure, or the deploy workflow.
- **The `deploy-edge-functions.yml` gaps.** The audit found two real ones — `fetch-depth: 2` with `HEAD^` under-computes the deploy set on multi-commit merges, and the `Summary` step prints `✅ Deployed` under `if: always()` regardless of failure. Both are genuine and neither relates to this incident. They belong in their own proposal.
- **PRE-LAUNCH item claiming.** Items are markdown checkboxes with no lock and no assignee, which is what let two sessions claim T2-1. Real, and a different problem — an atomic-claim mechanism is its own design question.
- **Branch and worktree pruning.** See F9.
- **The shipping-flow redesign.** `proposals/2026-08-19_shipping-flow-redesign.md` is separate and being handled by another session. This proposal touches only process.
- **Fixing SendMo's ESLint debt.** The lint step is double-suppressed with 30+ known errors. Acknowledged, unrelated.
- **Anything in Inlet.** Its dirty hub and flaky suite are its own business. Noted for John, not proposed on.

---

## 6. Verification

After F1, F2, F5, and F6 land, run this end to end. It takes about ten minutes.

**Step 1 — reproduce the incident on the fixed system.** Leave `/Users/ja/AI-Brain/sendmo` on `fix/e2e-infra-audit`, 44 behind. Start a fresh Claude session in it. The `SessionStart` hook must print the stale-tree warning naming migrations 041/042 before the agent's first read. *This is the whole proposal in one check: the exact conditions of 2026-08-19, now loud.*

**Step 2 — confirm silence in the good case.** Start a session in `/Users/ja/AI-Brain/sendmo-who-sending-wt` (on current `main`). Expect no hook output at all. If it prints here, the signal is noise and will be ignored within a week.

**Step 3 — confirm the platform refuses.** Open a PR whose `tsc -b` fails. GitHub must show the merge as blocked, not merely red.

**Step 4 — confirm A6 is closed.** Open a PR with a real merge conflict against `main`. Confirm no check-suite is created **and** the merge is blocked. Before this change, `gh pr checks` showed only Vercel passing, which reads as fine.

**Step 5 — confirm git hooks are alive.** Install a throwaway `post-checkout` hook, switch branches, confirm it ran, remove it.

**Step 6 — confirm the docs match reality.** Read `PLAYBOOK.md` Rule 21 and `TESTING.md` on `main` cold. Neither should tell you the e2e suite is suppressed.

**Step 7 — the real test, one week out.** Check whether any session in the following week worked from a tree more than ten commits behind `main`. Run over the reflog:

```bash
git reflog --date=iso | grep checkout
```

If F1 is working, this number goes to zero without anyone being asked to change how they work. If it does not, F1 is being read and ignored, and F3 becomes mandatory rather than optional.

---

## 7. Open questions

**Q1 — Does requiring a PR on `main` break the docs-only workflow?** F2's "require a pull request" is the piece with real friction. SendMo currently pushes LOG and proposal updates straight to `main`, and that is often correct — Inlet formalised the same carve-out in its Rule 13. GitHub rulesets support a bypass list, so John's own account could push docs directly while agents cannot. Which do you want: everything through PRs (simplest, most friction), or a bypass for John (matches how Inlet works, but the honour-system hole reopens for anything run as John)?

**Q2 — What should the CI staleness threshold be, and should it fail or warn?** I proposed warn at 10, fail at 40. 44 was this incident. But SendMo merged twelve PRs in 72 hours, so a long-lived branch can pass 40 legitimately without being wrong. Would you rather it only ever warn, and let the F1 hook carry the blocking role? I lean warn-only for the first two weeks, then look at the data.

**Q3 — Is `new-session.sh` (F3) worth the per-session `npm install`?** Inlet pays this cost every session and considers it the single most important thing it does. SendMo's install is not fast. The alternative is F1's hook telling the agent to fix its own tree, which is cheaper but relies on the agent acting on the message. My read is that F1 alone will catch most of this and F3 is what makes it structurally impossible — but I would rather land F1, measure with Verification step 7, and let the data decide than pay the cost on a guess.

**Q4 — Should the hook warn on more than `main`-distance?** It could also flag: uncommitted changes in a shared checkout, another live worktree on the same branch, or a `.git/FETCH_HEAD` older than 24h. Each is a real signal and each is a chance to make the message long enough to skim past. I kept the prototype to one thing on purpose. Is there a second signal you want in it, or should it stay single-purpose?

**Q5 — Am I wrong that CI is fine?** I have contradicted John's framing and I want that pressure-tested. My evidence is that `test.yml` on `origin/main` runs `npm run test:e2e` bare, that the 28-failure host mismatch is fixed and the runtime went 14m40s → 3m31s, and that the 2026-08-19 failure never reached CI at all. The counter-argument I can construct: if the *docs* say CI is meaningless (F6) and there is *no branch protection* (F2), then in practice CI is not functioning as a gate regardless of what the YAML says — which would make John's framing right and mine pedantic. I think F2 and F6 resolve that, but a reviewer should push here.

---

## Review

```
reviewer: fresh-eyes review session — re-ran the incident reconstruction, the prototype hook, and the GitHub/Inlet audits from a clean origin/main worktree (c0c5177)
reviewed_at: 2026-08-19
verdict: approve-with-changes
```

### Summary

This is a strong, honest RCA whose mechanical claims verified exactly — I re-ran the reconstruction in the incident checkout, executed the prototype hook against the live incident state, re-pulled the GitHub and Inlet facts, and swept all 83 local branches for stranded proposals. Three things must change before implementation: `.claude/settings.json` is gitignored in SendMo, so F1 as written does not propagate the way the Inlet design it borrows does (and two of the proposal's own verification steps pass vacuously because of it); Q1 rests on a false premise, because agents authenticate as John's own GitHub account, so a ruleset bypass cannot distinguish him from them; and F6 must be a rewrite, not a delete, because half of the "stale" PLAYBOOK paragraph is still true. The core verdict — session hygiene, not CI — is correct.

### What I verified mechanically

Every number below was re-derived with commands, not taken from the proposal.

- **Incident state:** `fix/e2e-infra-audit` is 44 behind / 4 ahead (all 4 docs-only); `git rev-list --count HEAD..origin/main` = 44 in 25ms; local `origin/main` = `c0c5177`, last advanced 2026-08-18 21:44 **by push**; `FETCH_HEAD` mtime Aug 19 08:43; `git status -sb` shows `## fix/e2e-infra-audit...origin/fix/e2e-infra-audit` with no ahead/behind counts. All as claimed.
- **Damage inventory:** invisible PRs are exactly #62, #64, #67–#73 (nine — #65/#66 are correctly excluded, their commits are ancestors of the branch); 70 files differ, 29 under `src/` at 1,737(+)/507(−); `LOG.md` numstat main→HEAD is `20 191`; migrations 041/042 and the four named proposals exist only on main. PR #64 merged 2026-08-18T06:16:46Z from head `fix/e2e-infra-audit`. All exact.
- **Prototype hook:** found in the scratchpad and executed. Against the incident checkout it prints the proposal's quoted output **verbatim** (041/042 + the four proposals; only the fetch-age differs, as it should). Silent with rc=0 on the current worktree, in a non-git directory, and in a repo with no `origin/main`. Fires correctly on a detached stale HEAD. Measured 40ms.
- **Hooks split:** confirmed the proposal does NOT conflate the two hook systems. F1 is a Claude Code hook (`.claude/settings.json`, harness-executed) and runs fine despite the broken `core.hookspath`; F5 concerns git hooks only. `core.hookspath` = `/Users/ja/AI Brain/sendmo/.git/hooks` (local scope only; no global/system value), the directory does not exist, `.git/hooks/` holds only `.sample` files, and nothing (no husky, no `prepare` script) depends on the current value — unsetting is safe and changes nothing until someone installs a real git hook, which is the point.
- **GitHub:** repo is PUBLIC; branch protection 404; rulesets `[]`; the required-check name F2 needs is exactly the job name `Lint, Unit, and E2E Tests` (test.yml:19). Both cited run IDs exist and 32100723813 concluded `success` — the false green is real. Recent main runs: green, ~4 min.
- **Docs-lie claims:** both present on `origin/main` — PLAYBOOK's "`|| true` *and* `continue-on-error: true`" paragraph and TESTING.md's "e2e steps are currently non-blocking". test.yml:54 is bare `npm run test:e2e`.
- **Inlet:** 338 local branches; **162 more than 500 behind main (recomputed, exact)**; `.claude/settings.json` IS tracked in Inlet's git; `session-start-check.sh` / `new-session.sh` / `deploy.sh` all match the quoted logic including the push-before-deploy comment and the 2026-07-09 reference; `ci.yml` has no concurrency group; the flaky-suite LOG heading is verbatim; Rule 13's GitHub-Pro-declined note is at Inlet PLAYBOOK:160. Inlet is **private**, which is exactly why its protection costs money and SendMo's is free — the asymmetry framing holds.
- **Stranded proposals:** exactly the two named. I swept **all 83 local branches** for `*decided*` proposal files missing from `origin/main`: no third one exists.

### Per-fix: would it have prevented the 2026-08-19 incident?

| Fix | Prevents this incident? | Basis |
|---|---|---|
| F1 SessionStart hook | **YES — demonstrated.** Ran it against the incident checkout; the full damage report prints before any read. | executed |
| F2 ruleset | **NO** for the miss (nothing was pushed); **YES** for the two worst follow-ons — the 191-line LOG clobber needs a push it would block, and A6 recurrence. | reasoned + platform semantics |
| F3 new-session.sh | **YES, if used** — structural prevention, habit-dependent (proposal says so honestly). Requires B1 to keep the hook alive inside worktrees. | reasoned |
| F4 CI staleness step | **NO** — proposal's own admission; no PR was opened. | proposal is honest here |
| F5 hookspath repair | **NO** — enabler for future git hooks only. | verified nothing depends on it today |
| F6 docs fix | **NO** — different failure class. | — |
| F7 rescue | Recovery, not prevention. | — |
| F8 port pinning | **NO** — that's the A4c class, aggravated by F3. | LOG (main) :280 |
| F9 pruning | Correctly anti-recommended; Inlet's 338/162 numbers back it. | recomputed |

### Blocking issues

**B1 — `.claude/` is gitignored, so F1 does not self-propagate and two verification steps are vacuous.**
- **Location:** F1 design notes, F1 test plan case 2, Verification step 2; `.gitignore:40` on `origin/main` (`.claude/`).
- **Issue:** the Inlet property the proposal cites as the design basis — "Because both the settings file and the script are tracked in git, every worktree carries the hook. It self-propagates." — does not transfer: Inlet tracks `.claude/settings.json`; SendMo ignores the whole directory. Verified consequences: the fresh `origin/main` worktree materializes **no** `.claude/` at all, and `/Users/ja/AI-Brain/sendmo-who-sending-wt` has **no** `settings.json` — so the existing Stop hooks already don't run there, and F1 would exist only in the one shared checkout whose local file happens to carry it. F1 still catches *this* incident (it lives in the shared checkout), but a resumed stale **worktree** — the normal working surface once F3 lands — gets no warning. Worse for the test plan: F1 test case 2 and Verification step 2 expect "no hook output" in `sendmo-who-sending-wt`, which passes because **no hook is installed there**, not because the check passed. A test that cannot fail is not a test.
- **Suggested fix:** in the same PR as F1, change `.gitignore:40` from `.claude/` to `.claude/*` plus `!.claude/settings.json` and `!.claude/commands/` (keep ignoring `settings.local.json`, `worktrees/`, `launch.json`), and track the settings file — `scripts/claude-hooks/` is already tracked. (`/runtest`, `/buildtest`, `/verifyfix` in `.claude/commands/` are referenced by TESTING.md and are untracked today — same gap, same one-line fix.) Then rewrite Verification step 2 to prove the hook *ran*: create a scratch worktree, check out an older commit so it is genuinely behind, and expect the warning; silence-on-current is only meaningful once loud-on-stale is shown in the same environment.

**B2 — Q1's premise is false: a ruleset bypass cannot separate John from his agents.**
- **Location:** Open question Q1 ("John's own account could push docs directly while agents cannot"); F2 cost paragraph.
- **Issue:** every agent session on this machine authenticates as `jsa7cornell` (verified via `gh auth status`) — pushes, merges, everything. GitHub bypass actors are accounts/roles/apps; there is no platform-visible difference between John-at-the-keyboard and Claude-running-as-John. A bypass for John's account is a bypass for every agent, which silently reopens the exact honour-system hole F2 exists to close — including merging a red or check-less (A6) PR. The choice in Q1 as posed does not exist.
- **Suggested fix:** re-pose Q1 with the real options. (a) **No bypass** — docs land via PR; `gh pr create --fill && gh pr merge --auto --squash` makes that one command plus a ~4-minute lag. Real cost to name: each docs PR now triggers a Vercel **preview** deploy, and previews count against the account-wide Hobby daily cap (`reference_vercel-hobby-deploy-rate-limit` — one busy day here can rate-limit another project's prod deploy); mitigate with Vercel's ignored-build-step for docs-only paths, or accept it. (b) **Bypass for the account** — keeps today's direct-push convenience and restores the honour system for all local activity, human or agent. Recommend (a); if (b) is ever chosen, record it as a LOG-logged decision with a revisit date, not a quiet setting.

**B3 — F6 says "delete or rewrite"; only rewrite is correct, because half the paragraph is still true.**
- **Location:** F6; PLAYBOOK's "A green 'Provide Tests' run does not mean the e2e suite passed" paragraph; test.yml:80.
- **Issue:** the authed e2e step still runs with `continue-on-error: true` on `origin/main`. A fully green "Provide Tests" run therefore still does **not** certify the authed spec passed — that half of the claim remains true today; what's false is `|| true`, "both Playwright steps", and the implication that the mocked suite is suppressed. Wholesale deletion converts a stale warning into a fresh false assurance — the exact inverse of the 2026-08-18 failure, in the more dangerous direction.
- **Suggested fix:** replace, don't delete. Something like: *"The mocked e2e suite is BLOCKING (bare `npm run test:e2e` — a red result stops the merge). The authed step is deliberately non-blocking (`continue-on-error`, live-Supabase dependency): a green run does not certify it — check the run's annotations for an authed-step failure."* Same treatment in TESTING.md.

### Non-blocking concerns

- **N1 — the proposal's own LOG citations are stale-tree coordinates.** `LOG.md:830/:585/:113/:109` locate those quotes on the *incident branch*; on `origin/main` they live at :1001/:756/:284/:280 (all four quotes verified real, verbatim). An RCA about stale reads citing stale line numbers is a fitting exhibit — cite LOG entries by their dated headings, which survive prepends; fix before John files this as reference material.
- **N2 — FETCH_HEAD age is wrong outside the main checkout, and silence has a blind spot.** Measured: in a clone the hook printed `Last fetch: 496436h ago` (no FETCH_HEAD → epoch); in any linked worktree `.git` is a file, so `stat -f %m .git/FETCH_HEAD` misses too. Use `"$(git rev-parse --git-common-dir)/FETCH_HEAD"` and print "never" when absent. Bigger: the hook is silent whenever `behind==0`, but that only certifies HEAD against the *local snapshot* of `origin/main` — this incident's snapshot happened to be fresh (21:44, by push); after an offline weekend it won't be. Print one line when `behind==0` but the fetch is older than ~24h. That's the only Q4 addition I'd make.
- **N3 — no firing threshold.** The prototype warns at behind ≥ 1, and I measured #62–#73 = twelve PRs merged in ~22 hours — a legitimately resumed one-day-old PR branch will warn on every session start. Noise is how the proposal itself says warnings die. Suggest: full banner at ≥ 5 (still print the count in a single quiet line at 1–4), or include the ahead-count so "active PR branch" reads differently from "dead merged branch" — note the prototype's `merge-base --is-ancestor` line already distinguishes the dead-branch case; lean on it.
- **N4 — a cheaper mechanism the proposal missed, for the sharpest recorded near-miss.** Duplicate migration prefixes (036 claimed twice on 2026-07-06; the 041 near-miss here) are not fully closed by any staleness check — two *current* worktrees can both mint `043_*.sql` the same afternoon and merge textually clean. Three lines in CI close it forever: `ls supabase/migrations | cut -d'_' -f1 | sort | uniq -d` → fail if non-empty. Bundle into F4's step; it is cheaper than F4 and catches a class F1/F3/F4 all structurally cannot.
- **N5 — the proposal warns about the parked hub but never un-parks it.** After F7's cherry-pick lands, check the shared checkout back out to `main` and write the one-line convention F1's silence depends on (Inlet Rule 14's other half): *the shared checkout stays on clean `main`; docs-only commits happen there; code work happens in worktrees.* Otherwise `/Users/ja/AI-Brain/sendmo` stays on a dead branch and F1 fires on every hub session forever — a permanent alarm is wallpaper by week two, which is the failure mode the "silence means correct" design is supposed to prevent.
- **N6 — small factual wobbles, none load-bearing.** "Six PRs in three hours" is five in ~1h44m (#65 04:58Z → #67 06:42Z UTC). "This already happened, twice" heads a list of three prior echoes, and T3-3 / LOG:284 are stale-*docs*/uncommitted-work cousins rather than stale-*tree* incidents — say "two direct priors, two adjacent" and the claim is airtight. And per the memory file's own 08-19 addendum, the pre-incident rule's trigger was scoped to PRE-LAUNCH items, so the session arguably followed its instructions as written — which *sharpens* your thesis (prose triggers rot; only unconditional mechanisms survive) and is worth one sentence.

### Nits

- Prototype line 13 (`[ "$behind" -eq 0 ] && [ "$branch" != "main" ] && exit 0`) is dead — line 14 subsumes it.
- Detached HEAD prints "you are on 'HEAD'" — fine mechanically, worth a friendlier label.
- `stat -f %m` is BSD/macOS-only — fine on John's machine, note it if the script ever travels.
- "`useRecipientFlow.ts` alone lost 186 lines" — that's total churn (32+/154−); the file is net 122 lines smaller on main.
- F2 design note worth adding: the required check must byte-match the job name `Lint, Unit, and E2E Tests` (verified current), and any future rename of that job silently blocks **all** merges ("Expected" forever) until the ruleset is updated — put a comment on the job name in test.yml pointing at the ruleset.

### Predicted pitfalls (required)

1. **The warning gets read past.** The incident session ran the verify-command its memory prescribed and still concluded wrong; an advisory banner competes with a task prompt for attention (same class as `feedback_verify-before-asserting`). Verification step 7 is the right tripwire — but pre-commit to the consequence: if the reflog audit shows *any* post-F1 stale-tree work session, F3 stops being optional (the proposal gestures at this; make it binding).
2. **Bypass erosion reopens A6.** Two weeks of docs-PR friction → an account bypass gets added for convenience → every agent inherits it (B2) → a red or check-less PR merges again, silently — the 2026-08-18 PR #64 shape, now with a ruleset giving false comfort. Guard: bypass changes are LOG-logged decisions with a revisit date.
3. **F6 over-deletes and flips the lie.** Remove the whole PLAYBOOK paragraph and agents will treat any green run as full certification while the authed step still `continue-on-error`s (test.yml:80) — the inverse of run 32100723813's false green, on the live-Supabase surface where regressions are quietest.
4. **F3 before F8 re-runs A4c at higher frequency.** More live checkouts, one shared :5173, `reuseExistingServer: !CI` — LOG (main) :280: "every result from that run is meaningless, passes included." The proposal notes F3 aggravates F8; sequence F8 with or before F3, not "below the line."
5. **Silence certifies against a stale snapshot.** The hook's clean-exit path trusts the local `origin/main` ref; this incident's was fresh by luck (a 21:44 push). After days without a fetch, a genuinely stale session starts in certified silence. N2's fetch-age line closes it for one extra line of output.

### What the proposal got right

- **Every mechanical claim I could check was exact** — behind/ahead counts, timing, ref history, the nine-PR list, the divergence stats, the LOG numstat, the migration and proposal inventories, the GitHub state, the Inlet numbers including the oddly-specific 162-branches->500-behind (recomputed: exactly 162). This is the most verifiable proposal I have reviewed in this repo.
- **The prototype is real and its output is verbatim-real.** Running it against the live incident state reproduces the published damage report; it is silent and rc=0 in every clean or degenerate state I threw at it (non-git dir, no `origin/main`, detached HEAD, current worktree), 40ms, zero network.
- **The two hook systems are correctly kept apart** — F1 (Claude Code hook) works despite the broken `core.hookspath`; F5 is correctly scoped to future git hooks. I checked for conflation specifically; there is none.
- **The honest caveats are actually honest:** F4 admits it wouldn't have caught this incident; F9 argues *against* the intuitive fix with evidence; strict "require up to date" is rejected for the right merge-velocity reason (measured: 12 PRs in ~22h).
- **The Inlet comparison resists the flattering read** — "Inlet's CI is worse, its placement is better" is exactly what the files show, down to the private/public cost asymmetry that makes F2 free here when Inlet declined to pay for it.
- **The A6 close is correctly identified as the unique value of required checks:** a check that never ran is not a check that passed. Verified the PLAYBOOK A6 text and the job name F2 must pin.
- **F1/F2 ranked above F3** — set-and-forget before habit-dependent, given three failed prose lessons — is the right leverage ordering, and the design principle ("rank fixes by whether they survive an agent forgetting") is the reusable artifact here.

### Answers to the open questions

- **Q1:** Reframed per B2 — the bypass you describe cannot exist, because agents are John to GitHub. Recommend **no bypass**: docs via `gh pr create --fill && gh pr merge --auto --squash`, accepting the ~4-min lag; name the Vercel Hobby preview-deploy cost and mitigate with an ignored-build-step for docs-only changes. If friction proves intolerable in practice, add the bypass *as a logged decision*, knowing exactly what it reopens.
- **Q2:** Warn-only to start — agree, and the measured velocity (12 PRs/~22h) says a 40-commit hard-fail would false-positive legitimate multi-day branches. Keep the always-on `$GITHUB_STEP_SUMMARY` line; revisit with two weeks of data. Land N4's duplicate-migration check in the same step — it is the part of the near-miss no threshold can cover.
- **Q3:** Land F1 first and let step-7 data decide F3 — agree, with two amendments: B1 is F3's real prerequisite (worktrees must carry the hook, or F3 *removes* sessions from the only checkout that warns), and F8 rides with F3 (pitfall 4). The per-worktree `npm install` is real but bounded (~1–2 min); the memory file already prescribes this exact flow, so F3 is packaging an existing convention, not a new habit.
- **Q4:** Stay single-purpose. The one addition that belongs is N2's fetch-age line when `behind==0` — it guards the hook's own blind spot rather than adding a second topic. Dirty-checkout and duplicate-worktree signals: leave out, agreed.
- **Q5:** You are right, and here is the pressure-test you asked for: nothing CI-shaped could have fired on 2026-08-19 — nothing was pushed, and the truth was already local (I re-confirmed the ref was current, so even an automatic pre-read fetch adds nothing). What John was smelling is still real: CI's gates were paper (a red PR's merge button stayed live; A6 absence read as fine) and its own docs said green means nothing. F2 + F6 are the legitimate CI-shaped kernel of his complaint; your counter-argument paragraph concedes exactly the right amount. One addition: N4 is a CI mechanism that closes a *recorded* harm class this proposal's session-layer fixes structurally cannot (two current trees colliding), so "CI is fine" should read "CI is fine once F2/F6/N4 land."

### If John does only one thing

**F1 with B1 folded in — one small PR: track `.claude/settings.json` (gitignore negation), add `scripts/claude-hooks/session-start-check.sh` (with the N2 fetch-age fix), register it as a `SessionStart` hook.** Confidence: **high** — it is the only fix that was *demonstrated* against the actual incident, not argued: I ran it in the incident checkout and the entire damage report (041/042, all four proposals, the 44-count) printed in 40ms before any read could happen. It costs nothing when clean, fires exactly where all three prior stale-view incidents lived (before any push, where no CI can see), and B1 makes it cover worktrees — the surface F3 will make standard. F2 is a very close second at five minutes of Settings clicking; do both if two. But one thing: F1+B1.
