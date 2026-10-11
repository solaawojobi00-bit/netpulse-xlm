/*
 * The browser half of alert rule management (#214).
 *
 * This is the first part of the frontend that writes anything. Every other
 * call in api.ts is a GET that either returns data or throws, so a one-line
 * `throw new Error(...)` carries everything a chart needs to know. A form
 * cannot work that way: when the backend refuses a rule it says *which field*
 * is wrong and *why* (see the error envelope in backend/src/alertRulesApi.ts),
 * and dropping that detail would leave the panel showing "400" beside a form
 * the visitor has no way to correct.
 *
 * So this module keeps the envelope intact in `AlertRuleApiError`, and mirrors
 * the backend's field rules so the obvious mistakes are caught before a
 * request is sent. The mirror is deliberate duplication, not a second source
 * of truth: the server still validates everything, and `alertRules.test.ts`
 * pins these helpers against the same cases the backend's own tests use. Local
 * checks make the form answer instantly; the server's answer always wins.
 */
import { API_BASE_URL } from "./config";
import type { Network } from "./api";

export const ALERT_METRICS = ["congestion", "closeTime", "baseFee"] as const;
export type AlertMetric = (typeof ALERT_METRICS)[number];

export const ALERT_COMPARISONS = ["above", "below"] as const;
export type AlertComparison = (typeof ALERT_COMPARISONS)[number];

export const ALERT_TARGET_TYPES = ["generic", "discord", "slack"] as const;
export type AlertTargetType = (typeof ALERT_TARGET_TYPES)[number];

/** Mirrors of the bounds in backend/src/alertRules.ts. */
export const MAX_COOLDOWN_SECONDS = 86_400;
export const DEFAULT_COOLDOWN_SECONDS = 900;
export const MAX_RULE_NAME_LENGTH = 80;
export const MAX_TARGET_URL_LENGTH = 2048;
export const MAX_TARGETS_PER_RULE = 10;

/**
 * What a threshold is read in, per metric. Shown beside the field because the
 * number alone does not say it: `0.8` is four fifths of ledger capacity for
 * congestion and eight tenths of a second for close time.
 */
export const METRIC_UNITS: Record<AlertMetric, string> = {
  congestion: "fraction of ledger capacity, 0–1",
  closeTime: "seconds",
  baseFee: "stroops",
};

export const METRIC_LABELS: Record<AlertMetric, string> = {
  congestion: "Network congestion",
  closeTime: "Ledger close time",
  baseFee: "Base fee",
};

export const TARGET_TYPE_LABELS: Record<AlertTargetType, string> = {
  generic: "Generic webhook",
  discord: "Discord",
  slack: "Slack",
};

export interface AlertTarget {
  id: string;
  ruleId: string;
  type: AlertTargetType;
  /**
   * Origin plus a mask — the backend never serves a stored delivery URL,
   * because for Slack and Discord the URL *is* the credential. Enough to tell
   * two targets apart, not enough to post to either.
   */
  urlPreview: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AlertRule {
  id: string;
  name: string;
  network: Network;
  metric: AlertMetric;
  comparison: AlertComparison;
  threshold: number;
  enabled: boolean;
  cooldownSeconds: number;
  createdAt: string;
  updatedAt: string;
  targets: AlertTarget[];
}

export interface AlertTargetInput {
  type: AlertTargetType;
  url: string;
  enabled?: boolean;
}

export interface AlertRuleInput {
  name: string;
  network: Network;
  metric: AlertMetric;
  comparison?: AlertComparison;
  threshold: number;
  enabled?: boolean;
  cooldownSeconds?: number;
  targets?: AlertTargetInput[];
}

export type AlertRulePatch = Partial<Omit<AlertRuleInput, "targets">>;
export type AlertTargetPatch = Partial<AlertTargetInput>;

export interface ApiErrorDetail {
  path: string;
  message: string;
}

/**
 * A refusal from the management API, with the envelope preserved.
 *
 * `status` and `code` let a caller branch (a 404 on the collection means the
 * backend predates these routes; a 409 is a name collision, not a bad field),
 * and `details` is what lets the form point at the field that was wrong.
 */
export class AlertRuleApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: ApiErrorDetail[];

