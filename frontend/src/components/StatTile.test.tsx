import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatTile } from "./StatTile";

describe("StatTile", () => {
  it("renders loading skeletons when loading is true", () => {
    const { container } = render(
      <StatTile label="Base fee" value="100 stroops" loading={true} />,
    );

    expect(screen.getByText("Base fee")).toBeInTheDocument();
    expect(screen.getByLabelText("Loading...")).toBeInTheDocument();
    expect(screen.queryByText("100 stroops")).not.toBeInTheDocument();
    expect(container.querySelector(".stat-tile--loading")).toBeInTheDocument();
  });

  it("renders em-dash for null value once loaded", () => {
    render(<StatTile label="Ledger close time" value={null} />);

    expect(screen.getByText("Ledger close time")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("renders given value and optional sublabel", () => {
    render(
      <StatTile
        label="Ledger close time"
        value="5.2s"
        sublabel="avg 5.0s"
      />,
    );

    expect(screen.getByText("Ledger close time")).toBeInTheDocument();
    expect(screen.getByText("5.2s")).toBeInTheDocument();
    expect(screen.getByText("avg 5.0s")).toBeInTheDocument();
  });

  it("applies the appropriate tone variant class", () => {
    const { container: goodContainer } = render(
      <StatTile label="Congestion" value="Low" tone="good" />,
    );
    expect(goodContainer.querySelector(".stat-tile--good")).toBeInTheDocument();

    const { container: warnContainer } = render(
      <StatTile label="Congestion" value="Medium" tone="warn" />,
    );
    expect(warnContainer.querySelector(".stat-tile--warn")).toBeInTheDocument();

    const { container: badContainer } = render(
      <StatTile label="Congestion" value="High" tone="bad" />,
    );
    expect(badContainer.querySelector(".stat-tile--bad")).toBeInTheDocument();
  });
});
