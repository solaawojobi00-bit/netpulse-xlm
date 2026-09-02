import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

function Boom({ message = "chart exploded" }: { message?: string }): JSX.Element {
  throw new Error(message);
}

// React logs caught render errors to console.error; silence it so the suite
// output stays readable, while still asserting our own log happened.
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe("ErrorBoundary", () => {
  it("renders children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>dashboard content</p>
      </ErrorBoundary>,
    );

    expect(screen.getByText("dashboard content")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders the fallback instead of unmounting the tree when a child throws", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toBeInTheDocument();
    expect(
      screen.getByText(/something went wrong displaying this data/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reload page/i })).toBeInTheDocument();
  });

  it("surfaces the underlying error message in the fallback", () => {
    render(
      <ErrorBoundary>
        <Boom message="Cannot read properties of null (reading 'band')" />
      </ErrorBoundary>,
    );

    expect(
      screen.getByText("Cannot read properties of null (reading 'band')"),
    ).toBeInTheDocument();
  });

  it("logs the caught error so it stays debuggable", () => {
    render(
      <ErrorBoundary>
        <Boom message="boom" />
      </ErrorBoundary>,
    );

    expect(errorSpy).toHaveBeenCalledWith(
      "Dashboard render failed:",
      expect.objectContaining({ message: "boom" }),
      expect.anything(),
    );
  });

  it("recovers and renders children again when Try again is clicked", () => {
    let shouldThrow = true;
    function Flaky() {
      if (shouldThrow) throw new Error("transient bad data");
      return <p>recovered content</p>;
    }

    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(screen.getByText("recovered content")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("calls onReset so callers can clear the state that caused the failure", () => {
    const onReset = vi.fn();
    render(
      <ErrorBoundary onReset={onReset}>
        <Boom />
      </ErrorBoundary>,
    );

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("keeps showing the fallback when Try again does not fix the cause", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
