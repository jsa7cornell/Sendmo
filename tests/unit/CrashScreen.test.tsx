// CrashScreen + boundary behavior (T1-3 frontend half).
// The second test pins the load-bearing inert-contract claim: with
// Sentry.init never called, Sentry.ErrorBoundary still catches the render
// crash and shows the fallback (captureException is a no-op without a client).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import * as Sentry from "@sentry/react";
import CrashScreen from "@/components/CrashScreen";

function Bomb(): never {
    throw new Error("boom (test)");
}

describe("CrashScreen", () => {
    beforeEach(() => {
        // React logs boundary-caught errors; keep test output clean.
        vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("renders the heading, reload button, and support link", () => {
        render(<CrashScreen />);
        expect(screen.getByRole("heading", { name: /something went wrong/i })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /reload page/i })).toBeInTheDocument();
        expect(screen.getByRole("link", { name: /contact support/i })).toHaveAttribute(
            "href",
            "mailto:support@sendmo.co",
        );
    });

    it("Sentry.ErrorBoundary shows CrashScreen on a render crash even with Sentry never initialized", () => {
        render(
            <Sentry.ErrorBoundary fallback={<CrashScreen />}>
                <Bomb />
            </Sentry.ErrorBoundary>,
        );
        expect(screen.getByRole("heading", { name: /something went wrong/i })).toBeInTheDocument();
    });
});
