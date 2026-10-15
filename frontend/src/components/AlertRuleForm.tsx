import { useState, type FormEvent } from "react";
import {
  ALERT_COMPARISONS,
  ALERT_METRICS,
  cooldownProblem,
  DEFAULT_COOLDOWN_SECONDS,
  detailFor,
  MAX_COOLDOWN_SECONDS,
  MAX_RULE_NAME_LENGTH,
  METRIC_LABELS,
  METRIC_UNITS,
  nameProblem,
  thresholdProblem,
  type AlertComparison,
  type AlertMetric,
  type AlertRule,
} from "../alertRules";
import type { Network } from "../api";

/** The fields a rule body carries, already parsed into the types it wants. */
export interface RuleSubmission {
  name: string;
  metric: AlertMetric;
  comparison: AlertComparison;
  threshold: number;
  cooldownSeconds: number;
  enabled: boolean;
}

interface Props {
  /** Names the form for assistive tech and titles it on screen. */
  legend: string;
  submitLabel: string;
  /** Fixed, not a field: the panel shows one network at a time. */
  network: Network;
  /** Supplied when editing; absent when creating. */
  rule?: AlertRule;
  busy: boolean;
  /** The last refusal from the server for *this* form, envelope intact. */
  error: unknown;
  onSubmit: (values: RuleSubmission) => void;
  onCancel: () => void;
  /**
   * Prefix for every `id` this form mints. Two of these can be open at once —
   * a create form and an edit form — and duplicate ids would point every
   * label at whichever input rendered first.
   */
  idPrefix: string;
}

type FieldName = "name" | "threshold" | "cooldownSeconds";

/*
 * Numbers arrive from the DOM as strings, and "" is a legitimate thing for a
 * visitor to leave behind. Keeping them as strings until submit means the
 * field shows exactly what was typed rather than a coerced 0, and lets the
 * empty case produce "must be a number" instead of silently saving zero.
 */
function parseNumber(raw: string): number {
  const trimmed = raw.trim();
  return trimmed === "" ? Number.NaN : Number(trimmed);
}

/** Step hint per metric: stroops are whole, the other two are fractional. */
function stepFor(metric: AlertMetric): string {
  return metric === "baseFee" ? "1" : "any";
}

