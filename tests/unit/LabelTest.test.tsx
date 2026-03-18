import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LabelTest from "@/pages/LabelTest";

// ─── Helpers ─────────────────────────────────────────────────

/** Mock a successful autocomplete API call returning one prediction */
function mockAutocomplete(predictions = [
    {
        description: "925 W Dean Rd, Milwaukee, WI 53217, USA",
        place_id: "test-place-id",
        main_text: "925 W Dean Rd",
        secondary_text: "Milwaukee, WI 53217",
    },
]) {
    return vi.fn().mockImplementation((url: string) => {
        if (url.includes("/autocomplete")) {
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ predictions }),
            });
        }
        // All other fetches (addresses, etc.) return generic failure
        return Promise.resolve({
            ok: false,
            status: 400,
            json: () => Promise.resolve({ error: "Test error" }),
        });
    });
}

// ─── Tests ───────────────────────────────────────────────────

describe("LabelTest page", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("renders the Addresses step with single address fields", () => {
        render(<LabelTest />);
        expect(screen.getByText("Label Test")).toBeInTheDocument();
        expect(screen.getByText("Addresses")).toBeInTheDocument();

        // New single-field UI: Name + Address (no separate Street/City/State/Zip)
        const nameInputs = screen.getAllByPlaceholderText("Full Name");
        expect(nameInputs).toHaveLength(2); // FROM and TO

        const addressInputs = screen.getAllByPlaceholderText("Start typing your address…");
        expect(addressInputs).toHaveLength(2); // FROM and TO

        // Old multi-field selectors should NOT be present
        expect(screen.queryByLabelText(/Street/i)).not.toBeInTheDocument();
        expect(screen.queryByLabelText(/City/i)).not.toBeInTheDocument();
        expect(screen.queryByLabelText(/State/i)).not.toBeInTheDocument();
    });

    it("shows autocomplete dropdown when typing in address field", async () => {
        const fetchMock = mockAutocomplete();
        global.fetch = fetchMock;

        const user = userEvent.setup();
        render(<LabelTest />);

        const [fromAddress] = screen.getAllByPlaceholderText("Start typing your address…");
        await user.click(fromAddress);
        await user.type(fromAddress, "925 dean");

        // Wait for debounce + fetch
        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith(
                expect.stringContaining("/autocomplete"),
                expect.any(Object),
            );
        }, { timeout: 1000 });

        // Dropdown suggestion should appear
        await waitFor(() => {
            expect(screen.getByText("925 W Dean Rd")).toBeInTheDocument();
        }, { timeout: 1000 });

        expect(screen.getByText("Milwaukee, WI 53217")).toBeInTheDocument();
        expect(screen.getByText("Powered by Google")).toBeInTheDocument();
    });

    it("shows Verified badge after selecting a suggestion", async () => {
        const fetchMock = mockAutocomplete();
        global.fetch = fetchMock;

        const user = userEvent.setup();
        render(<LabelTest />);

        const [fromAddress] = screen.getAllByPlaceholderText("Start typing your address…");
        await user.click(fromAddress);
        await user.type(fromAddress, "925 dean");

        // Wait for suggestion to appear
        await waitFor(() => expect(screen.getByText("925 W Dean Rd")).toBeInTheDocument(), { timeout: 1000 });

        // Click the suggestion
        await user.click(screen.getByText("925 W Dean Rd"));

        // Verified badge should now appear
        await waitFor(() => expect(screen.getByText("Verified")).toBeInTheDocument());

        // The address should resolve to one-liner
        expect(screen.getByText(/925 W Dean Rd/)).toBeInTheDocument();
    });

    it("blocks Get Rates if address not selected from dropdown", async () => {
        // No autocomplete fetch needed — just test the client gate
        global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({}) });

        const user = userEvent.setup();
        render(<LabelTest />);

        // Click Get Rates without selecting from dropdown
        const getRatesButton = screen.getByRole("button", { name: /Get Rates/i });
        await user.click(getRatesButton);

        // Inline error should appear
        await waitFor(() => {
            expect(screen.getAllByText(/select an address from the dropdown/i).length).toBeGreaterThan(0);
        });

        // fetch should NOT have been called for /addresses (client blocked it)
        const fetchCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
        const addressCalls = fetchCalls.filter((call: unknown[]) => (call[0] as string)?.includes?.("/addresses"));
        expect(addressCalls).toHaveLength(0);
    });

    it("pre-fills test data with verified=true so Get Rates proceeds", async () => {
        global.fetch = vi.fn().mockImplementation(() =>
            Promise.resolve({
                ok: true,
                json: () => Promise.resolve({
                    from_id: "adr_from",
                    to_id: "adr_to",
                    from_address: {},
                    to_address: {},
                }),
            })
        );

        const user = userEvent.setup();
        render(<LabelTest />);

        const prefillButton = screen.getByRole("button", { name: /Pre-fill Test Data/i });
        await user.click(prefillButton);

        // Verified badges should be visible for both FROM and TO
        const verifiedBadges = await screen.findAllByText("Verified");
        expect(verifiedBadges).toHaveLength(2);

        // Get Rates should proceed to call /addresses (not blocked client-side)
        const getRatesButton = screen.getByRole("button", { name: /Get Rates/i });
        await user.click(getRatesButton);

        await waitFor(() => {
            const addressCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
                .filter((call: unknown[]) => (call[0] as string)?.includes?.("/addresses"));
            expect(addressCalls).toHaveLength(1);
        });
    });

    it("shows error banner when address API call fails", async () => {
        const fetchMock = vi.fn().mockImplementation((url: string) => {
            if (url.includes("/addresses")) {
                return Promise.resolve({
                    ok: false,
                    status: 400,
                    json: () => Promise.resolve({ error: "Address not found" }),
                });
            }
            return Promise.resolve({ ok: true, json: async () => ({ predictions: [] }) });
        });
        global.fetch = fetchMock;

        const user = userEvent.setup();
        render(<LabelTest />);

        // Prefill first (so addresses are verified and Get Rates is not client-blocked)
        const prefillButton = screen.getByRole("button", { name: /Pre-fill Test Data/i });
        await user.click(prefillButton);

        const getRatesButton = screen.getByRole("button", { name: /Get Rates/i });
        await user.click(getRatesButton);

        // Should show error containing "Address not found"
        expect(await screen.findByText(/Address not found.*Session ID/i)).toBeInTheDocument();
    });
});
