// ─── Frontend monitoring init — PRE-LAUNCH T1-3, frontend half ───────
// Proposal: 2026-07-06_sentry-posthog-frontend-monitoring (decided 2026-07-06).
//
// Ships-inert contract (review B2): "inert" = no SDK initialization, no
// monitoring network calls, zero data leaves the browser. With
// VITE_SENTRY_DSN / VITE_POSTHOG_KEY unset (local dev, CI, pre-flip prod)
// both init branches below are dead code. The two deliberate pre-flip
// changes — the CrashScreen error boundary (always on, see main.tsx) and
// the Sentry bundle weight — are outside this contract.
//
// PII posture (payments product): sendDefaultPii false, no Sentry.setUser,
// no session replay/recording anywhere, PostHog autocapture OFF (review
// B4 — pageview-only until the explicit funnel-events fast-follow).

import * as Sentry from "@sentry/react";
import { useEffect } from "react";
import {
    useLocation,
    useNavigationType,
    createRoutesFromChildren,
    matchRoutes,
} from "react-router-dom";

export interface MonitoringConfig {
    sentry: { enabled: boolean; dsn: string; release: string; environment: string };
    posthog: { enabled: boolean; key: string; apiHost: string };
}

export interface MonitoringEnv {
    sentryDsn?: string;
    posthogKey?: string;
    posthogHost?: string;
    /** Build-time VERCEL_GIT_COMMIT_SHA (empty locally). */
    release?: string;
    /** Build-time VERCEL_ENV: "production" | "preview" | "" locally. */
    vercelEnv?: string;
}

// Pure — injected env, unit-tested truth table in tests/unit/monitoring.test.ts
// (pattern: src/lib/mode.ts). enabled === presence of the respective env var;
// this pins the ships-inert contract.
export function resolveMonitoringConfig(env: MonitoringEnv): MonitoringConfig {
    const environment =
        env.vercelEnv === "production"
            ? "production"
            : env.vercelEnv === "preview"
                ? "preview"
                : "development";
    return {
        sentry: {
            enabled: !!env.sentryDsn,
            dsn: env.sentryDsn ?? "",
            release: env.release || "dev",
            environment,
        },
        posthog: {
            enabled: !!env.posthogKey,
            key: env.posthogKey ?? "",
            apiHost: env.posthogHost || "https://us.i.posthog.com",
        },
    };
}

// Noise filter (review N6). Known-benign browser chatter + extension frames.
// Accepted limitation: ad-blockers drop some fraction of SDK traffic; no
// tunnel/proxy at this stage.
const IGNORE_ERRORS = [
    "ResizeObserver loop limit exceeded",
    "ResizeObserver loop completed with undelivered notifications",
    /^AbortError:/,
];
const DENY_URLS = [
    /^chrome-extension:\/\//i,
    /^moz-extension:\/\//i,
    /^safari(-web)?-extension:\/\//i,
];

/** Called once from main.tsx, before render. Never throws. */
export function initMonitoring(): void {
    // typeof-guards: the globals come from vite.config.ts `define`, which
    // vitest.config.ts does not apply — a bare reference would throw in tests.
    const release = typeof __APP_RELEASE__ !== "undefined" ? __APP_RELEASE__ : "";
    const vercelEnv = typeof __APP_ENV__ !== "undefined" ? __APP_ENV__ : "";
    const cfg = resolveMonitoringConfig({
        sentryDsn: import.meta.env.VITE_SENTRY_DSN,
        posthogKey: import.meta.env.VITE_POSTHOG_KEY,
        posthogHost: import.meta.env.VITE_POSTHOG_HOST,
        release,
        vercelEnv,
    });

    if (cfg.sentry.enabled) {
        Sentry.init({
            dsn: cfg.sentry.dsn,
            release: cfg.sentry.release,
            environment: cfg.sentry.environment,
            integrations: [
                // Parameterized route names need the withSentryReactRouterV7Routing
                // wrapper in App.tsx as well (review B1) — keep both in sync.
                Sentry.reactRouterV7BrowserTracingIntegration({
                    useEffect,
                    useLocation,
                    useNavigationType,
                    createRoutesFromChildren,
                    matchRoutes,
                }),
            ],
            tracesSampleRate: 0.1, // OQ1 — revisit after a month of real data
            sendDefaultPii: false,
            ignoreErrors: IGNORE_ERRORS,
            denyUrls: DENY_URLS,
        });
    }

    if (cfg.posthog.enabled) {
        // Review N5: analytics never rides the checkout-critical bundle —
        // dynamic import once the main thread is idle. A load failure must
        // never affect the app.
        const idle: (cb: () => void) => void =
            typeof window.requestIdleCallback === "function"
                ? (cb) => window.requestIdleCallback(cb)
                : (cb) => window.setTimeout(cb, 1);
        idle(() => {
            import("posthog-js")
                .then(({ default: posthog }) => {
                    posthog.init(cfg.posthog.key, {
                        api_host: cfg.posthog.apiHost,
                        capture_pageview: "history_change", // SPA pageviews
                        autocapture: false, // review B4 — pageview-only
                        disable_session_recording: true, // PII posture
                        person_profiles: "identified_only",
                        respect_dnt: true, // review N3
                    });
                })
                .catch(() => {
                    /* analytics is best-effort */
                });
        });
    }
}
