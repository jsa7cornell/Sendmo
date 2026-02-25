import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LabelTest from "@/pages/LabelTest";

describe("LabelTest page", () => {
    it("renders the initial Addresses step", () => {
        render(<LabelTest />);
        expect(screen.getByText("Label Test")).toBeInTheDocument();
        expect(screen.getByText("Addresses")).toBeInTheDocument();

        // Check for From fields
        expect(screen.getByLabelText(/Name/i, { selector: "#From-name" })).toBeInTheDocument();
        expect(screen.getByLabelText(/Street/i, { selector: "#From-street" })).toBeInTheDocument();

        // Check for To fields
        expect(screen.getByLabelText(/Name/i, { selector: "#To-name" })).toBeInTheDocument();
        expect(screen.getByLabelText(/Street/i, { selector: "#To-street" })).toBeInTheDocument();
    });

    it("allows typing into the address fields without losing focus (regression test)", async () => {
        const user = userEvent.setup();
        render(<LabelTest />);

        const fromNameInput = screen.getByLabelText(/Name/i, { selector: "#From-name" });

        // Simulate typing character by character
        await user.click(fromNameInput);
        await user.keyboard("J");
        await user.keyboard("o");
        await user.keyboard("h");
        await user.keyboard("n");

        // Assert the value is correct
        expect(fromNameInput).toHaveValue("John");

        // Assert the input STILL has focus (this fails if the component unmounts mid-typing)
        expect(fromNameInput).toHaveFocus();
    });

    it("pre-fills test data when clicking the button", async () => {
        const user = userEvent.setup();
        render(<LabelTest />);

        const prefillButton = screen.getByRole("button", { name: /Pre-fill Test Data/i });
        await user.click(prefillButton);

        expect(screen.getByLabelText(/Name/i, { selector: "#From-name" })).toHaveValue("SendMo HQ");
        expect(screen.getByLabelText(/Street/i, { selector: "#From-street" })).toHaveValue("388 Townsend St");
        expect(screen.getByLabelText(/Name/i, { selector: "#To-name" })).toHaveValue("Jane Doe");
    });

    it("shows error banner when API call fails", async () => {
        // Mock global fetch to return a failed response
        global.fetch = vi.fn().mockImplementation(() =>
            Promise.resolve({
                ok: false,
                status: 400,
                json: () => Promise.resolve({ error: "Invalid address" }),
            })
        );

        const user = userEvent.setup();
        render(<LabelTest />);

        // Need standard address fields filled partially, won't matter since we mocekd fetch
        const getRatesButton = screen.getByRole("button", { name: /Get Rates/i });
        await user.click(getRatesButton);

        // Should eventually show the error banner
        expect(await screen.findByText(/Error/i)).toBeInTheDocument();
        expect(await screen.findByText(/Invalid address/i)).toBeInTheDocument();

        // Clean up mock
        vi.restoreAllMocks();
    });
});
