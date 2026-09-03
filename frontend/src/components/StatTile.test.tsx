import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatTile } from "./StatTile";

describe("StatTile", () => {
  it("renders loading skeletons when loading is true", () => {
    const { container } = render(
      <StatTile label="Base fee" value="100 stroops" status="loading" />,
    );

    expect(screen.getByText("Base fee")).toBeInTheDocument();
    /*
     * Queried by role, not by label alone. The previous assertion was
     * `getByLabelText("Loading...")` against a bare <div aria-label>, which
     * testing-library resolves happily but screen readers ignore — an element
     * with no role cannot take an accessible name, so that skeleton announced
     * nothing. Asserting the role is what makes the name real.
     */
    expect(screen.getByRole("status")).toHaveAccessibleName("Base fee: loading");
    expect(screen.queryByText("100 stroops")).not.toBeInTheDocument();
    expect(container.querySelector(".stat-tile--loading")).toBeInTheDocument();
  });

  it("renders the congestion band as a chip with a non-colour glyph", () => {
    render(<StatTile label="Network congestion" value="88%" band="high" tone="bad" />);

    // The word carries the meaning; the glyph is a redundant shape cue so the
    // severity does not depend on the chip's colour.
    const chip = screen.getByText("high");
    expect(chip).toHaveClass("stat-tile__band");
    expect(chip.querySelector('[aria-hidden="true"]')).toHaveTextContent("■");
  });

  it("hides the band while loading rather than showing a stale severity", () => {
    render(<StatTile label="Network congestion" value={null} band="high" tone="bad" status="loading" />);

    expect(screen.queryByText("high")).not.toBeInTheDocument();
  });

  it("says the value is unavailable instead of pulsing forever", () => {
    const { container } = render(
      <StatTile label="Base fee" value="100 stroops" status="error" />,
    );

    // The defect this replaces: an indefinite skeleton animation promising
    // data was about to arrive at exactly the moment it was not.
    expect(container.querySelector(".stat-tile__skeleton")).not.toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByText("100 stroops")).not.toBeInTheDocument();
  });

  it("announces the failure politely, naming which tile it is", () => {
    render(<StatTile label="Base fee" value={null} status="error" />);

    const region = screen.getByRole("status");
    expect(region).toHaveAccessibleName("Base fee: unavailable");
    // One outage puts this on all five tiles; assertive would interrupt five
    // times for a single cause.
    expect(region).not.toHaveAttribute("aria-live", "assertive");
  });

  it("keeps showing a value that already arrived, even while erroring", () => {
    // resolveValueStatus never yields "error" while data exists, but the tile
    // must not blank the value if a caller ever passes "ready" with an error.
    render(<StatTile label="Base fee" value="100 stroops" status="ready" />);

    expect(screen.getByText("100 stroops")).toBeInTheDocument();
    expect(screen.queryByText("Unavailable")).not.toBeInTheDocument();
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
