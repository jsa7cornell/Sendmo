import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import DetailsCard from "../../src/components/tracking/DetailsCard";

const base = {
  public_code: "NEC7J3E",
  tracking_number: "9405500208303118781601",
  carrier: "USPS",
  service: "Ground Advantage",
  item_description: "A pair of running shoes",
  from_city: "San Francisco",
  from_state: "CA",
  to_city: "Brooklyn",
  to_state: "NY",
  created_at: new Date("2026-05-13T20:07:00Z").toISOString(),
  cancelled_at: null as string | null,
  is_test: false,
};

describe("DetailsCard", () => {
  it("renders SendMo ID prominently with branded styling", () => {
    render(<DetailsCard family={1} data={base} />);
    expect(screen.getByText("SendMo ID")).toBeInTheDocument();
    expect(screen.getByText("NEC7J3E")).toBeInTheDocument();
  });

  it("renders Item when item_description is present", () => {
    render(<DetailsCard family={1} data={base} />);
    expect(screen.getByText("Item")).toBeInTheDocument();
    expect(screen.getByText("A pair of running shoes")).toBeInTheDocument();
  });

  it("hides Item row when item_description is null", () => {
    render(<DetailsCard family={1} data={{ ...base, item_description: null }} />);
    expect(screen.queryByText("Item")).toBeNull();
  });

  it("renders From → To when both addresses are present", () => {
    render(<DetailsCard family={1} data={base} />);
    expect(screen.getByText("From → To")).toBeInTheDocument();
    expect(screen.getByText("San Francisco, CA → Brooklyn, NY")).toBeInTheDocument();
  });

  it("hides carrier tracking number on Family 1 (not scanned yet)", () => {
    render(<DetailsCard family={1} data={base} />);
    expect(screen.queryByText("Tracking #")).toBeNull();
    expect(screen.queryByText("9405500208303118781601")).toBeNull();
  });

  it("shows carrier tracking number on Family 2 (actionable)", () => {
    render(<DetailsCard family={2} data={base} />);
    expect(screen.getByText("Tracking #")).toBeInTheDocument();
    expect(screen.getByText("9405500208303118781601")).toBeInTheDocument();
  });

  it("hides carrier tracking number on Family 2 in test mode (synthetic)", () => {
    render(<DetailsCard family={2} data={{ ...base, is_test: true }} />);
    expect(screen.queryByText("Tracking #")).toBeNull();
  });

  it("hides carrier tracking number on Family 3 (dead number post-void)", () => {
    render(<DetailsCard family={3} data={base} />);
    expect(screen.queryByText("Tracking #")).toBeNull();
  });

  it("F1 timestamp label is 'Created'", () => {
    render(<DetailsCard family={1} data={base} />);
    expect(screen.getByText("Created")).toBeInTheDocument();
    expect(screen.queryByText("Shipped")).toBeNull();
  });

  it("F2 timestamp label is 'Shipped'", () => {
    render(<DetailsCard family={2} data={base} />);
    expect(screen.getByText("Shipped")).toBeInTheDocument();
    expect(screen.queryByText("Label created")).toBeNull();
  });

  it("F3 timestamp label is 'Label created' (NEVER 'Shipped' — package never shipped)", () => {
    render(<DetailsCard family={3} data={base} />);
    expect(screen.getByText("Label created")).toBeInTheDocument();
    expect(screen.queryByText("Shipped")).toBeNull();
  });
});
