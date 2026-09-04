import type { Network } from "./horizon.js";
import { logger } from "./logger.js";
import { getCongestionAlertThreshold } from "./metrics.js";

/*
 * Outbound congestion alerting.
 *
 * Sending the request is the easy half. The hard half is not spamming: a
 * network sitting at the threshold must not fire on every poll, and one
 * oscillating around it must not produce a storm. Two independent mechanisms
 * handle two genuinely different failure modes.
 *
 *   Hysteresis  Entering the alerting state needs usage >= threshold, but
 *               leaving it needs usage < threshold - band. A value flickering
 *               0.799 / 0.801 / 0.799 crosses the entry line repeatedly and
 *               the exit line never, so it produces exactly one alert.
 *
 *   Cooldown    Hysteresis cannot help a value that genuinely swings wide —
 *               0.70 to 0.85 and back every few minutes clears both lines
 *               honestly. The cooldown puts a floor on the time between
 *               alerts for a network, bounding the worst case to one alert
 *               plus one recovery per cooldown window.
 *
 * Two rules keep the pairing coherent:
 *
 *   - The state machine always advances, even when a notification is
 *     suppressed. State never drifts from what the network is actually doing.
 *   - A recovery is sent only if the alert that opened the episode was
 *     actually delivered, and when it is sent it is never suppressed. A
 *     "resolved" with no preceding alert is confusing; an alert left
 *     unresolved in a channel is worse, because it reads as an ongoing
 *     problem that has in fact passed.
 */

export type AlertKind = "alert" | "recovery";

export interface AlertEvent {
  kind: AlertKind;
  network: Network;
  /** Ledger capacity usage that triggered this, 0-1. */
  usage: number;
  /** The threshold crossed, for context in the message. */
  threshold: number;
  timestamp: string;
}

export interface AlertState {
  status: "ok" | "alerting";
  /**
   * Whether the alert opening the current episode actually went out. False
   * when the cooldown suppressed it, which is what stops a recovery being
   * sent for an alert nobody saw.
   */
  notified: boolean;
  /** When a notification was last emitted for this network, epoch ms. */
  lastNotificationAt: number | null;
}

export interface AlertOptions {
  threshold: number;
  /** How far below the threshold usage must fall to clear the alert. */
  hysteresis: number;
  /** Minimum gap between alerts for one network, in ms. */
  cooldownMs: number;
}

export const initialAlertState: AlertState = {
  status: "ok",
  notified: false,
  lastNotificationAt: null,
};

/**
 * The whole decision, as a pure function: given where a network was and what
 * it is doing now, where does it go and what should be sent?
 *
 * Pure so the state machine can be tested exhaustively without a webhook, a
 * clock, or a network anywhere near it.
 */
export function nextAlertState(
  prev: AlertState,
  usage: number | null,
  network: Network,
  options: AlertOptions,
  now: number,
): { state: AlertState; event: AlertEvent | null } {
  /*
   * Unknown usage is not "recovered". A Horizon outage leaves us with no
   * reading, and treating that as a return to normal would clear a real alert
   * precisely when the data needed to confirm it is missing.
   */
  if (usage === null || !Number.isFinite(usage)) {
    return { state: prev, event: null };
  }

  const clearBelow = options.threshold - options.hysteresis;
  const timestamp = new Date(now).toISOString();

  if (prev.status === "ok" && usage >= options.threshold) {
    const cooledDown =
      prev.lastNotificationAt === null || now - prev.lastNotificationAt >= options.cooldownMs;

    return {
      state: {
        status: "alerting",
        notified: cooledDown,
        lastNotificationAt: cooledDown ? now : prev.lastNotificationAt,
      },
      event: cooledDown
        ? { kind: "alert", network, usage, threshold: options.threshold, timestamp }
        : null,
    };
  }

  if (prev.status === "alerting" && usage < clearBelow) {
    return {
      state: {
        status: "ok",
        notified: false,
        lastNotificationAt: prev.notified ? now : prev.lastNotificationAt,
      },
      event: prev.notified
        ? { kind: "recovery", network, usage, threshold: options.threshold, timestamp }
        : null,
    };
  }

  return { state: prev, event: null };
}

export type WebhookFormat = "generic" | "discord" | "slack";

const DISCORD_COLOR = { alert: 0xf5615c, recovery: 0x3ecf8e } as const;

function describe(event: AlertEvent): string {
  const pct = `${(event.usage * 100).toFixed(1)}%`;
  const limit = `${(event.threshold * 100).toFixed(0)}%`;
  return event.kind === "alert"
    ? `Stellar ${event.network} congestion is ${pct}, above the ${limit} alert threshold. Transactions may see surge pricing or delayed inclusion.`
    : `Stellar ${event.network} congestion has recovered to ${pct}, below the ${limit} alert threshold.`;
}

/**
 * Shapes the event for whichever service is on the other end. Discord and
 * Slack both reject bodies they do not recognise, so a single generic payload
 * would work with neither.
 */
