import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const mockSignInWithOtp = vi.fn();
const mockVerifyOtp = vi.fn();
const mockSignInWithOAuth = vi.fn();
const mockGetSession = vi.fn();
const mockOnAuthStateChange = vi.fn();

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: (...a: unknown[]) => mockGetSession(...a),
      onAuthStateChange: (...a: unknown[]) => mockOnAuthStateChange(...a),
      signInWithOtp: (...a: unknown[]) => mockSignInWithOtp(...a),
      verifyOtp: (...a: unknown[]) => mockVerifyOtp(...a),
      signInWithOAuth: (...a: unknown[]) => mockSignInWithOAuth(...a),
      signOut: vi.fn(),
    },
    from: () => ({
      select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null }) }) }),
      insert: () => Promise.resolve({}),
    }),
  },
}));

import { AuthProvider } from "@/contexts/AuthContext";
import RecipientStepEmailVerifySupabase from "@/components/recipient/RecipientStepEmailVerifySupabase";
import type { RecipientFlowState } from "@/hooks/useRecipientFlow";
import { emptyAddress } from "@/lib/utils";

function makeState(overrides: Partial<RecipientFlowState> = {}): RecipientFlowState {
  return {
    currentStep: 11,
    path: "full_label",
    completedSteps: [0, 1, 10],
    destinationAddress: emptyAddress(),
    email: "user@example.com",
    originAddress: emptyAddress(),
    senderEmail: "",
    itemDescription: "",
    packagingType: "box",
    dimensions: { length: "", width: "", height: "" },
    weight: { lbs: "", oz: "" },
    selectedRate: null,
    availableRates: [],
    easypostShipmentId: "",
    insurance: false,
    recommendedSpeedHint: null,
    paymentStatus: "idle",
    labelResult: null,
    distance_hint: "regional",
    size_hint: null,
    speed_preference: "standard",
    preferred_carrier: "any",
    price_cap: 100,
    verification_email: "",
    email_verified: false,
    short_code: "",
    tried: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue({ data: { session: null } });
  mockOnAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
  mockSignInWithOtp.mockResolvedValue({ data: {}, error: null });
  mockVerifyOtp.mockResolvedValue({ data: { user: { id: "u1", email: "user@example.com" } }, error: null });
  mockSignInWithOAuth.mockResolvedValue({ data: {}, error: null });
});

function renderStep(props: {
  state?: Partial<RecipientFlowState>;
  onUpdate?: (p: Partial<RecipientFlowState>) => void;
  onContinue?: () => void;
  onBack?: () => void;
  initialUrl?: string;
}) {
  const state = makeState(props.state);
  return render(
    <MemoryRouter initialEntries={[props.initialUrl ?? "/onboarding/full-label/verify"]}>
      <AuthProvider>
        <RecipientStepEmailVerifySupabase
          state={state}
          onUpdate={props.onUpdate ?? (() => {})}
          onContinue={props.onContinue ?? (() => {})}
          onBack={props.onBack ?? (() => {})}
        />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("RecipientStepEmailVerifySupabase", () => {
  it("renders the confirm-your-email UI for the typed email", async () => {
    renderStep({});
    await waitFor(() => expect(screen.getByText(/Confirm your email/i)).toBeInTheDocument());
    expect(screen.getByText("user@example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Verify and continue/i })).toBeInTheDocument();
  });

  it("calls supabase.auth.verifyOtp with the typed code and marks verified", async () => {
    const onUpdate = vi.fn();
    const user = userEvent.setup();
    renderStep({ onUpdate });
    await waitFor(() => screen.getByLabelText("Digit 1"));

    for (let i = 0; i < 6; i++) {
      await user.type(screen.getByLabelText(`Digit ${i + 1}`), String(i + 1));
    }
    await user.click(screen.getByRole("button", { name: /Verify and continue/i }));

    await waitFor(() => {
      expect(mockVerifyOtp).toHaveBeenCalledWith({
        email: "user@example.com",
        token: "123456",
        type: "email",
      });
    });
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ email_verified: true, verification_email: "user@example.com" }),
    );
  });

  it("surfaces a Supabase error when verification fails", async () => {
    mockVerifyOtp.mockResolvedValue({ data: null, error: { message: "Token has expired" } });
    const user = userEvent.setup();
    renderStep({});
    await waitFor(() => screen.getByLabelText("Digit 1"));
    for (let i = 0; i < 6; i++) {
      await user.type(screen.getByLabelText(`Digit ${i + 1}`), "1");
    }
    await user.click(screen.getByRole("button", { name: /Verify and continue/i }));
    await waitFor(() => expect(screen.getByText(/Token has expired/i)).toBeInTheDocument());
  });

  it("Resend code triggers signInWithOtp for the same email with the verify-step redirect target", async () => {
    const user = userEvent.setup();
    renderStep({});
    await waitFor(() => screen.getByText(/Resend code/i));
    await user.click(screen.getByText(/Resend code/i));
    await waitFor(() => {
      expect(mockSignInWithOtp).toHaveBeenCalledWith({
        email: "user@example.com",
        options: { emailRedirectTo: expect.stringContaining("/onboarding/full-label/verify?confirmed=1") },
      });
    });
  });

  it("does NOT render a Google CTA — it lives at step 1 in the new design", async () => {
    renderStep({});
    await waitFor(() => screen.getByRole("button", { name: /Verify and continue/i }));
    expect(screen.queryByRole("button", { name: /Continue with Google/i })).toBeNull();
  });

  it("Use a different email calls onBack", async () => {
    const onBack = vi.fn();
    const user = userEvent.setup();
    renderStep({ onBack });
    await waitFor(() => screen.getByText(/Use a different email/i));
    await user.click(screen.getByText(/Use a different email/i));
    expect(onBack).toHaveBeenCalled();
  });

  it("renders the verified success state when state.email_verified is true", async () => {
    renderStep({ state: { email_verified: true, verification_email: "user@example.com" } });
    await waitFor(() => expect(screen.getByText(/Email verified/i)).toBeInTheDocument());
  });
});
