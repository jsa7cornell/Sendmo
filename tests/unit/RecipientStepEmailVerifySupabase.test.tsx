import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
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
  // Since 2026-08-19 this step opens on an email field, not the digit grid —
  // it owns capture as well as verification, because step 1 no longer asks for
  // an email at all. Every test below that is about the CODE has to send one
  // first, which is also the honest sequence: a digit grid should never appear
  // for a code that was never sent.
  async function sendCode(user: ReturnType<typeof userEvent.setup>) {
    await waitFor(() => screen.getByRole("button", { name: /Send code/i }));
    await user.click(screen.getByRole("button", { name: /Send code/i }));
    await waitFor(() => screen.getByLabelText("Digit 1"));
  }

  it("opens on the email field, prefilled from the draft", async () => {
    renderStep({});
    await waitFor(() =>
      expect(screen.getByText(/Where should we reach you\?/i)).toBeInTheDocument(),
    );
    expect(screen.getByLabelText("Email")).toHaveValue("user@example.com");
    // No code has been sent, so there is nothing to type digits into yet.
    expect(screen.queryByLabelText("Digit 1")).toBeNull();
  });

  it("rejects a malformed address before spending an OTP send on it", async () => {
    const user = userEvent.setup();
    renderStep({ state: { email: "" } });
    await waitFor(() => screen.getByLabelText("Email"));

    await user.type(screen.getByLabelText("Email"), "notanemail");
    await user.click(screen.getByRole("button", { name: /Send code/i }));

    await waitFor(() =>
      expect(screen.getByText(/Enter a valid email address/i)).toBeInTheDocument(),
    );
    expect(mockSignInWithOtp).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Digit 1")).toBeNull();
  });

  it("Send code sends the OTP, records the address, and reveals the digit grid", async () => {
    const onUpdate = vi.fn();
    const user = userEvent.setup();
    renderStep({ onUpdate });
    await sendCode(user);

    expect(mockSignInWithOtp).toHaveBeenCalledWith({
      email: "user@example.com",
      options: {
        emailRedirectTo: expect.stringContaining("/onboarding/full-label/verify?confirmed=1"),
      },
    });
    // The address has to land in flow state here — nothing upstream captures
    // it any more, so without this the label would be emailed nowhere.
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ email: "user@example.com", verification_email: "user@example.com" }),
    );
    expect(screen.getByText(/Confirm your email/i)).toBeInTheDocument();
  });

  it("keeps the digit grid hidden when the send fails", async () => {
    mockSignInWithOtp.mockResolvedValue({ data: null, error: { message: "Rate limit reached" } });
    const user = userEvent.setup();
    renderStep({});
    await waitFor(() => screen.getByRole("button", { name: /Send code/i }));
    await user.click(screen.getByRole("button", { name: /Send code/i }));

    await waitFor(() => expect(screen.getByText(/Rate limit reached/i)).toBeInTheDocument());
    expect(screen.queryByLabelText("Digit 1")).toBeNull();
  });

  // Fill all 6 OTP digit inputs. Uses fireEvent.change (synchronous, no
  // focus management) rather than userEvent.type — the latter juggles focus
  // across the 6 auto-advancing inputs and that race made this test flaky in
  // CI (the Verify button stayed disabled because not all 6 setStates had
  // committed when the assertion ran). fireEvent.change commits each digit
  // deterministically.
  function fillOtp(code: string) {
    for (let i = 0; i < code.length; i++) {
      fireEvent.change(screen.getByLabelText(`Digit ${i + 1}`), {
        target: { value: code[i] },
      });
    }
  }

  it("calls supabase.auth.verifyOtp with the typed code and marks verified", async () => {
    const onUpdate = vi.fn();
    const user = userEvent.setup();
    renderStep({ onUpdate });
    await sendCode(user);

    fillOtp("123456");
    const verifyBtn = screen.getByRole("button", { name: /Verify and continue/i });
    await waitFor(() => expect(verifyBtn).toBeEnabled());
    await user.click(verifyBtn);

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
    await sendCode(user);

    fillOtp("111111");
    const verifyBtn = screen.getByRole("button", { name: /Verify and continue/i });
    await waitFor(() => expect(verifyBtn).toBeEnabled());
    await user.click(verifyBtn);
    await waitFor(() => expect(screen.getByText(/Token has expired/i)).toBeInTheDocument());
  });

  it("Resend code triggers signInWithOtp for the same email with the verify-step redirect target", async () => {
    const user = userEvent.setup();
    renderStep({});
    await sendCode(user);
    mockSignInWithOtp.mockClear();
    await user.click(screen.getByText(/Resend code/i));
    await waitFor(() => {
      expect(mockSignInWithOtp).toHaveBeenCalledWith({
        email: "user@example.com",
        options: { emailRedirectTo: expect.stringContaining("/onboarding/full-label/verify?confirmed=1") },
      });
    });
  });

  it("does NOT render a Google CTA on either phase", async () => {
    const user = userEvent.setup();
    renderStep({});
    await waitFor(() => screen.getByRole("button", { name: /Send code/i }));
    expect(screen.queryByRole("button", { name: /Continue with Google/i })).toBeNull();
    await sendCode(user);
    expect(screen.queryByRole("button", { name: /Continue with Google/i })).toBeNull();
  });

  it("Use a different email returns to the email field, NOT to the previous step", async () => {
    const onBack = vi.fn();
    const user = userEvent.setup();
    renderStep({ onBack });
    await sendCode(user);

    await user.click(screen.getByText(/Use a different email/i));

    // onBack() was right when step 1 owned the email field. It now lands on a
    // step with no email input, leaving the user no way to change the address.
    expect(onBack).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByLabelText("Email")).toBeInTheDocument());
  });

  it("renders the verified success state when state.email_verified is true", async () => {
    renderStep({ state: { email_verified: true, verification_email: "user@example.com" } });
    await waitFor(() => expect(screen.getByText(/Email verified/i)).toBeInTheDocument());
  });
});
