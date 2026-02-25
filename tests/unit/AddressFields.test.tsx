import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AddressFields from "@/components/ui/AddressFields";

// We need a wrapper to give AddressFields context since it might use hooks in the future
// Currently it's just a functional component taking props
describe("AddressFields", () => {
    const mockValue = {
        name: "",
        street: "",
        city: "",
        state: "",
        zip: "",
    };

    it("renders all 5 input fields", () => {
        render(<AddressFields label="Shipping" value={mockValue} onChange={vi.fn()} />);

        expect(screen.getByText("Shipping")).toBeInTheDocument();
        expect(screen.getByLabelText(/Name/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/Street/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/City/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/State/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/Zip/i)).toBeInTheDocument();
    });

    it("calls onChange when typing", async () => {
        const onChangeMock = vi.fn();
        const user = userEvent.setup();

        render(<AddressFields label="Shipping" value={mockValue} onChange={onChangeMock} />);

        await user.type(screen.getByLabelText(/Name/i), "A");

        // Assert onChange was called with the updated object
        expect(onChangeMock).toHaveBeenCalledWith({ ...mockValue, name: "A" });
    });
});
