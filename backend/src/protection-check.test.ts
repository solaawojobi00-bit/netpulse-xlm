import { describe, expect, it } from "vitest";

/*
 * THROWAWAY — DO NOT MERGE.
 *
 * Deliberately failing test used once to confirm that branch protection on
 * main actually blocks a pull request whose required checks fail, rather than
 * trusting the settings page. This file and its branch are deleted as soon as
 * the block is observed.
 */
describe("branch protection verification", () => {
  it("fails on purpose so the Backend Type-Check & Tests check reports failure", () => {
    expect("this check must fail").toBe("so the PR is blocked from merging");
  });
});
