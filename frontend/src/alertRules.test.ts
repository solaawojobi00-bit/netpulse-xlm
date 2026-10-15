/*
 * The alert rule client (#214), against a real HTTP server.
 *
 * Every request here goes over a loopback socket to the server double in
 * src/test/alertRuleServer.ts, which speaks the contract from #213. Nothing
 * stubs `fetch`: a test that does can only prove the client called a function
 * the test wrote, which is exactly the class of bug this module can have —
 * the wrong method, the wrong path, a body the server would refuse, a 204 read
 * as JSON.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertMetric } from "./alertRules";
import {
  startAlertRuleServer,
  startLegacyBackend,
  type AlertRuleTestServer,
} from "./test/alertRuleServer";

let server: AlertRuleTestServer;
let client: typeof import("./alertRules");

/*
 * `API_BASE_URL` is read once at module scope, so the module has to be
 * imported *after* the variable is stubbed — hence the reset and the dynamic
 * import rather than a static one at the top of the file.
 */
async function clientFor(
  origin: string,
): Promise<typeof import("./alertRules")> {
  vi.stubEnv("VITE_API_URL", origin);
  vi.resetModules();
  return import("./alertRules");
}

beforeEach(async () => {
  server = await startAlertRuleServer();
  client = await clientFor(server.url);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await server.close();
});

describe("fetchAlertRules", () => {
  it("asks for one network and gets only that network's rules back", async () => {
    server.seed({ name: "Mainnet congestion", network: "mainnet" });
    server.seed({ name: "Testnet congestion", network: "testnet" });

    const rules = await client.fetchAlertRules({ network: "testnet" });

    expect(rules.map((rule) => rule.name)).toEqual(["Testnet congestion"]);
    expect(server.requests.at(-1)).toMatchObject({
      method: "GET",
      path: "/api/alert-rules?network=testnet",
    });
  });

  it("passes an enabled filter through as the string the API expects", async () => {
    server.seed({ name: "On", enabled: true });
    server.seed({ name: "Off", enabled: false });

    const rules = await client.fetchAlertRules({ enabled: false });

    expect(rules.map((rule) => rule.name)).toEqual(["Off"]);
    expect(server.requests.at(-1)?.path).toBe("/api/alert-rules?enabled=false");
  });

  it("requests the bare collection when there is nothing to filter by", async () => {
    await client.fetchAlertRules();
    expect(server.requests.at(-1)?.path).toBe("/api/alert-rules");
  });
});

describe("writing rules", () => {
  it("creates a rule the server then really holds", async () => {
    const rule = await client.createAlertRule({
      name: "Congestion over 80%",
      network: "mainnet",
      metric: "congestion",
      comparison: "above",
      threshold: 0.8,
      cooldownSeconds: 600,
    });

    expect(rule.id).toBeTruthy();
    // Read back from the server's own store, not from the response the client
    // just parsed: that is the difference between "the POST was shaped right"
    // and "the POST was echoed back".
    expect(server.rule(rule.id)).toMatchObject({
      name: "Congestion over 80%",
      metric: "congestion",
      threshold: 0.8,
      cooldownSeconds: 600,
      enabled: true,
    });
  });

  it("patches only the field it was given", async () => {
    const id = server.seed({
      name: "Congestion",
      enabled: true,
      threshold: 0.8,
    });

    const updated = await client.updateAlertRule(id, { enabled: false });

    expect(updated.enabled).toBe(false);
    expect(server.rule(id)).toMatchObject({ enabled: false, threshold: 0.8 });
    expect(server.requests.at(-1)).toMatchObject({
      method: "PATCH",
      body: { enabled: false },
    });
  });

  it("resolves rather than parsing the empty body of a 204 delete", async () => {
    const id = server.seed({ name: "Congestion" });

    await expect(client.deleteAlertRule(id)).resolves.toBeUndefined();
    expect(server.rules()).toHaveLength(0);
  });

  it("keeps the envelope when the server refuses a field", async () => {
    const error = await client
      .createAlertRule({
        name: "Impossible",
        network: "mainnet",
        metric: "congestion",
        threshold: 42,
      })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(client.AlertRuleApiError);
    const apiError = error as InstanceType<typeof client.AlertRuleApiError>;
    expect(apiError.status).toBe(400);
    expect(apiError.code).toBe("validation_failed");
    expect(client.detailFor(apiError, "threshold")).toMatch(/between 0 and 1/);
    // Nothing was stored, so the panel is not showing a rule that does not
    // exist.
    expect(server.rules()).toHaveLength(0);
  });

  it("surfaces a name collision as a 409 with the server's wording", async () => {
    server.seed({ name: "Taken" });

    const error = await client
      .createAlertRule({
        name: "Taken",
        network: "mainnet",
        metric: "congestion",
        threshold: 0.5,
      })
      .catch((err: unknown) => err);

    const apiError = error as InstanceType<typeof client.AlertRuleApiError>;
    expect(apiError.status).toBe(409);
    expect(apiError.code).toBe("conflict");
    expect(apiError.message).toBe(
      'An alert rule named "Taken" already exists.',
    );
    // A conflict is about the rule, not a field, so there is no detail to
    // hang on an input.
    expect(client.detailFor(apiError, "name")).toBeUndefined();
  });

  it("reports an unknown rule id as a 404 naming the id", async () => {
    const error = await client
      .updateAlertRule("no-such-rule", { enabled: true })
      .catch((err: unknown) => err);

    const apiError = error as InstanceType<typeof client.AlertRuleApiError>;
    expect(apiError.status).toBe(404);
    expect(apiError.message).toContain("no-such-rule");
  });
});

