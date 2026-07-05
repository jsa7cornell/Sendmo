// Badge/test-copy gating on the checkout form (T1-1 review N1).
//
// The amber "Test Mode" / red "LIVE" badge and the "use card 4242…" hint are
// admin dogfood affordances. Pre-T1-1 they rendered for everyone — a real
// customer saw an amber "Test Mode" badge at checkout. Now they render only
// for admins; customers get a plain checkout.
//
// FlexPaymentStep and AddCardModal carry the identical two-line isAdmin gate;
// they are not DOM-rendered here (heavier mount surface) — this spec pins the
// pattern on the primary customer surface.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

let mockIsAdmin = false;

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ isAdmin: mockIsAdmin }),
}));

vi.mock("@/lib/api", () => ({
  formatCents: (c: number) => `$${(c / 100).toFixed(2)}`,
  createPaymentIntent: vi.fn().mockResolvedValue({
    client_secret: "cs_test_secret",
    payment_intent_id: "pi_test_123",
    customer_session_client_secret: null,
  }),
}));

vi.mock("@/lib/stripeClient", () => ({
  getStripeForMode: () => Promise.resolve(null),
}));

vi.mock("@stripe/react-stripe-js", () => ({
  Elements: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PaymentElement: () => <div data-testid="payment-element" />,
  useStripe: () => null,
  useElements: () => null,
}));

import StripePaymentForm from "@/components/recipient/StripePaymentForm";

const PROPS = {
  totalCents: 1234,
  easypostShipmentId: "shp_x",
  onSuccess: vi.fn(),
};

async function renderForm(liveMode: boolean) {
  render(<StripePaymentForm {...PROPS} liveMode={liveMode} />);
  await waitFor(() => expect(screen.getByTestId("payment-element")).toBeInTheDocument());
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsAdmin = false;
});

describe("StripePaymentForm badge gating (review N1)", () => {
  it("customer in test mode: no badge, no 4242 hint — plain checkout", async () => {
    await renderForm(false);
    expect(screen.queryByText("Test Mode")).not.toBeInTheDocument();
    expect(screen.queryByText(/4242/)).not.toBeInTheDocument();
  });

  it("customer in live mode: no LIVE badge", async () => {
    await renderForm(true);
    expect(screen.queryByText("LIVE")).not.toBeInTheDocument();
    expect(screen.queryByText("Test Mode")).not.toBeInTheDocument();
  });

  it("admin in test mode: amber badge + 4242 hint render", async () => {
    mockIsAdmin = true;
    await renderForm(false);
    expect(screen.getByText("Test Mode")).toBeInTheDocument();
    expect(screen.getByText(/4242 4242 4242 4242/)).toBeInTheDocument();
  });

  it("admin in live mode: red LIVE badge, no test-card hint", async () => {
    mockIsAdmin = true;
    await renderForm(true);
    expect(screen.getByText("LIVE")).toBeInTheDocument();
    expect(screen.queryByText(/4242/)).not.toBeInTheDocument();
  });

  it("save-card consent disclosure still renders for everyone (H2 D1 — not an admin affordance)", async () => {
    await renderForm(false);
    expect(screen.getByText(/save your card to handle any carrier adjustments/i)).toBeInTheDocument();
  });
});
