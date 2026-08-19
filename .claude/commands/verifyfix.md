---
description: Verify a fix in a real browser per SendMo PLAYBOOK Rule 19 before writing the LOG entry.
argument-hint: <commit-or-file/line of the fix being verified>
---

I just shipped a fix at: **$ARGUMENTS**

Per SendMo PLAYBOOK Rule 19, verify it in a real browser before writing the LOG entry. Steps:

1. **Identify the variant axis.** Read the fix commit and surrounding code. What variants does this change the behavior of?
   - Payment paths typically span `{full-prepaid, flexible-link} × {test-mode, live_comp, live_charge}`
   - Shipment lifecycle: `{label_created, in_use, cancelled, completed, expired}`
   - Auth/link types: `{authed, anonymous-with-cancel-token, anonymous}`
   - Name the axis explicitly before proceeding. If you can't, the fix is broader than you've modeled — stop and trace.

2. **If a Playwright spec already covers the axis:** run `npm run test:e2e:browser` from `sendmo/` (with `npm run dev` running on :5173) and confirm pass for the relevant variants. Note any variants the existing spec doesn't cover. Known-flaky context: per WISHLIST, ~14 specs fail on missing `VITE_GOOGLE_MAPS_API_KEY` — distinguish those from new regressions.

3. **If no spec covers the axis:** drive the variants live via the Playwright MCP — `browser_navigate` → `browser_snapshot` → assert on the DOM. Exercise each variant cell your fix changes the behavior of. Capture the snapshot artifact path for each.

4. **Report the `Browser-verified:` block** for the LOG entry. Exactly one of:

   ```
   Browser-verified:
     spec: tests/e2e/<path>.spec.ts
     variants-covered: [<list>]
   ```

   ```
   Browser-verified:
     mcp-session: <snapshot artifact path>
     variants-covered: [<list>]
   ```

   Do **not** propose `n/a-category:` unless you can defend it against the closed enum (`pure-logic | agent-internal | infra | copy-only | migration`). "I'm confident" is not a typable value.

   **Before defaulting to `n/a-category`, name the tighter-rigor alternative and price it.** If a stream-fixture, Edge-Function unit test, or any non-browser-but-deterministic test could verify the contract this fix relies on, propose it explicitly: *"a fixture-driven test that POSTs X to the Edge Function and asserts response Y would cover this; ~30 min to wire."* Then let the human decide whether to accept that work or accept the exemption. An exemption offered without surfacing a feasible tighter alternative is a rationalization in good-faith-shaped clothing.

5. If the markup is too brittle for stable selectors (no ARIA roles, no `data-testid`), flag it — that's an accessibility gap the fix should probably also address.
