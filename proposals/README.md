# SendMo proposals

See `~/AI Brain/PROPOSAL-REVIEW-PROTOCOL.md` for the protocol.

## Active proposals

- [2026-05-11_sendmo-public-tracking-code_reviewed-2026-05-11_decided-2026-05-11.md](2026-05-11_sendmo-public-tracking-code_reviewed-2026-05-11_decided-2026-05-11.md) — decouple `/track` URL from the carrier tracking number. Mint a SendMo-owned 7-char Crockford-base32 `public_code` per shipment; new canonical URL `sendmo.co/t/<code>`; legacy `/track/<carrier_number>` becomes a 301 redirect. Review surfaced that the actual bug today is "wrong shipment to wrong viewer" (`.single()` returns arbitrary matching row), not a 404 — collision severity is worse than originally framed. **Status:** decided 2026-05-11 (approved; implementation starting).
- [2026-04-26_stripe-integration-plan_reviewed-2026-04-26_decided-2026-05-11.md](2026-04-26_stripe-integration-plan_reviewed-2026-04-26_decided-2026-05-11.md) — wiring Stripe + ledger + reconciliation so SendMo can collect real money. **Status:** decided 2026-05-11. Six §11 decisions locked in (refund-to-card, $1 flat fee, D-then-C w/ mandate, 3-mode admin + role-based auth, carrier-adjustment caps). #4 (account-creation timing) deferred for research and blocks Phase A. #6/#9/#11 deferred to later phases. Phase 1 (full-label test-mode) already shipped in commit `90aebca`.
- [2026-04-26_links-manager_reviewed-2026-04-26_decided-2026-04-26.md](2026-04-26_links-manager_reviewed-2026-04-26_decided-2026-04-26.md) — auth-aware `/links/new` + `/links/:id/edit` outside the onboarding wizard, so returning users don't get OTP'd or asked to re-authorize a card. Refactors wizard step components into reusable presenters. **Status:** decided 2026-04-26 (approved; implementation in progress).
