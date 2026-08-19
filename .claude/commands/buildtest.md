---
description: Author a new Playwright spec for a SendMo bug class — full variant coverage + regression-proof.
argument-hint: <bug commit / path / short description>
---

Author a Playwright spec for: **$ARGUMENTS**

Read SendMo PLAYBOOK Rule 19 first for variant-axis discipline. Then:

1. **Read the bug's fix commit and surrounding code.** Identify the variant axis the fix changes behavior of. SendMo examples:
   - Payment paths → `{full-prepaid, flexible-link} × {test-mode, live_comp, live_charge}`
   - Shipment lifecycle → `{label_created, in_use, cancelled, completed, expired}`
   - Cancel/change auth shape → `{authed, anonymous-with-cancel-token, anonymous}`

2. **Author the spec** under `sendmo/tests/e2e/<descriptive-name>.spec.ts`. Exercise each variant cell your fix changes the behavior of (not just the one named in the bug report). Follow the patterns in existing specs like `tests/e2e/full-label-flow.spec.ts`.

3. **Server-trusted state.** SendMo's payments + mode resolution are server-derived (PLAYBOOK Rule 14). Set up scenario state via real Edge Function calls (`signInWithOtp`, `payments`, `payment-methods`, `cancel-label`, etc.) with appropriate JWT auth — don't reach into the DB directly. If a scenario needs state no Edge Function can produce, that's signal to either add a test-only endpoint or fixture-test instead.

4. **ARIA audit on the surface you're asserting against.** If selectors are brittle because the markup lacks `role="..."` / `aria-label` / stable accessible names, prefer fixing the markup in the same PR (accessibility-positive). Fall back to `data-testid` only when ARIA semantics genuinely don't fit — and flag the gap in the LOG entry.

5. **Validate the spec actually catches the bug.** On a scratch branch, revert the fix. Run the spec — it MUST fail with a clear assertion. Restore the fix. Re-run — it MUST pass. A spec that doesn't fail on the reverted state is a spec that doesn't catch the regression.

6. **Run `npm run test:e2e:browser`** from `sendmo/` to confirm the new spec passes alongside existing ones. Watch for the known-flaky Maps-API-key failures per WISHLIST; the new spec should not depend on Maps autocomplete unless absolutely necessary.

7. **Update the LOG entry's `Browser-verified:` block** citing the new spec:
   ```
   Browser-verified:
     spec: tests/e2e/<your-new-spec>.spec.ts
     variants-covered: [<list of variants>]
   ```

Cross-project sibling: AgentEnvoy uses Rule 29 + identical command shape; the verification proposal that spawned both rules is `agentenvoy/proposals/2026-05-13_claude-production-verification-infra_reviewed-2026-05-13_decided-2026-05-13.md`.