export function AlertRuleForm({
  legend,
  submitLabel,
  network,
  rule,
  busy,
  error,
  onSubmit,
  onCancel,
  idPrefix,
}: Props) {
  const [name, setName] = useState(rule?.name ?? "");
  const [metric, setMetric] = useState<AlertMetric>(
    rule?.metric ?? "congestion",
  );
  const [comparison, setComparison] = useState<AlertComparison>(
    rule?.comparison ?? "above",
  );
  const [threshold, setThreshold] = useState(
    rule ? String(rule.threshold) : "",
  );
  const [cooldown, setCooldown] = useState(
    String(rule?.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS),
  );
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [localErrors, setLocalErrors] = useState<
    Partial<Record<FieldName, string>>
  >({});

  /*
   * Local checks answer instantly; the server's answer replaces them on the
   * next submit. Reading local first means a visitor correcting a field sees
   * their own mistake rather than the stale sentence from the last round trip.
   */
  function fieldError(field: FieldName): string | undefined {
    return localErrors[field] ?? detailFor(error, field);
  }

  function describedBy(field: FieldName, ...extra: string[]): string {
    const ids = [...extra];
    if (fieldError(field)) ids.push(`${idPrefix}-${field}-error`);
    return ids.join(" ");
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const thresholdValue = parseNumber(threshold);
    const cooldownValue = parseNumber(cooldown);
    const problems: Partial<Record<FieldName, string>> = {};

    const nameMessage = nameProblem(name);
    if (nameMessage) problems.name = nameMessage;
    const thresholdMessage = thresholdProblem(metric, thresholdValue);
    if (thresholdMessage) problems.threshold = thresholdMessage;
    const cooldownMessage = cooldownProblem(cooldownValue);
    if (cooldownMessage) problems.cooldownSeconds = cooldownMessage;

    setLocalErrors(problems);
    if (Object.keys(problems).length > 0) return;

    onSubmit({
      name: name.trim(),
      metric,
      comparison,
      threshold: thresholdValue,
      cooldownSeconds: cooldownValue,
      enabled,
    });
  }

  /*
   * Anything the server said that is not about a field this form renders:
   * a name collision (409), a malformed body, a route that is not there. It
   * would otherwise vanish, leaving a form that refuses to save and says
   * nothing about why.
   */
  const formError =
    error instanceof Error &&
    !(["name", "threshold", "cooldownSeconds"] as FieldName[]).some((field) =>
      detailFor(error, field),
    )
      ? error.message
      : null;

  return (
    <form className="alert-form" onSubmit={handleSubmit} noValidate>
      <fieldset className="alert-form__fieldset" disabled={busy}>
        <legend className="alert-form__legend">{legend}</legend>

        <p className="alert-form__network">
          Network: <strong>{network}</strong>
        </p>

        <div className="alert-form__grid">
          <div className="alert-field">
            <label htmlFor={`${idPrefix}-name`}>Rule name</label>
            <input
              id={`${idPrefix}-name`}
              name="name"
              type="text"
              value={name}
              maxLength={MAX_RULE_NAME_LENGTH}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={fieldError("name") ? true : undefined}
              aria-describedby={describedBy("name") || undefined}
            />
            {fieldError("name") && (
              <p className="alert-field__error" id={`${idPrefix}-name-error`}>
                {fieldError("name")}
              </p>
            )}
          </div>

          <div className="alert-field">
            <label htmlFor={`${idPrefix}-metric`}>Metric</label>
            <select
              id={`${idPrefix}-metric`}
              name="metric"
              value={metric}
              onChange={(e) => setMetric(e.target.value as AlertMetric)}
            >
              {ALERT_METRICS.map((value) => (
                <option key={value} value={value}>
                  {METRIC_LABELS[value]}
                </option>
              ))}
            </select>
          </div>

          <div className="alert-field">
            <label htmlFor={`${idPrefix}-comparison`}>Fires when</label>
            <select
              id={`${idPrefix}-comparison`}
              name="comparison"
              value={comparison}
              onChange={(e) => setComparison(e.target.value as AlertComparison)}
            >
              {ALERT_COMPARISONS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>

          <div className="alert-field">
            <label htmlFor={`${idPrefix}-threshold`}>Threshold</label>
            <input
              id={`${idPrefix}-threshold`}
              name="threshold"
              type="number"
              inputMode="decimal"
              step={stepFor(metric)}
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              aria-invalid={fieldError("threshold") ? true : undefined}
              aria-describedby={
                describedBy("threshold", `${idPrefix}-threshold-unit`) ||
                undefined
              }
            />
            {/*
              The unit is part of the contract, not decoration: the same 0.8
              means capacity usage for congestion and sub-second for close
              time, and nothing in the number says which.
            */}
            <p className="alert-field__hint" id={`${idPrefix}-threshold-unit`}>
              Measured in {METRIC_UNITS[metric]}.
            </p>
            {fieldError("threshold") && (
              <p
                className="alert-field__error"
                id={`${idPrefix}-threshold-error`}
              >
                {fieldError("threshold")}
              </p>
            )}
          </div>

          <div className="alert-field">
            <label htmlFor={`${idPrefix}-cooldown`}>Cooldown (seconds)</label>
            <input
              id={`${idPrefix}-cooldown`}
              name="cooldownSeconds"
              type="number"
              inputMode="numeric"
              step="1"
              min={0}
              max={MAX_COOLDOWN_SECONDS}
              value={cooldown}
              onChange={(e) => setCooldown(e.target.value)}
              aria-invalid={fieldError("cooldownSeconds") ? true : undefined}
              aria-describedby={
                describedBy("cooldownSeconds", `${idPrefix}-cooldown-hint`) ||
                undefined
              }
            />
            <p className="alert-field__hint" id={`${idPrefix}-cooldown-hint`}>
              Quiet period after a firing, up to {MAX_COOLDOWN_SECONDS} (a day).
            </p>
            {fieldError("cooldownSeconds") && (
              <p
                className="alert-field__error"
                id={`${idPrefix}-cooldownSeconds-error`}
              >
                {fieldError("cooldownSeconds")}
              </p>
            )}
          </div>

          <div className="alert-field alert-field--checkbox">
            <input
              id={`${idPrefix}-enabled`}
              name="enabled"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <label htmlFor={`${idPrefix}-enabled`}>Rule enabled</label>
          </div>
        </div>

        {formError && (
          <p className="alert-form__error" role="alert">
            {formError}
          </p>
        )}

        <div className="alert-form__actions">
          <button type="submit" className="alert-btn alert-btn--primary">
            {busy ? "Saving…" : submitLabel}
          </button>
          <button type="button" className="alert-btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </fieldset>
    </form>
  );
}
