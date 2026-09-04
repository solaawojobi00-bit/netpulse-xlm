#!/usr/bin/env node
// Dependency audit gate for CI.
//
// `npm audit` exits 1 for two unrelated reasons: it found an advisory, or it
// could not reach the registry's audit endpoint. The second happens often
// enough that a bare `npm audit` step trains everyone to retrigger CI instead
// of reading it, which defeats the point of having the gate at all.
//
// `--json` tells the two apart. A real audit report carries counts under
// `metadata.vulnerabilities`; when the endpoint fails, npm prints the raw HTTP
// failure instead (`{ message, uri, statusCode, ... }`, or `{ error: { code:
// "ENOAUDIT" } }` on npm 10 and older). So: fail the build on a high or
// critical advisory, and warn without failing when npm never got an answer.
//
// Usage: node .github/scripts/audit-deps.mjs <workspace-dir> [extra npm args]
//   e.g. node .github/scripts/audit-deps.mjs frontend --omit=dev

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Fail on these; anything lower is reported but does not block. Mirrors the
// `--audit-level=high` this script replaced.
const BLOCKING_SEVERITIES = ["high", "critical"];

const ATTEMPTS = 2;
const RETRY_DELAY_MS = 10_000;

/*
 * Ceiling on a single npm audit request. The whole step is therefore bounded
 * at roughly ATTEMPTS * FETCH_TIMEOUT_MS + RETRY_DELAY_MS, about 70s, versus
 * the 9-11 minutes the unbounded default produced against a dead endpoint.
 */
const FETCH_TIMEOUT_MS = 30_000;

const [workspace, ...extraArgs] = process.argv.slice(2);

if (!workspace) {
  console.error("usage: audit-deps.mjs <workspace-dir> [extra npm args]");
  process.exit(2);
}

const cwd = resolve(process.cwd(), workspace);

if (!existsSync(resolve(cwd, "package.json"))) {
  console.error(`no package.json in ${cwd}`);
  process.exit(2);
}

// GitHub Actions renders these as annotations; they are plain text elsewhere.
const warn = (message) => console.log(`::warning::${message}`);

// Three outcomes, and keeping them apart is the whole point of this script:
//   { report }      npm answered; grade it
//   { unavailable } npm ran but got no report from the registry; warn only
//   { fatal }       npm did not run, or said something we cannot read; fail
// Collapsing `fatal` into `unavailable` would let a broken toolchain quietly
// pass the gate, which is worse than a red build.
function runAudit() {
  const result = spawnSync(
    "npm",
    [
      "audit",
      "--json",
      /*
       * Bound how long one attempt can take. Two separate npm settings matter
       * here, and capping only the second is a trap:
       *
       *   fetch-timeout   how long a single request may hang. Defaults to
       *                   300000 (5 min), which is the setting that actually
       *                   produced the multi-minute jobs, because a dead
       *                   endpoint times out rather than answering.
       *   fetch-retries   how many times npm retries internally, with its own
       *                   backoff on top of the above.
       *
       * Retrying is this script's job, not npm's, so npm gets one shot with a
       * short leash and the retry lives in the loop below where it is visible.
       * Worst case per attempt is FETCH_TIMEOUT_MS.
       */
      "--fetch-retries=0",
      `--fetch-timeout=${FETCH_TIMEOUT_MS}`,
      ...extraArgs,
    ],
    {
      cwd,
      encoding: "utf8",
      // npm is a .cmd shim on Windows, which Node refuses to spawn directly.
      // CI is Linux; this is so the script can be run locally too.
      shell: process.platform === "win32",
    },
  );

  if (result.error) {
    return { fatal: `could not run npm: ${result.error.message}` };
  }

  // npm prints the JSON report on stdout and its own log lines on stderr.
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    return {
      fatal:
        `npm audit produced no readable JSON (exit ${result.status})\n` +
        `${result.stdout}\n${result.stderr}`,
    };
  }

  // A real report always carries severity counts. Anything else is npm
  // telling us it never got one.
  if (report.metadata?.vulnerabilities) {
    return { report };
  }

  /*
   * Classify what npm gave us instead of a report. The discriminator is
   * `error.code`, because npm's own CLI failures always carry one while a
   * failed audit *request* does not:
   *
   *   ENOAUDIT              npm 10's code for "the endpoint did not answer"
   *   any other code        a real problem with this run -- ENOLOCK for a
   *                         missing lockfile, EUSAGE for a bad invocation --
   *                         which must fail. Treating these as outages is how
   *                         a gate silently stops gating.
   *   no code, but a
   *   top-level `message`   npm 11's raw transport failure. Comes in two
   *                         sub-shapes and both must be caught: an HTTP error
   *                         carries statusCode/uri/body, while a timeout
   *                         carries only `message`. Keying on statusCode
   *                         alone would hard-fail every timeout.
   */
  const code = report.error?.code;

  if (code === "ENOAUDIT") {
    return { unavailable: `ENOAUDIT: ${report.error.summary ?? ""}`.trim() };
  }

  if (code) {
    return {
      fatal: `npm audit failed with ${code}: ${report.error.summary ?? ""}`.trim(),
    };
  }

  if (typeof report.message === "string" && report.message.length > 0) {
    return { unavailable: report.message };
  }

  return {
    fatal:
      `unrecognised npm audit output (exit ${result.status})\n` +
      `${result.stdout}\n${result.stderr}`,
  };
}

let audit = runAudit();

for (let attempt = 2; audit.unavailable && attempt <= ATTEMPTS; attempt++) {
  warn(
    `npm audit could not reach the registry (${audit.unavailable}); ` +
      `retrying, attempt ${attempt} of ${ATTEMPTS}`,
  );
  // Deliberately synchronous: this is a sequential CI step, and blocking here
  // keeps the control flow readable.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_DELAY_MS);
  audit = runAudit();
}

if (audit.fatal) {
  console.error(`::error::Dependency audit for ${workspace} failed: ${audit.fatal}`);
  process.exit(1);
}

if (audit.unavailable) {
  warn(
    `Skipping dependency audit for ${workspace}: npm audit endpoint ` +
      `unavailable after ${ATTEMPTS} attempts (${audit.unavailable}). ` +
      `This is a registry outage, not a clean bill of health.`,
  );
  process.exit(0);
}

const counts = audit.report.metadata?.vulnerabilities ?? {};
const blocking = BLOCKING_SEVERITIES.reduce(
  (total, severity) => total + (counts[severity] ?? 0),
  0,
);

const summary = Object.entries(counts)
  .filter(([, count]) => count > 0)
  .map(([severity, count]) => `${count} ${severity}`)
  .join(", ");

console.log(
  `${workspace}: ${summary ? `found ${summary}` : "found 0 vulnerabilities"}`,
);

if (blocking === 0) {
  process.exit(0);
}

// Name the offending packages so the failure is actionable from the log alone.
for (const [name, advisory] of Object.entries(audit.report.vulnerabilities ?? {})) {
  if (BLOCKING_SEVERITIES.includes(advisory.severity)) {
    const urls = (advisory.via ?? [])
      .filter((via) => typeof via === "object" && via.url)
      .map((via) => via.url);
    console.log(
      `  ${advisory.severity}: ${name} ${advisory.range ?? ""} ${urls.join(" ")}`.trimEnd(),
    );
  }
}

console.error(
  `::error::${workspace} has ${blocking} ${BLOCKING_SEVERITIES.join("/")} ` +
    `severity vulnerabilities; run \`npm audit\` in ${workspace}/ for details`,
);
process.exit(1);
