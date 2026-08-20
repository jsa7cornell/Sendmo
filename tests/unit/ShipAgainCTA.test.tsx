import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ShipAgainCTA, { shouldShowShipAgain } from "../../src/components/tracking/ShipAgainCTA";

// Polyfill localStorage (vitest jsdom in this project has an incomplete one).
beforeAll(() => {
  const store = new Map<string, string>();
  const mock = {
    getItem: (k: string) => store.has(k) ? store.get(k)! : null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  };
  Object.defineProperty(globalThis, "localStorage", { value: mock, writable: true, configurable: true });
  Object.defineProperty(window, "localStorage", { value: mock, writable: true, configurable: true });
});

beforeEach(() => {
  try { window.localStorage.removeItem("sendmo:sender:v1"); } catch { /* noop */ }
});

describe("shouldShowShipAgain — layered visibility signal (proposal §13 B4)", () => {
  const base = { linkShortCode: "abc", hasSavedSender: false };

  it("hides when no link_short_code regardless of other signals", () => {
    expect(shouldShowShipAgain({
      ...base, isFresh: true, isAuthenticated: false, viewerIsRecipient: false,
      linkShortCode: null,
    })).toBe(false);
  });

  it("hides for the recipient (authenticated link owner) even when fresh=1", () => {
    expect(shouldShowShipAgain({
      ...base, isFresh: true, isAuthenticated: true, viewerIsRecipient: true,
    })).toBe(false);
  });

  it("shows when ?fresh=1 even with no saved sender (just-shipped guarantee)", () => {
    expect(shouldShowShipAgain({
      ...base, isFresh: true, isAuthenticated: false, viewerIsRecipient: false,
    })).toBe(true);
  });

  it("shows for anonymous viewer with a saved sender on this device", () => {
    expect(shouldShowShipAgain({
      ...base, isFresh: false, isAuthenticated: false, viewerIsRecipient: false,
      hasSavedSender: true,
    })).toBe(true);
  });

  it("shows for an authenticated viewer who is NOT the recipient", () => {
    expect(shouldShowShipAgain({
      ...base, isFresh: false, isAuthenticated: true, viewerIsRecipient: false,
    })).toBe(true);
  });

  it("hides for anonymous viewer with no saved sender and no fresh flag", () => {
    expect(shouldShowShipAgain({
      ...base, isFresh: false, isAuthenticated: false, viewerIsRecipient: false,
    })).toBe(false);
  });
});

describe("ShipAgainCTA — rendering", () => {
  function wrap(ui: React.ReactNode) {
    return <MemoryRouter>{ui}</MemoryRouter>;
  }

  it("renders the recipient name when provided", () => {
    render(wrap(
      <ShipAgainCTA
        isFresh={true}
        isAuthenticated={false}
        viewerIsRecipient={false}
        linkShortCode="abc"
        recipientName="Alex"
      />,
    ));
    expect(screen.getByText(/Ship another package to Alex/)).toBeInTheDocument();
  });

  it("falls back to a generic phrasing when recipient name is missing", () => {
    render(wrap(
      <ShipAgainCTA
        isFresh={true}
        isAuthenticated={false}
        viewerIsRecipient={false}
        linkShortCode="abc"
        recipientName={null}
      />,
    ));
    expect(screen.getByText(/the same recipient/)).toBeInTheDocument();
  });

  it("renders nothing when the visibility heuristic returns false", () => {
    const { container } = render(wrap(
      <ShipAgainCTA
        isFresh={false}
        isAuthenticated={true}
        viewerIsRecipient={true}
        linkShortCode="abc"
        recipientName="Alex"
      />,
    ));
    expect(container.textContent).toBe("");
  });

  it("links to /s/<short_code> when shown", () => {
    render(wrap(
      <ShipAgainCTA
        isFresh={true}
        isAuthenticated={false}
        viewerIsRecipient={false}
        linkShortCode="mUgagu3HrS"
        recipientName="Alex"
      />,
    ));
    const link = screen.getByRole("link", { name: /ship another/i });
    expect(link.getAttribute("href")).toBe("/s/mUgagu3HrS");
  });
});
