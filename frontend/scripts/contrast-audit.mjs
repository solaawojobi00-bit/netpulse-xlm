/*
 * WCAG contrast audit for the palette in src/styles.css.
 *
 * Reads the token values straight out of the stylesheet rather than
 * duplicating them here, so the audit cannot silently drift from what the app
 * actually renders. Run with `node scripts/contrast-audit.mjs`.
 *
 * Tint backgrounds (banners, the error boundary) are semi-transparent rgba
 * over an opaque parent, so they are composited before measuring — measuring
 * against the rgba value itself would report a ratio no user ever sees.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "..", "src", "styles.css"), "utf8");

function tokensFrom(selector) {
  const block = css.slice(css.indexOf(selector));
  const body = block.slice(block.indexOf("{") + 1, block.indexOf("}"));
  const out = {};
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*(--[\w-]+):\s*(.+?);/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function parseColor(value) {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgba = value.match(/^rgba?\(([^)]+)\)$/);
  if (rgba) {
    const p = rgba[1].split(",").map((s) => Number(s.trim()));
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  throw new Error(`unparseable color: ${value}`);
}

/** Composite a possibly-transparent foreground over an opaque backdrop. */
function over(fg, bg) {
  const a = fg[3];
  return [
    fg[0] * a + bg[0] * (1 - a),
    fg[1] * a + bg[1] * (1 - a),
    fg[2] * a + bg[2] * (1 - a),
    1,
  ];
}

function relativeLuminance([r, g, b]) {
  const lin = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function ratio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/*
 * Brettel/Viénot-style CVD simulation, the standard approach: convert to LMS,
 * project onto the plane the missing cone type collapses to, convert back.
 * Used to check that two chart series remain distinguishable, not to claim a
 * precise clinical rendering.
 */
const RGB_TO_LMS = [
  [0.31399022, 0.63951294, 0.04649755],
  [0.15537241, 0.75789446, 0.08670142],
  [0.01775239, 0.10944209, 0.87256922],
];
const LMS_TO_RGB = [
  [5.47221206, -4.6419601, 0.16963708],
  [-1.1252419, 2.29317094, -0.1678952],
  [0.02980165, -0.19318073, 1.16364789],
];
const CVD_MATRICES = {
  protanopia: [
    [0, 1.05118294, -0.05116099],
    [0, 1, 0],
    [0, 0, 1],
  ],
  deuteranopia: [
    [1, 0, 0],
    [0.9513092, 0, 0.04866992],
    [0, 0, 1],
  ],
  tritanopia: [
    [1, 0, 0],
    [0, 1, 0],
    [-0.86744736, 1.86727089, 0],
  ],
};

function apply(m, v) {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

function toLinear(c) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function fromLinear(c) {
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(s * 255)));
}

function simulate(rgb, kind) {
  const lin = [toLinear(rgb[0]), toLinear(rgb[1]), toLinear(rgb[2])];
  const lms = apply(RGB_TO_LMS, lin);
  const sim = apply(CVD_MATRICES[kind], lms);
  const back = apply(LMS_TO_RGB, sim);
  return [fromLinear(back[0]), fromLinear(back[1]), fromLinear(back[2]), 1];
}

/* CIE76 in Lab. Crude next to CIEDE2000, but the threshold we care about
 * (roughly >20 = comfortably telling two lines apart) is coarse enough. */
