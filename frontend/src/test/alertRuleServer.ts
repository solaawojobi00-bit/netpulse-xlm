/*
 * A real HTTP server speaking the alert rule contract from #213.
 *
 * The panel's whole job is to talk to that API: issue the right request, read
 * the response, and say something useful when it is refused. Stubbing `fetch`
 * would test none of that — it would test that the component calls a function
 * the test wrote. So the tests start this server on a loopback port, point
 * `VITE_API_URL` at it, and let the component make real requests over real
 * TCP, with real status codes, real JSON and a real store behind them.
 *
 * It is written from the contract in backend/src/alertRulesApi.ts and
 * backend/src/alertRules.ts — deliberately not by importing the frontend's
 * mirror of those rules, which would make a validation test agree with itself
 * no matter what either side said.
 *
 * It is not the backend: no SQLite, no persistence across a test, no
 * evaluation. Rules live in a Map for the life of one server.
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

type Json = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

const NETWORKS = ["mainnet", "testnet"];
const METRICS = ["congestion", "closeTime", "baseFee"];
const COMPARISONS = ["above", "below"];
const TARGET_TYPES = ["generic", "discord", "slack"];
const MAX_COOLDOWN_SECONDS = 86_400;
const MAX_RULE_NAME_LENGTH = 80;
const MAX_TARGETS_PER_RULE = 10;

interface StoredTarget {
  id: string;
  ruleId: string;
  type: string;
  url: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface StoredRule {
  id: string;
  name: string;
  network: string;
  metric: string;
  comparison: string;
  threshold: number;
  enabled: boolean;
  cooldownSeconds: number;
  createdAt: string;
  updatedAt: string;
  targets: StoredTarget[];
}

export interface SeedRule {
  name: string;
  network?: string;
  metric?: string;
  comparison?: string;
  threshold?: number;
  enabled?: boolean;
  cooldownSeconds?: number;
  targets?: { type: string; url: string; enabled?: boolean }[];
}

export interface RequestLogEntry {
  method: string;
  path: string;
  body?: unknown;
}

export interface AlertRuleTestServer {
  /** Origin to hand to `VITE_API_URL`, e.g. `http://127.0.0.1:51234`. */
  url: string;
  /** Every request the server answered, in order. */
  requests: RequestLogEntry[];
  seed(rule: SeedRule): string;
  /**
   * Makes the next request — whatever it is — fail with a 500 envelope. The
   * way to exercise a retry without taking the port away, which would make
   * every later request in the test fail too.
   */
  failNext(): void;
  /** The server's own view of a rule, for asserting a write really landed. */
  rule(id: string): StoredRule | undefined;
  rules(): StoredRule[];
  close(): Promise<void>;
}

/** Mirrors `redactUrl` in backend/src/alertRules.ts. */
function redactUrl(raw: string): string {
  const parsed = new URL(raw);
  const hasSecret =
    (parsed.pathname !== "" && parsed.pathname !== "/") || parsed.search !== "";
  return hasSecret ? `${parsed.origin}/***` : parsed.origin;
}

function thresholdProblem(metric: string, threshold: unknown): string | null {
  if (typeof threshold !== "number" || !Number.isFinite(threshold))
    return "threshold must be a finite number.";
  if (metric === "congestion")
    return threshold >= 0 && threshold <= 1
      ? null
      : "A congestion threshold is a fraction of ledger capacity and must be between 0 and 1.";
  if (metric === "closeTime")
    return threshold > 0 && threshold <= 3600
      ? null
      : "A closeTime threshold is in seconds and must be greater than 0 and at most 3600.";
  return Number.isInteger(threshold) &&
    threshold >= 0 &&
    threshold <= 1_000_000_000
    ? null
    : "A baseFee threshold is in whole stroops and must be an integer between 0 and 1000000000.";
}

function urlProblem(raw: unknown): string | null {
  if (typeof raw !== "string") return "url must be a string.";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "url must be an absolute http(s) URL.";
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:"
    ? null
    : "url must use the http or https scheme.";
}

