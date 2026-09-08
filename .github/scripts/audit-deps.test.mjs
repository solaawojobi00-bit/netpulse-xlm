// Regression tests for audit-deps.mjs.
//
// The script under test decides whether an `npm audit` failure blocks CI. To do
// that it has to tell apart two things npm reports with the same exit code: a
// real advisory, and the registry never answering. Getting that wrong in the
// fail-open direction turns a security gate into a green light that checks
// nothing, and it has happened once already -- an early version treated *any*
// npm error code as an outage, which would have downgraded ENOLOCK (missing
// lockfile) to a warning and passed the gate while auditing zero packages.
//
// So the three cases that must fail loudly -- ENOLOCK, EUSAGE and an
// unrecognised payload -- are the reason this file exists. The rest of the
// matrix guards the classification around them.
//
// Mechanism: a stub `npm` is placed on PATH that prints a fixture file named by
// $STUB_FIXTURE and exits with $STUB_EXIT. No network is touched, and every
// branch is reachable on demand. On Windows the stub must be `npm.cmd`, because
// audit-deps.mjs spawns with `shell: true` there and cmd resolves via PATHEXT.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(here, "audit-deps.mjs");
const FIXTURES = resolve(here, "test-fixtures");

/*
 * One temp tree for the whole file: a `bin/` holding the npm stub, and a
 * `workspace/` holding the package.json the script requires before it will run.
 * The workspace contents are irrelevant -- the stub answers instead of npm --
 * but the existsSync guard in audit-deps.mjs runs first.
 */
const root = mkdtempSync(join(tmpdir(), "audit-deps-test-"));
const bin = join(root, "bin");
const workspace = join(root, "workspace");
mkdirSync(bin);
mkdirSync(workspace);
writeFileSync(
  join(workspace, "package.json"),
  JSON.stringify({ name: "stub-workspace", version: "0.0.0" }),
);

/*
 * The stub ignores every argument it is given. That is deliberate: these tests
 * assert on how the script *classifies npm's output*, not on the flags it
 * passes, so the stub stays trivial and the fixtures carry all the variation.
 */
writeFileSync(
  join(bin, "npm"),
  `#!/bin/sh\ncat "$STUB_FIXTURE"\nexit "\${STUB_EXIT:-1}"\n`,
);
chmodSync(join(bin, "npm"), 0o755);

writeFileSync(
  join(bin, "npm.cmd"),
  ["@echo off", "type %STUB_FIXTURE%", "exit /b %STUB_EXIT%", ""].join("\r\n"),
);

after(() => {
  // Best effort; the OS reclaims tmpdir anyway and a failure here must not
  // turn a passing suite red.
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function runGate(fixture, { exit = "1" } = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, "workspace"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      STUB_FIXTURE: join(FIXTURES, fixture),
      STUB_EXIT: exit,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    combined: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

describe("audit-deps.mjs: a real report is graded", () => {
  it("passes a clean report", () => {
    const r = runGate("clean.json", { exit: "0" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /found 0 vulnerabilities/);
  });

  it("fails on a high advisory and names the package and range", () => {
    const r = runGate("high-and-low.json");
    assert.equal(r.status, 1);
    // The summary counts both, ...
    assert.match(r.stdout, /found 1 low, 1 high/);
    // ... but only the blocking one is itemised, with something actionable.
    assert.match(r.stdout, /high: tar-fs >=2\.0\.0 <2\.1\.3/);
    assert.match(r.stdout, /GHSA-pq67-2wwv-3xjx/);
    assert.doesNotMatch(r.stdout, /low: cookie/);
    assert.match(r.stderr, /::error::.*1 high\/critical severity/);
  });

  it("reports a moderate advisory without blocking", () => {
    const r = runGate("moderate-only.json");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /found 2 moderate/);
    assert.doesNotMatch(r.stderr, /::error::/);
  });
});

describe("audit-deps.mjs: an unreachable registry warns but does not block", () => {
  it("treats npm 11's raw HTTP failure as an outage", () => {
    const r = runGate("http-503.json");
    assert.equal(r.status, 0);
    assert.match(r.combined, /::warning::/);
    assert.match(r.combined, /retrying, attempt 2 of 2/);
    assert.match(r.combined, /registry outage, not a clean bill of health/);
  });

  it("treats a bare timeout message as an outage", () => {
    // Regression guard for a specific trap the script documents: this shape
    // carries `message` but no `statusCode`, so keying on statusCode alone
    // would hard-fail every timeout.
    const r = runGate("timeout-message-only.json");
    assert.equal(r.status, 0);
    assert.match(r.combined, /ETIMEDOUT/);
    assert.match(r.combined, /registry outage, not a clean bill of health/);
  });

  it("treats npm 10's ENOAUDIT as an outage", () => {
    const r = runGate("enoaudit.json");
    assert.equal(r.status, 0);
    assert.match(r.combined, /ENOAUDIT/);
    assert.match(r.combined, /registry outage, not a clean bill of health/);
  });
});

/*
 * The regression-critical group. Each of these is a way for the toolchain to be
 * broken rather than the registry to be down, and every one of them must fail
 * the build. If any of these ever starts exiting 0, the gate has silently
 * stopped gating -- which is the failure mode that motivated this file.
 */
describe("audit-deps.mjs: a broken run fails loudly and never fails open", () => {
  it("fails on ENOLOCK rather than treating a missing lockfile as an outage", () => {
    const r = runGate("enolock.json");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /::error::/);
    assert.match(r.stderr, /ENOLOCK/);
    // Must not be misreported as a registry problem.
    assert.doesNotMatch(r.combined, /registry outage/);
  });

  it("fails on EUSAGE rather than treating a bad invocation as an outage", () => {
    const r = runGate("eusage.json");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /::error::/);
    assert.match(r.stderr, /EUSAGE/);
    assert.doesNotMatch(r.combined, /registry outage/);
  });

  it("fails on an unrecognised payload", () => {
    const r = runGate("unrecognised.json");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /::error::/);
    assert.match(r.stderr, /unrecognised npm audit output/);
    assert.doesNotMatch(r.combined, /registry outage/);
  });

  it("fails when npm prints something that is not JSON at all", () => {
    const r = runGate("not-json.txt");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /::error::/);
    assert.match(r.stderr, /no readable JSON/);
    assert.doesNotMatch(r.combined, /registry outage/);
  });
});

describe("audit-deps.mjs: argument handling", () => {
  it("exits 2 without a workspace argument", () => {
    const r = spawnSync(process.execPath, [SCRIPT], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage: audit-deps\.mjs/);
  });

  it("exits 2 when the workspace has no package.json", () => {
    const r = spawnSync(process.execPath, [SCRIPT, "does-not-exist"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no package\.json in/);
  });
});
