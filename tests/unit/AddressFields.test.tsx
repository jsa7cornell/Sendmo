import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AddressFields from "@/components/ui/AddressFields";

/**
 * AddressFields is now a thin wrapper around SmartAddressInput.
 * It renders a single "Address" search field (not separate Street/City/State/Zip).
 */
describe("AddressFields", () => {
    const mockValue = {
        name: "",
        street: "",
        city: "",
        state: "",
        zip: "",
        verified: false,
    };

    it("renders Name and single Address field (not multi-field form)", () => {
        render(<AddressFields label="Shipping" value={mockValue} onChange={vi.fn()} />);

        // Name field
        expect(screen.getByPlaceholderText("Full Name")).toBeInTheDocument();

        // Single address field
        expect(screen.getByPlaceholderText("Start typing your address…")).toBeInTheDocument();

        // Old multi-field labels must NOT be present
        expect(screen.queryByLabelText(/Street/i)).not.toBeInTheDocument();
        expect(screen.queryByLabelText(/City/i)).not.toBeInTheDocument();
        expect(screen.queryByLabelText(/State/i)).not.toBeInTheDocument();
        expect(screen.queryByLabelText(/Zip/i)).not.toBeInTheDocument();
    });

    it("calls onChange with updated name when typing in Name field", async () => {
        const onChangeMock = vi.fn();
        const user = userEvent.setup();

        render(<AddressFields label="Shipping" value={mockValue} onChange={onChangeMock} />);

        await user.type(screen.getByPlaceholderText("Full Name"), "A");

        expect(onChangeMock).toHaveBeenCalledWith(
            expect.objectContaining({ name: "A" })
        );
    });

    it("shows Verified badge when value has verified=true and street set", () => {
        const verifiedValue = {
            name: "Jane Doe",
            street: "388 Townsend St",
            city: "San Francisco",
            state: "CA",
            zip: "94107",
            verified: true,
        };
        render(<AddressFields label="Shipping" value={verifiedValue} onChange={vi.fn()} />);

        expect(screen.getByText("Verified")).toBeInTheDocument();
        expect(screen.queryByPlaceholderText("Start typing your address…")).not.toBeInTheDocument();
    });
});
