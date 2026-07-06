// Truth table for the monitoring config resolver (T1-3 frontend half).
// Pins the ships-inert contract: enabled === presence of the env var.
// Proposal: 2026-07-06_sentry-posthog-frontend-monitoring (decided 2026-07-06).

import { describe, it, expect } from "vitest";
import { resolveMonitoringConfig } from "@/lib/monitoring";

const DSN = "https://abc123@o0.ingest.sentry.io/1";
const KEY = "phc_test123";

describe("resolveMonitoringConfig", () => {
    it("everything unset → both disabled (the ships-inert contract)", () => {
        const cfg = resolveMonitoringConfig({});
        expect(cfg.sentry.enabled).toBe(false);
        expect(cfg.posthog.enabled).toBe(false);
    });

    it("empty-string env vars count as unset", () => {
        const cfg = resolveMonitoringConfig({ sentryDsn: "", posthogKey: "" });
        expect(cfg.sentry.enabled).toBe(false);
        expect(cfg.posthog.enabled).toBe(false);
    });

    it("DSN set → sentry enabled, posthog still disabled", () => {
        const cfg = resolveMonitoringConfig({ sentryDsn: DSN });
        expect(cfg.sentry.enabled).toBe(true);
        expect(cfg.sentry.dsn).toBe(DSN);
        expect(cfg.posthog.enabled).toBe(false);
    });

    it("posthog key set → posthog enabled, sentry still disabled", () => {
        const cfg = resolveMonitoringConfig({ posthogKey: KEY });
        expect(cfg.posthog.enabled).toBe(true);
        expect(cfg.posthog.key).toBe(KEY);
        expect(cfg.sentry.enabled).toBe(false);
    });

    it("both set → both enabled", () => {
        const cfg = resolveMonitoringConfig({ sentryDsn: DSN, posthogKey: KEY });
        expect(cfg.sentry.enabled).toBe(true);
        expect(cfg.posthog.enabled).toBe(true);
    });

    it("vercelEnv production → environment production", () => {
        const cfg = resolveMonitoringConfig({ sentryDsn: DSN, vercelEnv: "production" });
        expect(cfg.sentry.environment).toBe("production");
    });

    it("vercelEnv preview → environment preview", () => {
        const cfg = resolveMonitoringConfig({ sentryDsn: DSN, vercelEnv: "preview" });
        expect(cfg.sentry.environment).toBe("preview");
    });

    it("vercelEnv unset/empty/unknown → environment development", () => {
        expect(resolveMonitoringConfig({ sentryDsn: DSN }).sentry.environment).toBe("development");
        expect(resolveMonitoringConfig({ sentryDsn: DSN, vercelEnv: "" }).sentry.environment).toBe("development");
        expect(resolveMonitoringConfig({ sentryDsn: DSN, vercelEnv: "development" }).sentry.environment).toBe("development");
    });

    it("release falls back to 'dev' when the build SHA is absent", () => {
        expect(resolveMonitoringConfig({ sentryDsn: DSN }).sentry.release).toBe("dev");
        expect(resolveMonitoringConfig({ sentryDsn: DSN, release: "" }).sentry.release).toBe("dev");
        expect(resolveMonitoringConfig({ sentryDsn: DSN, release: "abc1234" }).sentry.release).toBe("abc1234");
    });

    it("posthog host defaults to US cloud, overridable", () => {
        expect(resolveMonitoringConfig({ posthogKey: KEY }).posthog.apiHost).toBe("https://us.i.posthog.com");
        expect(
            resolveMonitoringConfig({ posthogKey: KEY, posthogHost: "https://eu.i.posthog.com" }).posthog.apiHost,
        ).toBe("https://eu.i.posthog.com");
    });
});
