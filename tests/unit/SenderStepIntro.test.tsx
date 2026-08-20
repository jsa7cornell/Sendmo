import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import SenderStepIntro from "../../src/components/sender/SenderStepIntro";
import type { LinkData } from "../../src/lib/api";

function makeLink(overrides: Partial<LinkData> = {}): LinkData {
  return {
    id: "x",
    short_code: "abc",
    link_type: "flexible",
    status: "active",
    max_price_cents: 10000,
    preferred_speed: "standard",
    preferred_carrier: null,
    size_hint: null,
    notes: null,
    recipient_city: "Seattle",
    recipient_state: "WA",
    recipient_zip: "98101",
    recipient_name: "Alex",
    ...overrides,
  };
}

describe("SenderStepIntro", () => {
  it("renders recipient name in the headline", () => {
    render(<SenderStepIntro linkData={makeLink()} onContinue={() => {}} />);
    expect(screen.getByText(/sending a package to Alex/i)).toBeInTheDocument();
  });

  it("falls back to a generic headline when recipient_name is missing", () => {
    render(<SenderStepIntro linkData={makeLink({ recipient_name: null })} onContinue={() => {}} />);
    expect(screen.getByText(/sending a package via this prepaid link/i)).toBeInTheDocument();
  });

  it("shows city/state but NEVER street/zip (Rule 7)", () => {
    render(<SenderStepIntro linkData={makeLink()} onContinue={() => {}} />);
    expect(screen.getByText(/Seattle, WA/)).toBeInTheDocument();
    // street/zip must not appear in the sender UI text per PLAYBOOK rule 7.
    expect(screen.queryByText(/98101/)).not.toBeInTheDocument();
  });

  it("calls onContinue when the CTA is clicked", () => {
    const onContinue = vi.fn();
    render(<SenderStepIntro linkData={makeLink()} onContinue={onContinue} />);
    fireEvent.click(screen.getByRole("button", { name: /get started/i }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
});
