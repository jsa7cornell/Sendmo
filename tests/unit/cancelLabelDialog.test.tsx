import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import CancelLabelDialog from "@/components/tracking/CancelLabelDialog";

// Pure-presenter coverage for the cancel/change confirm dialog.
// Decided proposal: 2026-05-11_label-cancel-and-change_decided-2026-05-12.

describe("CancelLabelDialog", () => {
  function renderOpen(
    overrides: Partial<React.ComponentProps<typeof CancelLabelDialog>> = {},
  ) {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    const utils = render(
      <CancelLabelDialog
        open={true}
        onOpenChange={onOpenChange}
        mode="cancel"
        paid={false}
        amountPaidCents={null}
        onConfirm={onConfirm}
        {...overrides}
      />,
    );
    return { onConfirm, onOpenChange, ...utils };
  }

  it("renders the cancel title and destructive confirm label", () => {
    renderOpen({ mode: "cancel" });
    expect(screen.getByText("Cancel this label?")).toBeTruthy();
    expect(screen.getByText("Yes, cancel")).toBeTruthy();
    expect(screen.getByText("Keep label")).toBeTruthy();
  });

  it("renders the change title and primary confirm label", () => {
    renderOpen({ mode: "change" });
    expect(screen.getByText("Change package details?")).toBeTruthy();
    expect(screen.getByText("Yes, start over")).toBeTruthy();
  });

  it("shows 'no charge was made' copy when paid=false", () => {
    renderOpen({ paid: false, amountPaidCents: null });
    expect(screen.getByText(/no charge was made/i)).toBeTruthy();
  });

  it("formats the refund amount when paid=true with cents", () => {
    renderOpen({ paid: true, amountPaidCents: 587 });
    expect(screen.getByText(/\$5\.87/)).toBeTruthy();
  });

  it("shows the generic refund copy when paid=true but amount unknown", () => {
    renderOpen({ paid: true, amountPaidCents: null });
    expect(screen.getByText(/refund the charge/i)).toBeTruthy();
  });

  it("calls onConfirm exactly once when confirm is clicked", async () => {
    const { onConfirm } = renderOpen({ mode: "cancel" });
    fireEvent.click(screen.getByText("Yes, cancel"));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  it("does not call onConfirm when 'Keep label' is clicked", () => {
    const { onConfirm, onOpenChange } = renderOpen();
    fireEvent.click(screen.getByText("Keep label"));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
