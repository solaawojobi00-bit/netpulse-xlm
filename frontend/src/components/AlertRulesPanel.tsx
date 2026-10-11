import { useCallback, useEffect, useState } from "react";
import {
  AlertRuleApiError,
  createAlertRule,
  createAlertTarget,
  deleteAlertRule,
  deleteAlertTarget,
  describeRule,
  fetchAlertRules,
  MAX_TARGETS_PER_RULE,
  TARGET_TYPE_LABELS,
  updateAlertRule,
  updateAlertTarget,
  type AlertRule,
  type AlertTarget,
  type AlertTargetInput,
} from "../alertRules";
import type { Network } from "../api";
import { AlertRuleForm, type RuleSubmission } from "./AlertRuleForm";
import { AlertTargetForm } from "./AlertTargetForm";

/*
 * Alert rule management (#214), over the API from #213.
 *
 * Two shaping decisions, both visible immediately:
 *
 *   One network at a time.  The panel lists the rules for whichever network
 *   the dashboard header is showing, and the create form inherits it rather
 *   than offering a second network selector that could disagree with the one
 *   above it. Switching network up top switches the rules down here.
 *
 *   Every mutation is followed by a re-list.  Patching local state from a
 *   mutation response would be fewer requests, but a rule's `updatedAt` and
 *   its target set are server-owned, and two tabs editing the same rule would
 *   quietly diverge. Re-reading is one extra round trip for a panel that is
 *   used a handful of times a session, and it cannot drift.
 *
 * This backend may not have the routes at all: they are new, and a deployment
 * running an older build answers the collection with a 404. That is a distinct
 * state from "failed to load" and says so, because retrying will not fix it.
 */

type OpenForm =
  | { kind: "create" }
  | { kind: "edit"; ruleId: string }
  | { kind: "target"; ruleId: string }
  | null;

type Confirming =
  | { kind: "rule"; ruleId: string }
  | { kind: "target"; ruleId: string; targetId: string }
  | null;

interface Props {
  network: Network;
}

function errorMessage(err: unknown): string {
  if (err instanceof AlertRuleApiError) return err.message;
  if (err instanceof Error)
    return `Could not reach the alert rule API: ${err.message}`;
  return String(err);
}

