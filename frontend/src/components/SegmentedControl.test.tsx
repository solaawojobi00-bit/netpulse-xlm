import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SegmentedControl } from "./SegmentedControl";

const OPTIONS = [
  { value: "6h" as const, label: "6h" },
  { value: "12h" as const, label: "12h" },
  { value: "24h" as const, label: "24h" },
];

describe("SegmentedControl", () => {
  it("exposes the selected option through aria-pressed, not colour alone", () => {
    render(
      <SegmentedControl
        label="History time range"
        options={OPTIONS}
        value="12h"
        onChange={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: "6h" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "12h" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "24h" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("names the group so the buttons are not three bare options", () => {
    render(
      <SegmentedControl
        label="History time range"
        options={OPTIONS}
        value="24h"
        onChange={() => {}}
      />,
    );

    expect(screen.getByRole("group", { name: "History time range" })).toBeInTheDocument();
  });

  it("reports the chosen value on click", async () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl label="Range" options={OPTIONS} value="24h" onChange={onChange} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "6h" }));

    expect(onChange).toHaveBeenCalledWith("6h");
  });

  it("is operable by keyboard alone, with both Enter and Space", async () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl label="Range" options={OPTIONS} value="24h" onChange={onChange} />,
    );

    // Tab in from the top rather than calling focus(), so this fails if the
    // buttons ever stop being reachable.
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "6h" })).toHaveFocus();

    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("6h");

    await userEvent.tab();
    await userEvent.keyboard(" ");
    expect(onChange).toHaveBeenCalledWith("12h");
  });
});
