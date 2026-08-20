// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import ProtectedRoute from "@/components/ProtectedRoute";

// Offline suppression (session-durability Phase 1): a missing session while
// the browser is offline must hold on a waiting screen, not bounce to /login.

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ session: null, loading: false }),
}));

function renderProtected() {
  return render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <Routes>
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <div>secret dashboard</div>
            </ProtectedRoute>
          }
        />
        <Route path="/login" element={<div>login page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function setOnLine(value: boolean) {
  Object.defineProperty(window.navigator, "onLine", { value, configurable: true });
}

afterEach(() => setOnLine(true));

describe("ProtectedRoute offline handling", () => {
  it("redirects to /login when signed out and online", () => {
    setOnLine(true);
    renderProtected();
    expect(screen.getByText("login page")).toBeInTheDocument();
  });

  it("holds on an offline notice instead of redirecting when signed out and offline", () => {
    setOnLine(false);
    renderProtected();
    expect(screen.queryByText("login page")).not.toBeInTheDocument();
    expect(screen.getByText(/offline/i)).toBeInTheDocument();
  });

  it("offers an escape hatch to /login from the offline hold", () => {
    // A deliberately signed-out user (or a browser misreporting onLine=false)
    // must never be trapped on the hold screen.
    setOnLine(false);
    renderProtected();
    const link = screen.getByRole("link", { name: /sign-in/i });
    expect(link).toHaveAttribute("href", "/login");
  });
});