export function AlertRulesPanel({ network }: Props) {
  // null until the first list resolves, so "still loading" is distinct from
  // "loaded and empty" — the same rule the charts follow.
  const [rules, setRules] = useState<AlertRule[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [openForm, setOpenForm] = useState<OpenForm>(null);
  const [formError, setFormError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * Re-reads the list for the current network.
   *
   * `alive` is how a result that arrived after the visitor switched network is
   * dropped: the fetch cannot be cancelled, but applying mainnet's rules under
   * a testnet heading can be.
   */
  const load = useCallback(
    async (alive: () => boolean = () => true) => {
      try {
        const next = await fetchAlertRules({ network });
        if (!alive()) return;
        setRules(next);
        setLoadError(null);
        setUnsupported(false);
      } catch (err: unknown) {
        if (!alive()) return;
        if (err instanceof AlertRuleApiError && err.status === 404) {
          // The collection route itself is missing, not a rule within it.
          setUnsupported(true);
          setRules(null);
          setLoadError(null);
          return;
        }
        setRules(null);
        setLoadError(errorMessage(err));
      }
    },
    [network],
  );

  useEffect(() => {
    let cancelled = false;
    // Discard the previous network's rules rather than listing them under the
    // new network's heading while the request is in flight.
    setRules(null);
    setLoadError(null);
    setUnsupported(false);
    setOpenForm(null);
    setConfirming(null);
    setNotice(null);
    setActionError(null);

    void load(() => !cancelled);

    return () => {
      cancelled = true;
    };
  }, [load]);

  /**
   * Runs one mutation: clears the previous complaint, reports the new one if
   * there is any, and re-lists on success. `onDone` only runs when the write
   * actually landed, so a form stays open — with what was typed in it — when
   * the server refuses.
   */
  async function mutate(
    action: () => Promise<unknown>,
    succeeded: string,
    onDone?: () => void,
  ) {
    setBusy(true);
    setFormError(null);
    setActionError(null);
    try {
      await action();
      await load();
      setNotice(succeeded);
      onDone?.();
    } catch (err: unknown) {
      setFormError(err);
      setActionError(errorMessage(err));
      setNotice(null);
    } finally {
      setBusy(false);
    }
  }

  function closeForm() {
    setOpenForm(null);
    setFormError(null);
    setActionError(null);
  }

  function submitCreate(values: RuleSubmission) {
    void mutate(
      () => createAlertRule({ ...values, network }),
      `Created the rule "${values.name}".`,
      () => setOpenForm(null),
    );
  }

  function submitEdit(rule: AlertRule, values: RuleSubmission) {
    void mutate(
      () => updateAlertRule(rule.id, values),
      `Saved the rule "${values.name}".`,
      () => setOpenForm(null),
    );
  }

  function submitTarget(ruleId: string, input: AlertTargetInput) {
    void mutate(
      () => createAlertTarget(ruleId, input),
      "Added the delivery target.",
      () => setOpenForm(null),
    );
  }

  function toggleRule(rule: AlertRule) {
    void mutate(
      () => updateAlertRule(rule.id, { enabled: !rule.enabled }),
      `${rule.enabled ? "Disabled" : "Enabled"} the rule "${rule.name}".`,
    );
  }

  function toggleTarget(rule: AlertRule, target: AlertTarget) {
    void mutate(
      () => updateAlertTarget(rule.id, target.id, { enabled: !target.enabled }),
      `${target.enabled ? "Disabled" : "Enabled"} delivery to ${target.urlPreview}.`,
    );
  }

  function removeRule(rule: AlertRule) {
    void mutate(
      () => deleteAlertRule(rule.id),
      `Deleted the rule "${rule.name}".`,
      () => setConfirming(null),
    );
  }

  function removeTarget(rule: AlertRule, target: AlertTarget) {
    void mutate(
      () => deleteAlertTarget(rule.id, target.id),
      `Removed delivery to ${target.urlPreview}.`,
      () => setConfirming(null),
    );
  }

  const header = (
    <div className="alert-section__header">
      <div>
        <h2 id="alert-rules-heading">Alert rules</h2>
        <p className="alert-section__subtitle">
          Thresholds NetPulse watches on {network}, and the webhooks each one
          delivers to.
        </p>
      </div>
      {rules !== null && (
        <button
          type="button"
          className="alert-btn alert-btn--primary"
          onClick={() => {
            setFormError(null);
            setOpenForm({ kind: "create" });
          }}
          disabled={openForm?.kind === "create"}
        >
          New rule
        </button>
      )}
    </div>
  );

  function body() {
    if (unsupported) {
      return (
        <p className="alert-section__note">
          This backend does not expose the alert rule management API yet, so
          there is nothing to manage from here. Rules are configured on the
          server until it ships.
        </p>
      );
    }

    if (loadError) {
      return (
        <div className="alert-section__note alert-section__note--error">
          <p role="alert">{loadError}</p>
          <button type="button" className="alert-btn" onClick={() => void load()}>
            Try again
          </button>
        </div>
      );
    }

    if (rules === null) {
      return (
        <p className="alert-section__note" role="status">
          Loading alert rules…
        </p>
      );
    }

    return (
      <>
        {openForm?.kind === "create" && (
          <AlertRuleForm
            legend="New alert rule"
            submitLabel="Create rule"
            network={network}
            busy={busy}
            error={formError}
            onSubmit={submitCreate}
            onCancel={closeForm}
            idPrefix="alert-create"
          />
        )}

        {rules.length === 0 && openForm?.kind !== "create" && (
          <p className="alert-section__note">
            No alert rules on {network} yet. Create one to start watching a
            threshold.
          </p>
        )}

        <ul className="alert-rule-list">
          {rules.map((rule) => (
            <li className="alert-rule" key={rule.id}>
              <div className="alert-rule__header">
                <div>
                  <h3 className="alert-rule__name">{rule.name}</h3>
                  <p className="alert-rule__summary">{describeRule(rule)}</p>
                  <p className="alert-rule__meta">
                    Cooldown {rule.cooldownSeconds}s ·{" "}
                    {/*
                      State in words, not only in the colour of the chip: the
                      same rule the stat tiles follow for congestion bands.
                    */}
                    <span
                      className={`alert-chip ${rule.enabled ? "alert-chip--on" : "alert-chip--off"}`}
                    >
                      {rule.enabled ? "enabled" : "disabled"}
                    </span>
                  </p>
                </div>
                {/*
                  Every button here is one of three words repeated down the
                  list, so each carries an `aria-label` naming the rule it acts
                  on: "Delete" alone is the same promise on every card, and a
                  visitor listing the buttons would hear it three times with no
                  way to tell which rule each one would delete. The visible
                  word is a prefix of the label, so speaking the label still
                  matches what is on screen.
                */}
                <div className="alert-rule__actions">
                  <button
                    type="button"
                    className="alert-btn"
                    disabled={busy}
                    aria-label={`${rule.enabled ? "Disable" : "Enable"} rule ${rule.name}`}
                    onClick={() => toggleRule(rule)}
                  >
                    {rule.enabled ? "Disable" : "Enable"}
                  </button>
                  <button
                    type="button"
                    className="alert-btn"
                    disabled={busy}
                    aria-label={`Edit rule ${rule.name}`}
                    onClick={() => {
                      setFormError(null);
                      setOpenForm({ kind: "edit", ruleId: rule.id });
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="alert-btn alert-btn--danger"
                    disabled={busy}
                    aria-label={`Delete rule ${rule.name}`}
                    onClick={() =>
                      setConfirming({ kind: "rule", ruleId: rule.id })
                    }
                  >
                    Delete
                  </button>
                </div>
              </div>

              {/*
                A two-step confirm rather than `window.confirm`: a native
                dialog cannot be styled, blocks the page, and is the one piece
                of UI a test can only reach by stubbing it out.
              */}
              {confirming?.kind === "rule" && confirming.ruleId === rule.id && (
                <div className="alert-confirm" role="alert">
                  <span>
                    Delete “{rule.name}” and its {rule.targets.length} delivery
                    target{rule.targets.length === 1 ? "" : "s"}?
                  </span>
                  <button
                    type="button"
                    className="alert-btn alert-btn--danger"
                    disabled={busy}
                    onClick={() => removeRule(rule)}
                  >
                    Delete rule
                  </button>
                  <button
                    type="button"
                    className="alert-btn"
                    disabled={busy}
                    onClick={() => setConfirming(null)}
                  >
                    Keep it
                  </button>
                </div>
              )}

              {openForm?.kind === "edit" && openForm.ruleId === rule.id && (
                <AlertRuleForm
                  /*
                   * Keyed by the rule's own identity so switching between two
                   * rules remounts the form with the new values instead of
                   * keeping the first rule's state in the fields.
                   */
                  key={`${rule.id}-${rule.updatedAt}`}
                  legend={`Edit “${rule.name}”`}
                  submitLabel="Save changes"
                  network={network}
                  rule={rule}
                  busy={busy}
                  error={formError}
                  onSubmit={(values) => submitEdit(rule, values)}
                  onCancel={closeForm}
                  idPrefix={`alert-edit-${rule.id}`}
                />
              )}

              <div className="alert-rule__targets">
                <h4 className="alert-rule__targets-heading">
                  Delivery targets ({rule.targets.length}/
                  {MAX_TARGETS_PER_RULE})
                </h4>

                {rule.targets.length === 0 ? (
                  <p className="alert-rule__empty">
                    No targets yet — this rule fires into nothing.
                  </p>
                ) : (
                  <ul className="alert-target-list">
                    {rule.targets.map((target) => (
                      <li className="alert-target" key={target.id}>
                        <span className="alert-target__type">
                          {TARGET_TYPE_LABELS[target.type]}
                        </span>
                        <code className="alert-target__url">
                          {target.urlPreview}
                        </code>
                        <span
                          className={`alert-chip ${target.enabled ? "alert-chip--on" : "alert-chip--off"}`}
                        >
                          {target.enabled ? "enabled" : "disabled"}
                        </span>
                        <button
                          type="button"
                          className="alert-btn alert-btn--small"
                          disabled={busy}
                          aria-label={`${target.enabled ? "Disable" : "Enable"} delivery to ${target.urlPreview}`}
                          onClick={() => toggleTarget(rule, target)}
                        >
                          {target.enabled ? "Disable" : "Enable"}
                        </button>
                        <button
                          type="button"
                          className="alert-btn alert-btn--small alert-btn--danger"
                          disabled={busy}
                          aria-label={`Remove delivery to ${target.urlPreview}`}
                          onClick={() =>
                            setConfirming({
                              kind: "target",
                              ruleId: rule.id,
                              targetId: target.id,
                            })
                          }
                        >
                          Remove
                        </button>

                        {confirming?.kind === "target" &&
                          confirming.targetId === target.id && (
                            <span className="alert-confirm" role="alert">
                              <span>Remove {target.urlPreview}?</span>
                              <button
                                type="button"
                                className="alert-btn alert-btn--small alert-btn--danger"
                                disabled={busy}
                                onClick={() => removeTarget(rule, target)}
                              >
                                Remove target
                              </button>
                              <button
                                type="button"
                                className="alert-btn alert-btn--small"
                                disabled={busy}
                                onClick={() => setConfirming(null)}
                              >
                                Keep it
                              </button>
                            </span>
                          )}
                      </li>
                    ))}
                  </ul>
                )}

                {openForm?.kind === "target" &&
                openForm.ruleId === rule.id ? (
                  <AlertTargetForm
                    busy={busy}
                    error={formError}
                    onSubmit={(input) => submitTarget(rule.id, input)}
                    onCancel={closeForm}
                    idPrefix={`alert-target-${rule.id}`}
                  />
                ) : (
                  <button
                    type="button"
                    className="alert-btn alert-btn--small"
                    disabled={
                      busy || rule.targets.length >= MAX_TARGETS_PER_RULE
                    }
                    aria-label={`Add target to ${rule.name}`}
                    onClick={() => {
                      setFormError(null);
                      setOpenForm({ kind: "target", ruleId: rule.id });
                    }}
                  >
                    Add target
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </>
    );
  }

  return (
    <section className="alert-section" aria-labelledby="alert-rules-heading">
      {header}

      {/*
        One polite live region for the whole panel, as the banners above are:
        these messages follow something the visitor just did, so they are worth
        announcing, but never worth interrupting a screen reader mid-sentence.
      */}
      <p className="alert-section__status" role="status">
        {notice}
      </p>
      {/*
        Row-level failures — a toggle or a delete — have no form to attach to,
        so they surface here rather than vanishing. Failures that belong to an
        open form are shown inside it as well, against the field at fault.
      */}
      {actionError && openForm === null && (
        <p className="alert-section__note alert-section__note--error" role="alert">
          {actionError}
        </p>
      )}

      {body()}
    </section>
  );
}
