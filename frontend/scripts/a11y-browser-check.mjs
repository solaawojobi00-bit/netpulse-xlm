/*
 * Real-browser accessibility verification for issue #42.
 *
 * The vitest suite runs axe under jsdom, which cannot compute cascaded colours
 * — so it skips the contrast rule entirely. This runs the same axe build in
 * Chromium against the real stylesheet, which does resolve custom properties,
 * and adds the two things a unit test cannot do at all: a keyboard-only tab
 * pass, and screenshots at the breakpoints the issue names.
 *
 * The backend is not needed. Every /api call is fulfilled from the fixtures
 * below, and the WebSocket is left to fail so the app falls back to polling.
 *
 * Playwright is deliberately not a devDependency — it and its browsers would
 * add minutes to every CI install for a check that is run by hand when the UI
 * changes. `scripts/contrast-audit.mjs` is the one wired into CI, because it
 * is plain Node with no dependencies at all.
 *
 * Usage:
 *   npm run build
 *   npm install --no-save playwright && npx playwright install chromium
 *   node scripts/a11y-browser-check.mjs
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
const shots = join(here, "..", "a11y-shots");

if (!existsSync(dist)) {
  console.error("dist/ not found — run `npm run build` first.");
  process.exit(1);
}
mkdirSync(shots, { recursive: true });

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};

const server = createServer((req, res) => {
  const path = req.url.split("?")[0];
  const file = join(dist, path === "/" ? "index.html" : path);
  const target = existsSync(file) ? file : join(dist, "index.html");
  res.writeHead(200, { "Content-Type": MIME[extname(target)] ?? "text/plain" });
  res.end(readFileSync(target));
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const now = Date.now();
const iso = (offsetMin) => new Date(now - offsetMin * 60_000).toISOString();

const health = {
  status: "ok",
  lastUpdated: iso(0),
  secondsSinceLastUpdate: 3,
  horizonUrl: "https://horizon.stellar.org",
  ledgerCloseTime: { currentSeconds: 5.2, averageSeconds: 5.4 },
  fees: { baseFeeStroops: 100, p10: 100, p50: 120, p90: 900, p99: 5000 },
  // "high" so the congestion banner and the bad-tone band chip both render.
  congestion: { ledgerCapacityUsage: 0.88, band: "high", alertThreshold: 0.75 },
  throughput: { operationsPerSecond: 42.5, transactionsPerSecond: 12.1 },
  recentLedgerCount: 30,
};

const ledgers = Array.from({ length: 30 }, (_, i) => ({
  sequence: 51_000_000 + i,
  closeTimeSeconds: 4.8 + Math.sin(i / 3) * 0.8,
  operationCount: 120 + Math.round(Math.cos(i / 4) * 40),
  successfulTransactionCount: 60 + Math.round(Math.sin(i / 5) * 15),
  failedTransactionCount: 3 + (i % 4),
  closedAt: iso(30 - i),
}));

const routes = {
  "/api/health": health,
  // Both of these are wrapped, not bare arrays — see fetchRecentLedgers and
  // fetchRecentFees in src/api.ts.
  "/api/ledgers/recent": { ledgers },
  "/api/fees/recent": {
    snapshots: Array.from({ length: 20 }, (_, i) => ({
      fetchedAt: iso(20 - i),
      feeChargedP50: 120 + i,
      feeChargedP90: 800 + i * 12,
    })),
  },
  "/api/history": {
    range: "24h",
    points: Array.from({ length: 48 }, (_, i) => ({
      timestamp: iso(1440 - i * 30),
      closeTimeSeconds: 5 + Math.sin(i / 6) * 0.5,
      congestionUsage: 0.4 + Math.sin(i / 8) * 0.25,
      operations: 500 + i * 3,
      transactions: 200 + i,
    })),
  },
  "/api/soroban": {
    network: "mainnet",
    invocationsPerSecond: 3,
    recentInvocationsTotal: 240,
    successfulInvocationsTotal: 225,
    failedInvocationsTotal: 15,
    samples: Array.from({ length: 24 }, (_, i) => ({
      timestamp: iso(24 - i),
      invocationsCount: 10 + (i % 7),
      successfulCount: 9 + (i % 6),
      failedCount: 1 + (i % 3),
    })),
  },
};

const axeSource = readFileSync(
  join(here, "..", "node_modules", "axe-core", "axe.min.js"),
  "utf8",
);

const browser = await chromium.launch();
let failed = false;

async function newPage(width, height, theme) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
  });
  await context.addInitScript(
    (t) => window.localStorage.setItem("netpulse:theme", t),
    theme,
  );
  const page = await context.newPage();
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = routes[path];
    if (!body) return route.fulfill({ status: 404, body: "{}" });
    route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto(base, { waitUntil: "networkidle" });
  // Wait on the Recharts surface rather than anything this branch introduced,
  // so the same script can capture a baseline from an older build.
  await page.waitForSelector(".recharts-surface");
  // Charts animate in; settle before measuring or shooting.
  await page.waitForTimeout(1500);
  return { context, page };
}

console.log("\n=== axe-core in Chromium (real cascaded colours) ===\n");

for (const theme of ["dark", "light"]) {
  for (const [label, width] of [["desktop", 1280], ["tablet", 768], ["mobile", 375]]) {
    const { context, page } = await newPage(width, 900, theme);
    await page.addScriptTag({ content: axeSource });
    /*
     * The full rule set, not just the wcag2a/aa tags. `heading-order` and
     * `region` are classified best-practice rather than WCAG, and filtering by
     * tag silently drops them — which is exactly how a broken heading outline
     * survives an "axe passes" claim.
     */
    const results = await page.evaluate(async () => window.axe.run(document));

    const violations = results.violations;
    console.log(
      `  ${theme.padEnd(6)} ${label.padEnd(8)} ${String(width).padStart(4)}px  ` +
        `${results.passes.length} passes, ${violations.length} violations`,
    );
    for (const v of violations) {
      failed = true;
      console.log(`      ${v.id} (${v.impact}): ${v.help}`);
      for (const node of v.nodes.slice(0, 3)) {
        console.log(`        ${node.html.slice(0, 120)}`);
      }
    }

    await page.screenshot({
      path: join(shots, `${theme}-${label}-${width}.png`),
      fullPage: true,
    });
    await context.close();
  }
}

