import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThemeToggle } from "./ThemeToggle";

describe("ThemeToggle", () => {
  it("advertises switching to light while in dark theme", () => {
    render(<ThemeToggle theme="dark" onToggle={() => {}} />);

    expect(screen.getByRole("button", { name: /switch to light theme/i })).toBeInTheDocument();
  });

  it("advertises switching to dark while in light theme", () => {
    render(<ThemeToggle theme="light" onToggle={() => {}} />);

    expect(screen.getByRole("button", { name: /switch to dark theme/i })).toBeInTheDocument();
  });

  it("calls onToggle when clicked", () => {
    const onToggle = vi.fn();
    render(<ThemeToggle theme="dark" onToggle={onToggle} />);

    screen.getByRole("button").click();

    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