function serialiseTarget(target: StoredTarget) {
  return {
    id: target.id,
    ruleId: target.ruleId,
    type: target.type,
    urlPreview: redactUrl(target.url),
    enabled: target.enabled,
    createdAt: target.createdAt,
    updatedAt: target.updatedAt,
  };
}

function serialiseRule(rule: StoredRule) {
  return {
    id: rule.id,
    name: rule.name,
    network: rule.network,
    metric: rule.metric,
    comparison: rule.comparison,
    threshold: rule.threshold,
    enabled: rule.enabled,
    cooldownSeconds: rule.cooldownSeconds,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
    targets: rule.targets.map(serialiseTarget),
  };
}

export async function startAlertRuleServer(): Promise<AlertRuleTestServer> {
  const store = new Map<string, StoredRule>();
  const requests: RequestLogEntry[] = [];
  let clock = 0;
  let failOnce = false;

  /** Monotonic and deterministic: a real clock would make `updatedAt` flaky. */
  const stamp = () =>
    new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString();

  function validateRuleBody(
    body: Json,
    mode: "create" | "patch",
    existing?: StoredRule,
  ): { details: { path: string; message: string }[] } {
    const details: { path: string; message: string }[] = [];
    const require = (path: string, message: string) =>
      details.push({ path, message });

    for (const key of Object.keys(body)) {
      if (
        ![
          "name",
          "network",
          "metric",
          "comparison",
          "threshold",
          "enabled",
          "cooldownSeconds",
          ...(mode === "create" ? ["targets"] : []),
        ].includes(key)
      )
        require(key, `Unrecognized key: "${key}".`);
    }

    if (mode === "create") {
      if (typeof body.name !== "string" || body.name.trim() === "")
        require("name", "String must contain at least 1 character(s)");
      if (!NETWORKS.includes(String(body.network)))
        require("network", "Invalid enum value.");
      if (!METRICS.includes(text(body.metric)))
        require("metric", "Invalid enum value.");
    }

    if (
      typeof body.name === "string" &&
      body.name.length > MAX_RULE_NAME_LENGTH
    )
      require("name", `String must contain at most ${MAX_RULE_NAME_LENGTH} character(s)`);

    if (
      body.comparison !== undefined &&
      !COMPARISONS.includes(text(body.comparison))
    )
      require("comparison", "Invalid enum value.");

    if (body.cooldownSeconds !== undefined) {
      const value = body.cooldownSeconds;
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > MAX_COOLDOWN_SECONDS
      )
        require("cooldownSeconds", `Number must be an integer between 0 and ${MAX_COOLDOWN_SECONDS}`);
    }

    if (details.length > 0) return { details };

    // Cross-field: the metric and the threshold are checked as a pair even
    // when a patch carries only one of them, exactly as the routes do.
    const metric = (body.metric ?? existing?.metric) as string | undefined;
    const threshold = body.threshold ?? existing?.threshold;
    if (metric !== undefined && threshold !== undefined) {
      const problem = thresholdProblem(metric, threshold);
      if (problem) details.push({ path: "threshold", message: problem });
    }

    return { details };
  }

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Json = {};
      let malformed = false;
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw) as Json;
        } catch {
          malformed = true;
        }
      }

      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://localhost");
      requests.push({
        method,
        path: `${url.pathname}${url.search}`,
        body: raw.length > 0 ? body : undefined,
      });

      const send = (status: number, payload?: unknown) => {
        if (payload === undefined) {
          res.writeHead(status).end();
          return;
        }
        const text = JSON.stringify(payload);
        res.writeHead(status, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(text),
        });
        res.end(text);
      };

      const fail = (
        status: number,
        code: string,
        message: string,
        details?: { path: string; message: string }[],
      ) =>
        send(status, {
          error: details ? { code, message, details } : { code, message },
        });

      const invalid = (details: { path: string; message: string }[]) =>
        fail(
          400,
          "validation_failed",
          "The request body is not a valid alert rule payload.",
          details,
        );

      if (failOnce) {
        failOnce = false;
        fail(500, "internal_error", "The server fell over.");
        return;
      }

      if (malformed) {
        fail(
          400,
          "invalid_json",
          "Request body must be valid JSON with Content-Type: application/json.",
        );
        return;
      }

      const segments = url.pathname.split("/").filter(Boolean);
      // /api/alert-rules[/:id[/targets[/:targetId]]]
      if (segments[0] !== "api" || segments[1] !== "alert-rules") {
        fail(404, "not_found", `No route for ${url.pathname}.`);
        return;
      }

      const ruleId = segments[2];
      const rule = ruleId ? store.get(ruleId) : undefined;
      if (ruleId && !rule) {
        fail(404, "not_found", `No alert rule with id "${ruleId}".`);
        return;
      }

      // Collection.
      if (!ruleId) {
        if (method === "GET") {
          const network = url.searchParams.get("network");
          const enabled = url.searchParams.get("enabled");
          const rules = [...store.values()]
            .filter((r) => !network || r.network === network)
            .filter(
              (r) => enabled === null || r.enabled === (enabled === "true"),
            );
          send(200, { rules: rules.map(serialiseRule) });
          return;
        }

        if (method === "POST") {
          const { details } = validateRuleBody(body, "create");
          const targets = Array.isArray(body.targets) ? body.targets : [];
          targets.forEach((target, index) => {
            const problem = urlProblem((target as Json).url);
            if (problem)
              details.push({ path: `targets.${index}.url`, message: problem });
          });
          if (details.length > 0) {
            invalid(details);
            return;
          }

          const name = String(body.name).trim();
          if ([...store.values()].some((r) => r.name === name)) {
            fail(
              409,
              "conflict",
              `An alert rule named "${name}" already exists.`,
            );
            return;
          }

          const now = stamp();
          const created: StoredRule = {
            id: randomUUID(),
            name,
            network: String(body.network),
            metric: text(body.metric),
            comparison: text(body.comparison ?? "above"),
            threshold: Number(body.threshold),
            enabled: body.enabled === undefined ? true : Boolean(body.enabled),
            cooldownSeconds: Number(body.cooldownSeconds ?? 900),
            createdAt: now,
            updatedAt: now,
            targets: [],
          };
          created.targets = targets.map((target) => {
            const t = target as Json;
            return {
              id: randomUUID(),
              ruleId: created.id,
              type: String(t.type),
              url: String(t.url),
              enabled: t.enabled === undefined ? true : Boolean(t.enabled),
              createdAt: now,
              updatedAt: now,
            };
          });
          store.set(created.id, created);
          send(201, { rule: serialiseRule(created) });
          return;
        }
      }

      // A single rule.
      if (rule && segments.length === 3) {
        if (method === "GET") {
          send(200, { rule: serialiseRule(rule) });
          return;
        }

        if (method === "PATCH") {
          if (Object.keys(body).length === 0) {
            invalid([
              {
                path: "(body)",
                message: "Provide at least one field to update.",
              },
            ]);
            return;
          }
          const { details } = validateRuleBody(body, "patch", rule);
          if (details.length > 0) {
            invalid(details);
            return;
          }
          if (
            typeof body.name === "string" &&
            [...store.values()].some(
              (r) =>
                r.id !== rule.id && r.name === (body.name as string).trim(),
            )
          ) {
            fail(
              409,
              "conflict",
              `An alert rule named "${String(body.name).trim()}" already exists.`,
            );
            return;
          }

          if (typeof body.name === "string") rule.name = body.name.trim();
          if (body.metric !== undefined) rule.metric = text(body.metric);
          if (body.comparison !== undefined)
            rule.comparison = text(body.comparison);
          if (body.threshold !== undefined)
            rule.threshold = Number(body.threshold);
          if (body.enabled !== undefined) rule.enabled = Boolean(body.enabled);
          if (body.cooldownSeconds !== undefined)
            rule.cooldownSeconds = Number(body.cooldownSeconds);
          rule.updatedAt = stamp();
          send(200, { rule: serialiseRule(rule) });
          return;
        }

        if (method === "DELETE") {
          store.delete(rule.id);
          send(204);
          return;
        }
      }

      // Targets of a rule.
      if (rule && segments[3] === "targets") {
        const targetId = segments[4];
        const target = targetId
          ? rule.targets.find((t) => t.id === targetId)
          : undefined;
        if (targetId && !target) {
          fail(404, "not_found", `No delivery target with id "${targetId}".`);
          return;
        }

        if (!targetId && method === "GET") {
          send(200, { targets: rule.targets.map(serialiseTarget) });
          return;
        }

        if (!targetId && method === "POST") {
          const details: { path: string; message: string }[] = [];
          if (!TARGET_TYPES.includes(text(body.type)))
            details.push({ path: "type", message: "Invalid enum value." });
          const problem = urlProblem(body.url);
          if (problem) details.push({ path: "url", message: problem });
          if (details.length > 0) {
            invalid(details);
            return;
          }
          if (rule.targets.length >= MAX_TARGETS_PER_RULE) {
            fail(
              409,
              "conflict",
              `An alert rule may have at most ${MAX_TARGETS_PER_RULE} delivery targets.`,
            );
            return;
          }

          const now = stamp();
          const created: StoredTarget = {
            id: randomUUID(),
            ruleId: rule.id,
            type: text(body.type),
            url: text(body.url),
            enabled: body.enabled === undefined ? true : Boolean(body.enabled),
            createdAt: now,
            updatedAt: now,
          };
          rule.targets.push(created);
          send(201, { target: serialiseTarget(created) });
          return;
        }

        if (target && method === "PATCH") {
          if (body.url !== undefined) {
            const problem = urlProblem(body.url);
            if (problem) {
              invalid([{ path: "url", message: problem }]);
              return;
            }
            target.url = text(body.url);
          }
          if (body.type !== undefined) target.type = text(body.type);
          if (body.enabled !== undefined)
            target.enabled = Boolean(body.enabled);
          target.updatedAt = stamp();
          send(200, { target: serialiseTarget(target) });
          return;
        }

        if (target && method === "DELETE") {
          rule.targets = rule.targets.filter((t) => t.id !== target.id);
          send(204);
          return;
        }
      }

      fail(404, "not_found", `No route for ${method} ${url.pathname}.`);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("test server did not bind a port");

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    failNext() {
      failOnce = true;
    },
    seed(seed: SeedRule) {
      const now = stamp();
      const id = randomUUID();
      const stored: StoredRule = {
        id,
        name: seed.name,
        network: seed.network ?? "mainnet",
        metric: seed.metric ?? "congestion",
        comparison: seed.comparison ?? "above",
        threshold: seed.threshold ?? 0.8,
        enabled: seed.enabled ?? true,
        cooldownSeconds: seed.cooldownSeconds ?? 900,
        createdAt: now,
        updatedAt: now,
        targets: (seed.targets ?? []).map((target) => ({
          id: randomUUID(),
          ruleId: id,
          type: target.type,
          url: target.url,
          enabled: target.enabled ?? true,
          createdAt: now,
          updatedAt: now,
        })),
      };
      store.set(id, stored);
      return id;
    },
    rule: (id: string) => store.get(id),
    rules: () => [...store.values()],
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) =>
          err ? reject(new Error(err.message, { cause: err })) : resolve(),
        ),
      ),
  };
}

/**
 * A backend without the management routes: every path answers 404 with the
 * HTML a proxy or an older Express default handler produces, which is also the
 * case where there is no error envelope to read.
 */
export async function startLegacyBackend(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = createServer((_req, res) => {
    res.writeHead(404, { "content-type": "text/html" });
    res.end(
      "<!DOCTYPE html><html><body>Cannot GET /api/alert-rules</body></html>",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("test server did not bind a port");

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) =>
          err ? reject(new Error(err.message, { cause: err })) : resolve(),
        ),
      ),
  };
}
