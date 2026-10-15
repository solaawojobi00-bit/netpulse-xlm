import { useState, type FormEvent } from "react";
import {
  ALERT_TARGET_TYPES,
  detailFor,
  MAX_TARGET_URL_LENGTH,
  TARGET_TYPE_LABELS,
  urlProblem,
  type AlertTargetInput,
  type AlertTargetType,
} from "../alertRules";

interface Props {
  busy: boolean;
  error: unknown;
  onSubmit: (input: AlertTargetInput) => void;
  onCancel: () => void;
  idPrefix: string;
}

/**
 * Adds one delivery target to a rule.
 *
 * The URL is a password field in everything but name — a Slack or Discord
 * webhook URL is the credential for that channel — but it is typed as `url`
 * so the browser does not offer to save it as a login and so a visitor can see
 * what they pasted. It is write-only afterwards: the backend serves a redacted
 * preview and never the stored value, so there is no edit-the-URL affordance
 * here. Rotating a webhook means adding the new target and deleting the old.
 */
export function AlertTargetForm({
  busy,
  error,
  onSubmit,
  onCancel,
  idPrefix,
}: Props) {
  const [type, setType] = useState<AlertTargetType>("generic");
  const [url, setUrl] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const urlError = localError ?? detailFor(error, "url");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const problem = urlProblem(url);
    setLocalError(problem);
    if (problem) return;

    onSubmit({ type, url: url.trim() });
  }

  const formError =
    error instanceof Error && !detailFor(error, "url") ? error.message : null;

  return (
    <form
      className="alert-form alert-form--target"
      onSubmit={handleSubmit}
      noValidate
    >
      <fieldset className="alert-form__fieldset" disabled={busy}>
        <legend className="alert-form__legend">Add a delivery target</legend>

        <div className="alert-form__grid">
          <div className="alert-field">
            <label htmlFor={`${idPrefix}-type`}>Target type</label>
            <select
              id={`${idPrefix}-type`}
              name="type"
              value={type}
              onChange={(e) => setType(e.target.value as AlertTargetType)}
            >
              {ALERT_TARGET_TYPES.map((value) => (
                <option key={value} value={value}>
                  {TARGET_TYPE_LABELS[value]}
                </option>
              ))}
            </select>
          </div>

          <div className="alert-field alert-field--wide">
            <label htmlFor={`${idPrefix}-url`}>Webhook URL</label>
            <input
              id={`${idPrefix}-url`}
              name="url"
              type="url"
              value={url}
              maxLength={MAX_TARGET_URL_LENGTH}
              placeholder="https://hooks.example.com/…"
              onChange={(e) => setUrl(e.target.value)}
              aria-invalid={urlError ? true : undefined}
              aria-describedby={`${idPrefix}-url-hint${urlError ? ` ${idPrefix}-url-error` : ""}`}
            />
            <p className="alert-field__hint" id={`${idPrefix}-url-hint`}>
              Stored write-only. Only the origin is shown back.
            </p>
            {urlError && (
              <p className="alert-field__error" id={`${idPrefix}-url-error`}>
                {urlError}
              </p>
            )}
          </div>
        </div>

        {formError && (
          <p className="alert-form__error" role="alert">
            {formError}
          </p>
        )}

        <div className="alert-form__actions">
          <button type="submit" className="alert-btn alert-btn--primary">
            {busy ? "Adding…" : "Add target"}
          </button>
          <button type="button" className="alert-btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </fieldset>
    </form>
  );
}