console.log("\n=== Keyboard-only pass (Tab order, activation, focus ring) ===\n");
{
  const { context, page } = await newPage(1280, 900, "dark");

  /*
   * Walk the whole tab cycle rather than a fixed number of stops, so a dead
   * stop cannot hide past the end of the loop. The cycle is complete when
   * focus returns to the first element.
   */
  const order = [];
  let first = null;
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        // What a screen reader would actually announce on landing here.
        name: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 34),
        pressed: el.getAttribute("aria-pressed"),
        role: el.getAttribute("role"),
        // A stop is "dead" when it lands inside a presentational subtree: the
        // user has focused something no assistive technology will describe.
        insideRoleImg: !!el.closest('[role="img"]'),
        outlineWidth: s.outlineWidth,
      };
    });
    if (!info) break;
    const key = `${info.tag}:${info.name}`;
    if (first === null) first = key;
    else if (key === first) break;
    order.push(info);
  }

  for (const el of order) {
    const ring = parseFloat(el.outlineWidth) > 0 ? `ring ${el.outlineWidth}` : "NO RING";
    const dead = el.insideRoleImg ? "  <-- DEAD STOP inside role=img" : "";
    if (ring === "NO RING" || el.insideRoleImg) failed = true;
    console.log(
      `  ${el.tag.padEnd(7)} ${el.name.padEnd(28)} ` +
        `${(el.pressed === null ? "-" : `pressed=${el.pressed}`).padEnd(14)} ${ring}${dead}`,
    );
  }

  const buttons = await page.locator("button").count();
  const deadStops = order.filter((o) => o.insideRoleImg).length;
  console.log(
    `\n  ${order.length} tab stops for ${buttons} interactive elements, ` +
      `${deadStops} dead`,
  );
  if (order.length < buttons) failed = true;

  // Activate the Testnet button from the keyboard alone.
  await page.keyboard.press("Tab");
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find(
      (b) => b.textContent.trim() === "Testnet",
    );
    btn.focus();
  });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const afterEnter = await page.evaluate(() =>
    [...document.querySelectorAll("button")]
      .filter((b) => b.hasAttribute("aria-pressed"))
      .map((b) => `${b.textContent.trim()}=${b.getAttribute("aria-pressed")}`),
  );
  console.log(`  after Enter on Testnet: ${afterEnter.join(", ")}`);
  if (!afterEnter.includes("Testnet=true")) failed = true;

  await page.keyboard.press("Space");
  await page.waitForTimeout(200);

  await context.close();
}

console.log("\n=== Breakpoint layout (no horizontal overflow) ===\n");
for (const [label, width] of [["mobile", 375], ["tablet", 768]]) {
  const { context, page } = await newPage(width, 900, "dark");
  const overflow = await page.evaluate(
    (w) => ({
      scrollWidth: document.documentElement.scrollWidth,
      viewport: w,
      overflowing: [...document.querySelectorAll("*")]
        .filter((el) => el.getBoundingClientRect().right > w + 1)
        .map((el) => `${el.tagName.toLowerCase()}.${el.className}`.slice(0, 60))
        .slice(0, 5),
    }),
    width,
  );
  const ok = overflow.scrollWidth <= width + 1;
  if (!ok) failed = true;
  console.log(
    `  ${label.padEnd(8)} ${width}px  scrollWidth=${overflow.scrollWidth}  ` +
      `${ok ? "no overflow" : `OVERFLOW: ${overflow.overflowing.join(", ")}`}`,
  );
  await context.close();
}

await browser.close();
server.close();

console.log(`\n${failed ? "FAILED" : "PASSED"} — screenshots in a11y-shots/\n`);
process.exit(failed ? 1 : 0);
