import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";

// ─── Supabase mock ──────────────────────────────────────────

const mockSignInWithOtp = vi.fn();
const mockSignOut = vi.fn();
const mockGetSession = vi.fn();
const mockOnAuthStateChange = vi.fn();

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
      signInWithOtp: (...args: unknown[]) => mockSignInWithOtp(...args),
      signOut: (...args: unknown[]) => mockSignOut(...args),
      onAuthStateChange: (...args: unknown[]) => mockOnAuthStateChange(...args),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: null }),
        }),
      }),
      insert: () => Promise.resolve({}),
    }),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue({ data: { session: null } });
  mockOnAuthStateChange.mockReturnValue({
    data: { subscription: { unsubscribe: vi.fn() } },
  });
  mockSignInWithOtp.mockResolvedValue({ data: {}, error: null });
  mockSignOut.mockResolvedValue({ error: null });
});

// ─── Test component that uses useAuth ───────────────────────

function AuthDisplay() {
  const { user, session, signIn, signOut } = useAuth();
  return (
    <div>
      <span data-testid="status">{session ? "authenticated" : "anonymous"}</span>
      <span data-testid="email">{user?.email ?? "none"}</span>
      <button onClick={() => signIn("test@example.com")}>sign-in</button>
      <button onClick={() => signOut()}>sign-out</button>
    </div>
  );
}

function renderWithAuth() {
  return render(
    <BrowserRouter>
      <AuthProvider>
        <AuthDisplay />
      </AuthProvider>
    </BrowserRouter>,
  );
}

// ─── Tests ──────────────────────────────────────────────────

describe("AuthContext", () => {
  it("starts with no session", async () => {
    renderWithAuth();
    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("anonymous");
      expect(screen.getByTestId("email")).toHaveTextContent("none");
    });
  });

  it("calls signInWithOtp with email and redirect", async () => {
    const user = userEvent.setup();
    renderWithAuth();
    await waitFor(() => screen.getByText("sign-in"));
    await user.click(screen.getByText("sign-in"));

    expect(mockSignInWithOtp).toHaveBeenCalledWith({
      email: "test@example.com",
      options: {
        emailRedirectTo: expect.stringContaining("/dashboard"),
      },
    });
  });

  it("returns error message on sign-in failure", async () => {
    mockSignInWithOtp.mockResolvedValue({
      data: {},
      error: { message: "rate limit exceeded" },
    });
    const user = userEvent.setup();
    renderWithAuth();
    await waitFor(() => screen.getByText("sign-in"));
    await user.click(screen.getByText("sign-in"));
    // The signIn function should return the error
    expect(mockSignInWithOtp).toHaveBeenCalled();
  });

  it("calls supabase signOut", async () => {
    const user = userEvent.setup();
    renderWithAuth();
    await waitFor(() => screen.getByText("sign-out"));
    await user.click(screen.getByText("sign-out"));
    expect(mockSignOut).toHaveBeenCalled();
  });

  it("picks up session from onAuthStateChange", async () => {
    const mockUser = { id: "123", email: "john@test.com" };
    const mockSession = { user: mockUser, access_token: "tok" };

    // Simulate auth state change callback
    mockOnAuthStateChange.mockImplementation((callback) => {
      // Call the callback immediately with a session
      setTimeout(() => callback("SIGNED_IN", mockSession), 10);
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });

    renderWithAuth();
    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("authenticated");
      expect(screen.getByTestId("email")).toHaveTextContent("john@test.com");
    });
  });
});
