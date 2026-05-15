import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import App from "@/App";

// Mock Supabase auth so ProtectedRoute resolves (no session → redirect to /login)
vi.mock("@/lib/supabase", () => ({
    supabase: {
        auth: {
            getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
            // Fire INITIAL_SESSION immediately with null so AuthContext clears loading
            onAuthStateChange: vi.fn().mockImplementation((callback) => {
                callback("INITIAL_SESSION", null);
                return { data: { subscription: { unsubscribe: vi.fn() } } };
            }),
        },
    },
}));

describe("App Routing", () => {
    it("renders the home page on /", () => {
        window.history.pushState({}, "Test page", "/");
        render(<App />);
        expect(screen.getByText("Prepaid shipping made easy")).toBeInTheDocument();
    });

    it("renders the FAQ page on /faq", () => {
        window.history.pushState({}, "Test page", "/faq");
        render(<App />);
        expect(screen.getByText("FAQ")).toBeInTheDocument();
    });

    it("redirects unauthenticated users from /dashboard to /login", async () => {
        window.history.pushState({}, "Test page", "/dashboard");
        render(<App />);
        // ProtectedRoute shows a spinner while auth resolves; give it extra time
        await waitFor(() => {
            expect(screen.getByText("Sign in")).toBeInTheDocument();
        }, { timeout: 5000 });
    });

    it("renders the Onboarding on /onboarding", async () => {
        window.history.pushState({}, "Test page", "/onboarding");
        render(<App />);
        await waitFor(() => {
            expect(screen.getByText("How should we set up your prepaid shipment?")).toBeInTheDocument();
        });
    });

    it("renders Not Found on unknown paths", () => {
        window.history.pushState({}, "Test page", "/this-does-not-exist");
        render(<App />);
        expect(screen.getByText("Lost in transit")).toBeInTheDocument();
    });
});