export function formatPayload(event: AlertEvent, format: WebhookFormat): unknown {
  const text = describe(event);

  if (format === "discord") {
    return {
      content: text,
      embeds: [
        {
          title:
            event.kind === "alert"
              ? "High network congestion"
              : "Network congestion recovered",
          description: text,
          color: DISCORD_COLOR[event.kind],
          timestamp: event.timestamp,
          fields: [
            { name: "Network", value: event.network, inline: true },
            {
              name: "Capacity usage",
              value: `${(event.usage * 100).toFixed(1)}%`,
              inline: true,
            },
            {
              name: "Threshold",
              value: `${(event.threshold * 100).toFixed(0)}%`,
              inline: true,
            },
          ],
        },
      ],
    };
  }

  if (format === "slack") {
    return {
      // Plain text as well as blocks: it is what Slack shows in the
      // notification and in clients that do not render blocks.
      text,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: `*${
            event.kind === "alert"
              ? "High network congestion"
              : "Network congestion recovered"
          }*\n${text}` },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `network: \`${event.network}\` · usage: \`${(event.usage * 100).toFixed(1)}%\` · threshold: \`${(event.threshold * 100).toFixed(0)}%\` · ${event.timestamp}`,
            },
          ],
        },
      ],
    };
  }

  return {
    event: event.kind === "alert" ? "congestion.alert" : "congestion.recovery",
    network: event.network,
    ledgerCapacityUsage: event.usage,
    threshold: event.threshold,
    timestamp: event.timestamp,
    message: text,
  };
}

export interface AlertConfig {
  webhookUrl: string;
  format: WebhookFormat;
  options: AlertOptions;
  timeoutMs: number;
}

const DEFAULT_HYSTERESIS = 0.05;
const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5000;

function parseFormat(raw: string | undefined): WebhookFormat {
  const value = raw?.trim().toLowerCase();
  if (value === "discord" || value === "slack") return value;
  return "generic";
}

function parseNumber(raw: string | undefined, fallback: number, min: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

/**
 * Reads alert configuration from the environment. Returns null when no webhook
 * URL is set, which is how alerting stays entirely off by default — nothing
 * else in the backend behaves differently for its absence.
 */
export function getAlertConfig(): AlertConfig | null {
  const webhookUrl = process.env.ALERT_WEBHOOK_URL?.trim();
  if (!webhookUrl) return null;

  return {
    webhookUrl,
    format: parseFormat(process.env.ALERT_WEBHOOK_FORMAT),
    options: {
      threshold: getCongestionAlertThreshold(),
      hysteresis: parseNumber(process.env.ALERT_HYSTERESIS, DEFAULT_HYSTERESIS, 0),
      cooldownMs: parseNumber(process.env.ALERT_COOLDOWN_MS, DEFAULT_COOLDOWN_MS, 0),
    },
    timeoutMs: parseNumber(process.env.ALERT_WEBHOOK_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1),
  };
}

/**
 * POSTs one event. Never throws: a webhook that is unreachable, slow, or
 * returning 500 must not take down the poller or interrupt metric collection,
 * so every failure is logged and swallowed.
 */
export async function deliverAlert(event: AlertEvent, config: AlertConfig): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const res = await fetch(config.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formatPayload(event, config.format)),
      signal: controller.signal,
    });

    if (!res.ok) {
      logger.warn("Congestion alert webhook rejected the request", {
        component: "alerts",
        network: event.network,
        kind: event.kind,
        status: res.status,
      });
      return false;
    }

    logger.info("Congestion alert delivered", {
      component: "alerts",
      network: event.network,
      kind: event.kind,
      usage: event.usage,
    });
    return true;
  } catch (err) {
    logger.warn("Congestion alert webhook failed", {
      component: "alerts",
      network: event.network,
      kind: event.kind,
      err,
    });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/*
 * Per-network state. Separate entries so a mainnet episode can never suppress
 * or trigger a testnet one.
 */
const alertStates = new Map<Network, AlertState>();

function stateFor(network: Network): AlertState {
  return alertStates.get(network) ?? initialAlertState;
}

/** Test seam: drops all remembered alert state. */
export function resetAlertState(): void {
  alertStates.clear();
}

/** Test seam: what the machine currently believes about a network. */
export function getAlertState(network: Network): AlertState {
  return stateFor(network);
}

/**
 * Advances the state machine for one network and, if the transition warrants
 * it, sends the notification.
 *
 * Delivery is deliberately not awaited by the caller: the state transition is
 * synchronous and already recorded by the time this returns its promise, so a
 * webhook taking five seconds cannot delay a poll. The returned promise exists
 * for tests, which do await it.
 */
export async function evaluateCongestionAlert(
  network: Network,
  usage: number | null,
  now: number = Date.now(),
): Promise<AlertEvent | null> {
  const config = getAlertConfig();
  if (!config) return null;

  const { state, event } = nextAlertState(
    stateFor(network),
    usage,
    network,
    config.options,
    now,
  );
  alertStates.set(network, state);

  if (!event) return null;

  await deliverAlert(event, config);
  return event;
}
