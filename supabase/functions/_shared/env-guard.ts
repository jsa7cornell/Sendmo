// assertKeysMatchEnv — PRE-LAUNCH T2-4 key-mismatch guard.
//
// Keyed on SENDMO_ENV === "production" (environment IDENTITY — set once,
// never flipped), NOT on SENDMO_LIVE_DEFAULT (the kill switch). Review B5:
// tying the guard to the kill switch would disarm it exactly when a
// mid-incident flip makes misconfiguration most likely.
//
// In production, a TEST key on the money path means customers silently
// transact against fake rails: fake labels, no money, no error. Refuse to
// serve instead. Checks the live-mode keys the functions actually use:
//   • EASYPOST_API_KEY (live EasyPost slot) — test keys start "EZTK"
//   • STRIPE_SECRET_KEY_LIVE, and STRIPE_SECRET_KEY (its fallback in
//     _shared/stripe.ts) — test keys start "sk_test_"
// No-op outside production, and when keys are absent (presence is a
// different failure with its own per-callsite errors).

export function assertKeysMatchEnv(
    getEnv: (k: string) => string | undefined = (k) => Deno.env.get(k),
): void {
    if (getEnv("SENDMO_ENV") !== "production") return;

    const easypostLiveKey = getEnv("EASYPOST_API_KEY") ?? "";
    const stripeLiveKey = getEnv("STRIPE_SECRET_KEY_LIVE") ?? "";
    const stripeFallbackKey = getEnv("STRIPE_SECRET_KEY") ?? "";

    if (
        easypostLiveKey.startsWith("EZTK") ||
        stripeLiveKey.startsWith("sk_test_") ||
        stripeFallbackKey.startsWith("sk_test_")
    ) {
        throw new Error(
            "FATAL: Environment key mismatch — test key present in production",
        );
    }
}
