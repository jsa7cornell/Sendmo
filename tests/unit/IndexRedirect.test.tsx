// T3-3: signed-in users landing on `/` are redirected to `/dashboard`;
// signed-out users (and the auth-loading window) still see the marketing page.
// Covers the three variants of the guard in src/pages/Index.tsx.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// Mutable auth state the mock reads per-test.
let mockAuth: { user: unknown; loading: boolean } = { user: null, loading: false };
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => mockAuth,
}));
// Isolate the redirect logic — AppHeader pulls in unrelated deps.
vi.mock("@/components/AppHeader", () => ({ default: () => <div data-testid="app-header" /> }));

import Index from "@/pages/Index";

function renderAt() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<Index />} />
        <Route path="/dashboard" element={<div>DASHBOARD PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockAuth = { user: null, loading: false };
});

describe("Index landing redirect (T3-3)", () => {
  it("signed-out visitor sees the marketing homepage (no redirect)", () => {
    mockAuth = { user: null, loading: false };
    renderAt();
    expect(screen.getAllByText(/Prepaid shipping made easy/i).length).toBeGreaterThan(0);
    expect(screen.queryByText("DASHBOARD PAGE")).not.toBeInTheDocument();
  });

  it("does NOT redirect while auth is still loading (no flash-bounce)", () => {
    mockAuth = { user: null, loading: true };
    renderAt();
    // loading=true → render marketing even though user is null-so-far.
    expect(screen.getAllByText(/Prepaid shipping made easy/i).length).toBeGreaterThan(0);
    expect(screen.queryByText("DASHBOARD PAGE")).not.toBeInTheDocument();
  });

  it("signed-in visitor is redirected to /dashboard", () => {
    mockAuth = { user: { id: "u1" }, loading: false };
    renderAt();
    expect(screen.getByText("DASHBOARD PAGE")).toBeInTheDocument();
    expect(screen.queryAllByText(/Prepaid shipping made easy/i).length).toBe(0);
  });
});