function toLab([r, g, b]) {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  let x = (lr * 0.4124 + lg * 0.3576 + lb * 0.1805) / 0.95047;
  let y = lr * 0.2126 + lg * 0.7152 + lb * 0.0722;
  let z = (lr * 0.0193 + lg * 0.1192 + lb * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  [x, y, z] = [f(x), f(y), f(z)];
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function deltaE(a, b) {
  const la = toLab(a);
  const lb = toLab(b);
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
}

const themes = {
  dark: tokensFrom(":root {"),
  light: tokensFrom(':root[data-theme="light"]'),
};

/*
 * Every text/background pair the app actually renders. `on` names the opaque
 * backdrop; `tint` names a semi-transparent layer painted over it first.
 * `large: true` marks text at >=18.66px bold or >=24px, which WCAG AA scores
 * against 3:1 rather than 4.5:1.
 */
const PAIRS = [
  { name: "body text on page", fg: "--text-color", on: "--bg-color" },
  { name: "body text on card", fg: "--text-color", on: "--surface-color" },
  { name: "h1 (1.75rem/28px)", fg: "--text-color", on: "--bg-color", large: true },
  { name: "subtitle", fg: "--text-muted", on: "--bg-color" },
  { name: "footer / sync status", fg: "--text-muted", on: "--bg-color" },
  { name: "stat tile label + sublabel", fg: "--text-muted", on: "--surface-color" },
  { name: "stat value 1.6rem (25.6px)", fg: "--text-color", on: "--surface-color", large: true },
  { name: "stat value, good tone", fg: "--good-color", on: "--surface-color", large: true },
  { name: "stat value, warn tone", fg: "--warn-color", on: "--surface-color", large: true },
  { name: "stat value, bad tone", fg: "--bad-color", on: "--surface-color", large: true },
  /*
   * Scored at 4.5:1, not 3:1. The tile's "Unavailable" notice is 1rem bold —
   * 16px — and WCAG large text starts at 18.66px bold, so it does not qualify
   * for the relaxed threshold the 1.6rem value beside it gets.
   */
  { name: "stat tile, unavailable", fg: "--bad-color", on: "--surface-color" },
  { name: "chart card heading", fg: "--text-muted", on: "--surface-color" },
  { name: "chart axis ticks (10px)", fg: "--text-muted", on: "--surface-color" },
  { name: "chart empty-state text", fg: "--text-muted", on: "--surface-color" },
  { name: "chart error-state text", fg: "--bad-color", on: "--surface-color" },
  { name: "network selector, inactive", fg: "--text-muted", on: "--surface-color" },
  {
    name: "network selector, active",
    fg: "--accent-color",
    on: "--surface-color",
    tint: "--accent-tint-bg",
  },
  { name: "congestion chip, good", fg: "--good-color", on: "--surface-color", tint: "--good-tint-bg" },
  { name: "congestion chip, warn", fg: "--warn-color", on: "--surface-color", tint: "--warn-tint-bg" },
  { name: "congestion chip, bad", fg: "--bad-color", on: "--surface-color", tint: "--bad-tint-bg" },
  { name: "theme toggle glyph", fg: "--text-muted", on: "--surface-color" },
  { name: "network badge", fg: "--accent-color", on: "--bg-color", tint: "--accent-tint-bg" },
  { name: "stale banner", fg: "--warn-color", on: "--bg-color", tint: "--warn-tint-bg" },
  { name: "congestion banner", fg: "--bad-color", on: "--bg-color", tint: "--bad-tint-bg" },
  { name: "error boundary title", fg: "--bad-color", on: "--bg-color", tint: "--bad-tint-bg" },
  { name: "error boundary body", fg: "--text-color", on: "--bg-color", tint: "--bad-tint-bg" },
  { name: "error boundary detail", fg: "--text-muted", on: "--surface-color" },
  { name: "history badge", fg: "--text-muted", on: "--surface-color" },
  { name: "soroban stat pill", fg: "--text-color", on: "--bg-color" },
  { name: "soroban stat pill, muted", fg: "--text-muted", on: "--bg-color" },
  { name: "sync status, stale", fg: "--warn-color", on: "--bg-color" },
];

/*
 * Non-text UI that must clear 3:1 under WCAG 1.4.11 — the visual information
 * needed to identify an interactive control or its state, and the parts of a
 * graphic required to understand it.
 */
const UI_PAIRS = [
  { name: "selected network, ring", fg: "--accent-color", on: "--surface-color" },
  { name: "focus ring on page", fg: "--accent-color", on: "--bg-color" },
  { name: "focus ring on card", fg: "--accent-color", on: "--surface-color" },
  { name: "sync indicator dot, ok", fg: "--good-color", on: "--bg-color" },
  { name: "sync indicator dot, stale", fg: "--warn-color", on: "--bg-color" },
  { name: "congestion chip border, good", fg: "--good-color", on: "--surface-color" },
  { name: "congestion chip border, warn", fg: "--warn-color", on: "--surface-color" },
  { name: "congestion chip border, bad", fg: "--bad-color", on: "--surface-color" },
];

/*
 * Measured, reported, and deliberately not enforced.
 *
 * 1.4.11 covers what is needed to *identify a control or understand a
 * graphic*. A card border is neither: the card is already separated from the
 * page by its surface colour, and nothing about it is interactive. Chart
 * gridlines are a reading aid behind the data, not the data — the axis labels
 * carry the values, and darkening the grid to 3:1 would put a lattice in front
 * of the series it exists to support.
 *
 * They are listed so the numbers are on the record rather than absent, and so
 * that if either ever becomes load-bearing the measurement is already here.
 */
const INFORMATIONAL_PAIRS = [
  { name: "card border", fg: "--border-color", on: "--bg-color" },
  { name: "chart grid lines", fg: "--grid-color", on: "--surface-color" },
  { name: "card surface vs page", fg: "--surface-color", on: "--bg-color" },
];

/*
 * Series that share a chart and must be told apart. `redundant` names a second,
 * non-colour channel carrying the same distinction — where one exists the hue
 * distance stops being the thing the reader depends on, so a low dE is
 * reported but not treated as a failure.
 */
const SERIES_PAIRS = [
  {
    chart: "Transaction success",
    a: "--good-color",
    b: "--bad-color",
    redundant: "hatch fill on 'failed'",
  },
  {
    chart: "Soroban activity",
    a: "--good-color",
    b: "--bad-color",
    redundant: "dashed stroke on 'failed'",
  },
  {
    chart: "Fee spread trend",
    a: "--warn-color",
    b: "--accent-color",
    redundant: "dashed stroke on 'p90'",
  },
];

let failures = 0;

for (const [themeName, t] of Object.entries(themes)) {
  console.log(`\n${"=".repeat(72)}\n  ${themeName.toUpperCase()} THEME\n${"=".repeat(72)}`);
  console.log("\n  Text contrast (WCAG AA: 4.5:1 body, 3:1 large)\n");
  console.log(`  ${"Pair".padEnd(34)}${"Ratio".padEnd(9)}${"Req".padEnd(7)}Result`);
  console.log(`  ${"-".repeat(62)}`);

  for (const p of PAIRS) {
    let bg = parseColor(t[p.on]);
    if (p.tint) bg = over(parseColor(t[p.tint]), bg);
    const fg = over(parseColor(t[p.fg]), bg);
    const r = ratio(fg, bg);
    const req = p.large ? 3 : 4.5;
    const ok = r >= req;
    if (!ok) failures++;
    console.log(
      `  ${p.name.padEnd(34)}${r.toFixed(2).padEnd(9)}${`${req}:1`.padEnd(7)}${ok ? "PASS" : "FAIL"}`,
    );
  }

  console.log("\n  Non-text UI contrast (WCAG AA: 3:1)\n");
  for (const p of UI_PAIRS) {
    const bg = parseColor(t[p.on]);
    const fg = over(parseColor(t[p.fg]), bg);
    const r = ratio(fg, bg);
    const ok = r >= 3;
    if (!ok) failures++;
    console.log(
      `  ${p.name.padEnd(34)}${r.toFixed(2).padEnd(9)}${"3:1".padEnd(7)}${ok ? "PASS" : "FAIL"}`,
    );
  }

  console.log("\n  Measured, not enforced — see INFORMATIONAL_PAIRS for why\n");
  for (const p of INFORMATIONAL_PAIRS) {
    const bg = parseColor(t[p.on]);
    const fg = over(parseColor(t[p.fg]), bg);
    console.log(`  ${p.name.padEnd(34)}${ratio(fg, bg).toFixed(2).padEnd(9)}${"n/a".padEnd(7)}—`);
  }

  console.log("\n  Series distinguishability under CVD (CIE76 dE, >20 comfortable)\n");
  for (const s of SERIES_PAIRS) {
    const a = parseColor(t[s.a]);
    const b = parseColor(t[s.b]);
    const rows = ["normal", "protanopia", "deuteranopia", "tritanopia"].map((kind) => {
      const sa = kind === "normal" ? a : simulate(a, kind);
      const sb = kind === "normal" ? b : simulate(b, kind);
      return `${kind} ${deltaE(sa, sb).toFixed(0).padStart(3)}`;
    });
    const worst = Math.min(
      ...["protanopia", "deuteranopia", "tritanopia"].map((k) =>
        deltaE(simulate(a, k), simulate(b, k)),
      ),
    );
    // Colour alone would be a failure below 20; a second channel makes the hue
    // distance a convenience rather than the only way to read the chart.
    const verdict = worst >= 20 ? "hue OK" : "hue WEAK";
    if (worst < 20 && !s.redundant) failures++;
    console.log(`  ${s.chart.padEnd(22)}${rows.join("  ")}   ${verdict}`);
    console.log(`  ${"".padEnd(22)}also distinguished by: ${s.redundant}`);
  }
}

console.log(`\n${"=".repeat(72)}`);
console.log(failures === 0 ? "  All measured pairs meet WCAG AA." : `  ${failures} pair(s) below AA.`);
console.log(`${"=".repeat(72)}\n`);
process.exit(failures === 0 ? 0 : 1);
