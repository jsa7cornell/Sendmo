import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import App from "@/App";

// Mock Supabase auth so ProtectedRoute resolves (no session → redirect to /login)
vi.mock("@/lib/supabase", () => ({
    supabase: {
        auth: {
            getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
            onAuthStateChange: vi.fn().mockReturnValue({
                data: { subscription: { unsubscribe: vi.fn() } },
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
        await waitFor(() => {
            expect(screen.getByText("Sign in")).toBeInTheDocument();
        });
    });

    it("renders the Onboarding on /onboarding", () => {
        window.history.pushState({}, "Test page", "/onboarding");
        render(<App />);
        expect(screen.getByText("How do you want to set this up?")).toBeInTheDocument();
    });

    it("renders Not Found on unknown paths", () => {
        window.history.pushState({}, "Test page", "/this-does-not-exist");
        render(<App />);
        expect(screen.getByText("Lost in transit")).toBeInTheDocument();
    });
});