describe("delivery targets", () => {
  it("stores the URL and gets back only a redacted preview", async () => {
    const ruleId = server.seed({ name: "Congestion" });

    const target = await client.createAlertTarget(ruleId, {
      type: "slack",
      url: "https://hooks.slack.com/services/T000/B000/secret-token",
    });

    expect(target.urlPreview).toBe("https://hooks.slack.com/***");
    expect(target.urlPreview).not.toContain("secret-token");
    // The server kept the real thing; only the wire response is redacted.
    expect(server.rule(ruleId)?.targets[0].url).toContain("secret-token");
  });

  it("toggles a target without touching the rest of it", async () => {
    const ruleId = server.seed({
      name: "Congestion",
      targets: [
        { type: "discord", url: "https://discord.com/api/webhooks/1/x" },
      ],
    });
    const targetId = server.rule(ruleId)!.targets[0].id;

    const updated = await client.updateAlertTarget(ruleId, targetId, {
      enabled: false,
    });

    expect(updated.enabled).toBe(false);
    expect(server.rule(ruleId)?.targets[0]).toMatchObject({
      enabled: false,
      type: "discord",
      url: "https://discord.com/api/webhooks/1/x",
    });
  });

  it("deletes a target and leaves its rule standing", async () => {
    const ruleId = server.seed({
      name: "Congestion",
      targets: [
        { type: "generic", url: "https://example.com/a" },
        { type: "generic", url: "https://example.com/b" },
      ],
    });
    const [first] = server.rule(ruleId)!.targets;

    await client.deleteAlertTarget(ruleId, first.id);

    expect(server.rule(ruleId)?.targets.map((t) => t.url)).toEqual([
      "https://example.com/b",
    ]);
  });

  it("hangs a refused URL on the url field", async () => {
    const ruleId = server.seed({ name: "Congestion" });

    const error = await client
      .createAlertTarget(ruleId, {
        type: "generic",
        url: "ftp://example.com/x",
      })
      .catch((err: unknown) => err);

    expect(client.detailFor(error, "url")).toBe(
      "url must use the http or https scheme.",
    );
  });
});

describe("a backend without the management routes", () => {
  it("reports the 404 rather than choking on the HTML body", async () => {
    const legacy = await startLegacyBackend();
    const legacyClient = await clientFor(legacy.url);

    const error = await legacyClient
      .fetchAlertRules({ network: "mainnet" })
      .catch((err: unknown) => err);

    const apiError = error as InstanceType<
      typeof legacyClient.AlertRuleApiError
    >;
    expect(apiError.status).toBe(404);
    // No envelope to read, so the code says so rather than inventing one.
    expect(apiError.code).toBe("unexpected_response");
    expect(apiError.message).toBe(
      "GET /api/alert-rules?network=mainnet failed.",
    );

    await legacy.close();
  });

  it("reports an unreachable backend as an error rather than hanging", async () => {
    const closed = await startAlertRuleServer();
    const origin = closed.url;
    await closed.close();
    const offlineClient = await clientFor(origin);

    await expect(offlineClient.fetchAlertRules()).rejects.toThrow();
  });
});

