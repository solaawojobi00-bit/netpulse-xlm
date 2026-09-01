import { describe, expect, it } from "vitest";
import { congestionBand } from "./metrics.js";

describe("congestionBand", () => {
  it("returns 'unknown' for null input", () => {
    expect(congestionBand(null)).toBe("unknown");
  });

  it("returns 'low' for values just under 0.5", () => {
    expect(congestionBand(0)).toBe("low");
    expect(congestionBand(0.499)).toBe("low");
  });

  it("returns 'moderate' for values at and just over 0.5", () => {
    expect(congestionBand(0.5)).toBe("moderate");
    expect(congestionBand(0.501)).toBe("moderate");
  });

  it("returns 'moderate' for values just under 0.8", () => {
    expect(congestionBand(0.799)).toBe("moderate");
  });

  it("returns 'high' for values at and over 0.8", () => {
    expect(congestionBand(0.8)).toBe("high");
    expect(congestionBand(0.801)).toBe("high");
    expect(congestionBand(1.0)).toBe("high");
  });

  it("respects a custom high threshold", () => {
    expect(congestionBand(0.65, 0.7)).toBe("moderate");
    expect(congestionBand(0.7, 0.7)).toBe("high");
    expect(congestionBand(0.75, 0.7)).toBe("high");
  });
});