  constructor(
    message: string,
    status: number,
    code: string,
    details: ApiErrorDetail[] = [],
  ) {
    super(message);
    this.name = "AlertRuleApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** The message the server attached to one field, if it attached one. */
export function detailFor(error: unknown, path: string): string | undefined {
  if (!(error instanceof AlertRuleApiError)) return undefined;
  return error.details.find((detail) => detail.path === path)?.message;
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string; details?: ApiErrorDetail[] };
}

async function readBody(res: Response): Promise<unknown> {
  try {
    return (await res.json()) as unknown;
  } catch {
    /*
     * A non-JSON body on a route that promises JSON means something other
     * than the backend answered — a proxy error page, or an older deployment
     * whose 404 handler returns HTML. Either way there is no envelope to read.
     */
    return undefined;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, init);

  if (res.status === 204) return undefined as T;

  const body = await readBody(res);

  if (!res.ok) {
    const envelope = (body ?? {}) as ErrorEnvelope;
    throw new AlertRuleApiError(
      envelope.error?.message ?? `${init?.method ?? "GET"} ${path} failed.`,
      res.status,
      envelope.error?.code ?? "unexpected_response",
      envelope.error?.details ?? [],
    );
  }

  return body as T;
}

function jsonRequest<T>(
  path: string,
  method: "POST" | "PATCH",
  payload: unknown,
): Promise<T> {
  return request<T>(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export interface AlertRuleFilter {
  network?: Network;
  enabled?: boolean;
}

export async function fetchAlertRules(
  filter: AlertRuleFilter = {},
): Promise<AlertRule[]> {
  const params = new URLSearchParams();
  if (filter.network) params.set("network", filter.network);
  if (filter.enabled !== undefined)
    params.set("enabled", String(filter.enabled));
  const query = params.toString();

  const body = await request<{ rules: AlertRule[] }>(
    `/api/alert-rules${query ? `?${query}` : ""}`,
  );
  return body.rules;
}

export async function createAlertRule(
  input: AlertRuleInput,
): Promise<AlertRule> {
  const body = await jsonRequest<{ rule: AlertRule }>(
    "/api/alert-rules",
    "POST",
    input,
  );
  return body.rule;
}

export async function updateAlertRule(
  id: string,
  patch: AlertRulePatch,
): Promise<AlertRule> {
  const body = await jsonRequest<{ rule: AlertRule }>(
    `/api/alert-rules/${encodeURIComponent(id)}`,
    "PATCH",
    patch,
  );
  return body.rule;
}

export async function deleteAlertRule(id: string): Promise<void> {
  await request<void>(`/api/alert-rules/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function createAlertTarget(
  ruleId: string,
  input: AlertTargetInput,
): Promise<AlertTarget> {
  const body = await jsonRequest<{ target: AlertTarget }>(
    `/api/alert-rules/${encodeURIComponent(ruleId)}/targets`,
    "POST",
    input,
  );
  return body.target;
}

export async function updateAlertTarget(
  ruleId: string,
  targetId: string,
  patch: AlertTargetPatch,
): Promise<AlertTarget> {
  const body = await jsonRequest<{ target: AlertTarget }>(
    `/api/alert-rules/${encodeURIComponent(ruleId)}/targets/${encodeURIComponent(targetId)}`,
    "PATCH",
    patch,
  );
  return body.target;
}

export async function deleteAlertTarget(
  ruleId: string,
  targetId: string,
): Promise<void> {
  await request<void>(
    `/api/alert-rules/${encodeURIComponent(ruleId)}/targets/${encodeURIComponent(targetId)}`,
    { method: "DELETE" },
  );
}

/*
 * Field checks, mirroring backend/src/alertRules.ts. Each returns a message or
 * null, in the same shape and with the same wording the server uses, so a
 * visitor never sees one sentence for a mistake caught here and a different
 * one for the identical mistake caught there.
 */

export function nameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "Give the rule a name.";
  if (trimmed.length > MAX_RULE_NAME_LENGTH)
    return `A rule name must be at most ${MAX_RULE_NAME_LENGTH} characters.`;
  return null;
}

export function thresholdProblem(
  metric: AlertMetric,
  threshold: number,
): string | null {
  if (!Number.isFinite(threshold)) return "threshold must be a finite number.";

  if (metric === "congestion") {
    return threshold >= 0 && threshold <= 1
      ? null
      : "A congestion threshold is a fraction of ledger capacity and must be between 0 and 1.";
  }

  if (metric === "closeTime") {
    return threshold > 0 && threshold <= 3600
      ? null
      : "A closeTime threshold is in seconds and must be greater than 0 and at most 3600.";
  }

  return Number.isInteger(threshold) &&
    threshold >= 0 &&
    threshold <= 1_000_000_000
    ? null
    : "A baseFee threshold is in whole stroops and must be an integer between 0 and 1000000000.";
}

export function cooldownProblem(seconds: number): string | null {
  return Number.isInteger(seconds) &&
    seconds >= 0 &&
    seconds <= MAX_COOLDOWN_SECONDS
    ? null
    : `A cooldown is in whole seconds, from 0 to ${MAX_COOLDOWN_SECONDS}.`;
}

export function urlProblem(raw: string): string | null {
  if (raw.trim().length === 0) return "Enter the webhook URL to deliver to.";
  if (raw.length > MAX_TARGET_URL_LENGTH)
    return `url must be at most ${MAX_TARGET_URL_LENGTH} characters.`;

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

/**
 * How a rule reads in one line: "congestion above 0.8 (fraction of ledger
 * capacity, 0–1)". The threshold is printed as stored rather than reformatted
 * per metric — a rule saying 0.8 should show 0.8, not 80%, so that what is on
 * screen matches what would be typed back into the field.
 */
export function describeRule(rule: AlertRule): string {
  return `${METRIC_LABELS[rule.metric]} ${rule.comparison} ${rule.threshold} (${METRIC_UNITS[rule.metric]})`;
}