/*
 * The local field checks exist so the form can answer without a round trip.
 * They are only worth having if they agree with the server, so each case below
 * asserts both: the mirror says no, and the real API says no for the same
 * input.
 */
describe("the local field checks agree with the API", () => {
  const badRules: { label: string; metric: string; threshold: number }[] = [
    { label: "congestion above 1", metric: "congestion", threshold: 1.4 },
    { label: "congestion below 0", metric: "congestion", threshold: -0.1 },
    { label: "close time of zero", metric: "closeTime", threshold: 0 },
    { label: "close time past an hour", metric: "closeTime", threshold: 3601 },
    { label: "a fractional base fee", metric: "baseFee", threshold: 100.5 },
  ];

  it.each(badRules)(
    "refuses $label in the browser and at the API",
    async ({ metric, threshold }) => {
      expect(
        client.thresholdProblem(metric as AlertMetric, threshold),
      ).not.toBeNull();

      const error = await client
        .createAlertRule({
          name: `Rule for ${metric} ${threshold}`,
          network: "mainnet",
          metric: metric as AlertMetric,
          threshold,
        })
        .catch((err: unknown) => err);

      expect(client.detailFor(error, "threshold")).toBe(
        client.thresholdProblem(metric as AlertMetric, threshold),
      );
    },
  );

  it.each([
    ["congestion", 0.8],
    ["closeTime", 8],
    ["baseFee", 150],
  ] as const)(
    "accepts a valid %s threshold on both sides",
    async (metric, threshold) => {
      expect(client.thresholdProblem(metric, threshold)).toBeNull();

      const rule = await client.createAlertRule({
        name: `Valid ${metric}`,
        network: "mainnet",
        metric,
        threshold,
      });

      expect(server.rule(rule.id)?.threshold).toBe(threshold);
    },
  );

  it.each([
    ["not-a-url", "url must be an absolute http(s) URL."],
    ["ftp://example.com/hook", "url must use the http or https scheme."],
  ])(
    "refuses the URL %s in the browser and at the API",
    async (url, message) => {
      expect(client.urlProblem(url)).toBe(message);

      const ruleId = server.seed({ name: `Rule for ${url}` });
      const error = await client
        .createAlertTarget(ruleId, { type: "generic", url })
        .catch((err: unknown) => err);

      expect(client.detailFor(error, "url")).toBe(message);
    },
  );

  it("refuses an over-long rule name on both sides", async () => {
    const name = "x".repeat(client.MAX_RULE_NAME_LENGTH + 1);
    expect(client.nameProblem(name)).toMatch(/at most 80 characters/);

    const error = await client
      .createAlertRule({
        name,
        network: "mainnet",
        metric: "congestion",
        threshold: 0.5,
      })
      .catch((err: unknown) => err);

    expect(client.detailFor(error, "name")).toBeTruthy();
  });

  it("refuses an out-of-range cooldown on both sides", async () => {
    const seconds = client.MAX_COOLDOWN_SECONDS + 1;
    expect(client.cooldownProblem(seconds)).toMatch(/0 to 86400/);

    const error = await client
      .createAlertRule({
        name: "Too patient",
        network: "mainnet",
        metric: "congestion",
        threshold: 0.5,
        cooldownSeconds: seconds,
      })
      .catch((err: unknown) => err);

    expect(client.detailFor(error, "cooldownSeconds")).toBeTruthy();
  });

  it("names the empty cases the API cannot describe as helpfully", () => {
    // The server says "String must contain at least 1 character(s)"; a form
    // can do better, and these are caught before a request is made at all.
    expect(client.nameProblem("   ")).toBe("Give the rule a name.");
    expect(client.urlProblem("")).toBe("Enter the webhook URL to deliver to.");
    expect(client.cooldownProblem(Number.NaN)).toMatch(/whole seconds/);
    expect(client.thresholdProblem("congestion", Number.NaN)).toBe(
      "threshold must be a finite number.",
    );
  });
});

describe("describeRule", () => {
  it("reads a rule back in the units its threshold is measured in", async () => {
    server.seed({ name: "Slow ledgers", metric: "closeTime", threshold: 8 });
    const [rule] = await client.fetchAlertRules();

    expect(client.describeRule(rule)).toBe(
      "Ledger close time above 8 (seconds)",
    );
  });
});
