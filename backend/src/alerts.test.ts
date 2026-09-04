import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AlertOptions,
  type AlertState,
  deliverAlert,
  evaluateCongestionAlert,
  formatPayload,
  getAlertConfig,
  getAlertState,
  initialAlertState,
  nextAlertState,
  resetAlertState,
} from "./alerts.js";

const OPTS: AlertOptions = { threshold: 0.8, hysteresis: 0.05, cooldownMs: 60_000 };

/** Feeds a series of readings through the machine, collecting what it sent. */
function run(
  readings: (number | null)[],
  opts: AlertOptions = OPTS,
  startAt = 0,
  stepMs = 1_000,
) {
  let state: AlertState = initialAlertState;
  const events: string[] = [];
  readings.forEach((usage, i) => {
    const result = nextAlertState(state, usage, "mainnet", opts, startAt + i * stepMs);
    state = result.state;
    if (result.event) events.push(result.event.kind);
  });
  return { state, events };
}

describe("nextAlertState: edge triggering", () => {
  it("fires once when usage crosses the threshold", () => {
    expect(run([0.5, 0.9]).events).toEqual(["alert"]);
  });

  it("does not re-fire while usage stays above the threshold", () => {
    // The defect this exists to prevent: one alert per poll for as long as the
    // network is busy.
    const { events } = run([0.9, 0.91, 0.95, 0.99, 0.85]);
    expect(events).toEqual(["alert"]);
  });

  it("fires exactly at the threshold, not just above it", () => {
    expect(run([0.5, 0.8]).events).toEqual(["alert"]);
  });

  it("does not fire just below the threshold", () => {
    expect(run([0.5, 0.799]).events).toEqual([]);
  });

  it("sends a recovery when usage drops clear of the threshold", () => {
    expect(run([0.9, 0.5]).events).toEqual(["alert", "recovery"]);
  });

  it("can alert again after a genuine recovery, once the cooldown has passed", () => {
    // 0.9 -> 0.5 -> 0.9, with each step a full cooldown apart.
    const { events } = run([0.9, 0.5, 0.9], OPTS, 0, 70_000);
    expect(events).toEqual(["alert", "recovery", "alert"]);
  });

  it("counts the cooldown from the last notification of either kind", () => {
    /*
     * The recovery restarts the clock, so a network that recovers and
     * immediately spikes again waits a full cooldown before re-alerting.
     * Measuring from the last alert instead would let an alert/recovery pair
     * land twice as often. This is the stricter of the two readings and the
     * easier one to state: at most one alert per cooldown, per network.
     */
    const { events } = run([0.9, 0.5, 0.9], OPTS, 0, 40_000);
    expect(events).toEqual(["alert", "recovery"]);
  });
});

describe("nextAlertState: hysteresis", () => {
  it("does not clear inside the hysteresis band", () => {
    // 0.78 is below the 0.8 threshold but above the 0.75 clear line.
    const { events, state } = run([0.9, 0.78]);
    expect(events).toEqual(["alert"]);
    expect(state.status).toBe("alerting");
  });

  it("survives a value flickering around the threshold without a storm", () => {
    // The classic case: repeated crossings of the entry line, never the exit.
    const flicker = [0.801, 0.799, 0.801, 0.799, 0.801, 0.799, 0.802];
    expect(run(flicker).events).toEqual(["alert"]);
  });

  it("clears once usage falls below threshold minus the band", () => {
    expect(run([0.9, 0.749]).events).toEqual(["alert", "recovery"]);
  });

  it("treats zero hysteresis as clearing at the threshold itself", () => {
    const opts = { ...OPTS, hysteresis: 0 };
    expect(run([0.9, 0.79], opts).events).toEqual(["alert", "recovery"]);
  });
});

describe("nextAlertState: cooldown", () => {
  it("suppresses a second alert inside the cooldown window", () => {
    // Wide swings clear both lines honestly, so hysteresis cannot help here.
    const { events } = run([0.9, 0.5, 0.9, 0.5], OPTS, 0, 1_000);
    expect(events).toEqual(["alert", "recovery"]);
  });

  it("still advances state when it suppresses a notification", () => {
    // State must never drift from what the network is doing, or a later
    // transition is evaluated against a fiction.
    const { state } = run([0.9, 0.5, 0.9], OPTS, 0, 1_000);
    expect(state.status).toBe("alerting");
  });

  it("does not send a recovery for an alert that was suppressed", () => {
    // "Resolved" with no preceding alert is noise in a channel.
    const { events } = run([0.9, 0.5, 0.9, 0.5], OPTS, 0, 1_000);
    expect(events.filter((e) => e === "recovery")).toHaveLength(1);
  });

  it("never suppresses a recovery for an alert that was delivered", () => {
    // An unresolved alert reads as an ongoing problem that has in fact passed,
    // which is worse than one extra message.
    const { events } = run([0.9, 0.5], { ...OPTS, cooldownMs: 3_600_000 });
    expect(events).toEqual(["alert", "recovery"]);
  });

  it("bounds a rapidly oscillating network to one alert per cooldown", () => {
    const oscillation = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 0.95 : 0.4));
    // 40 readings a second apart is well inside one 60s cooldown.
    const { events } = run(oscillation, OPTS, 0, 1_000);
    expect(events.filter((e) => e === "alert")).toHaveLength(1);
  });
});

describe("nextAlertState: missing readings", () => {
  it("treats unknown usage as no information, not as recovery", () => {
    // A Horizon outage must not clear a real alert.
    const { state, events } = run([0.9, null, null]);
    expect(events).toEqual(["alert"]);
    expect(state.status).toBe("alerting");
  });

  it("ignores a non-finite reading", () => {
    const { events } = run([Number.NaN, Number.POSITIVE_INFINITY]);
    expect(events).toEqual([]);
  });

  it("stays quiet on a network that never gets busy", () => {
    expect(run([0.1, 0.2, 0.3, 0.4, 0.5, 0.1]).events).toEqual([]);
  });
});

describe("nextAlertState: event contents", () => {
  it("carries network, usage, threshold and a timestamp", () => {
    const at = Date.UTC(2026, 8, 4, 12, 0, 0);
    const { event } = nextAlertState(initialAlertState, 0.93, "testnet", OPTS, at);

    expect(event).toEqual({
      kind: "alert",
      network: "testnet",
      usage: 0.93,
      threshold: 0.8,
      timestamp: "2026-09-04T12:00:00.000Z",
    });
  });
});

describe("payload formats", () => {
  const event = {
    kind: "alert" as const,
    network: "mainnet" as const,
    usage: 0.88,
    threshold: 0.8,
    timestamp: "2026-09-04T12:00:00.000Z",
  };

  it("produces a flat generic body", () => {
    expect(formatPayload(event, "generic")).toEqual({
      event: "congestion.alert",
      network: "mainnet",
      ledgerCapacityUsage: 0.88,
      threshold: 0.8,
      timestamp: "2026-09-04T12:00:00.000Z",
      message: expect.stringContaining("88.0%"),
    });
  });

  it("produces a Discord embed with content as the fallback text", () => {
    const body = formatPayload(event, "discord") as {
      content: string;
      embeds: { title: string; fields: { name: string; value: string }[] }[];
    };

    expect(body.content).toContain("mainnet");
    expect(body.embeds).toHaveLength(1);
    expect(body.embeds[0].title).toBe("High network congestion");
    expect(body.embeds[0].fields.map((f) => f.name)).toEqual([
      "Network",
      "Capacity usage",
      "Threshold",
    ]);
  });

  it("produces Slack blocks with plain text alongside them", () => {
    const body = formatPayload(event, "slack") as { text: string; blocks: unknown[] };

    // `text` is what Slack shows in the notification and in clients that do
    // not render blocks, so it must not be omitted.
    expect(body.text).toContain("88.0%");
    expect(body.blocks).toHaveLength(2);
  });

  it("says recovered, not congested, on a recovery", () => {
    const recovery = { ...event, kind: "recovery" as const, usage: 0.4 };

    const generic = formatPayload(recovery, "generic") as { event: string; message: string };
    expect(generic.event).toBe("congestion.recovery");
    expect(generic.message).toContain("recovered");

    const discord = formatPayload(recovery, "discord") as { embeds: { title: string }[] };
    expect(discord.embeds[0].title).toBe("Network congestion recovered");
  });
});

describe("configuration", () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it("is disabled when no webhook URL is set", () => {
    delete process.env.ALERT_WEBHOOK_URL;
    expect(getAlertConfig()).toBeNull();
  });

  it("is disabled when the webhook URL is blank", () => {
    process.env.ALERT_WEBHOOK_URL = "   ";
    expect(getAlertConfig()).toBeNull();
  });

  it("defaults the format to generic and falls back for an unknown one", () => {
    process.env.ALERT_WEBHOOK_URL = "https://example.test/hook";
    delete process.env.ALERT_WEBHOOK_FORMAT;
    expect(getAlertConfig()?.format).toBe("generic");

    process.env.ALERT_WEBHOOK_FORMAT = "carrier-pigeon";
    expect(getAlertConfig()?.format).toBe("generic");
  });

  it("accepts discord and slack case-insensitively", () => {
    process.env.ALERT_WEBHOOK_URL = "https://example.test/hook";
    process.env.ALERT_WEBHOOK_FORMAT = "DISCORD";
    expect(getAlertConfig()?.format).toBe("discord");
    process.env.ALERT_WEBHOOK_FORMAT = " Slack ";
    expect(getAlertConfig()?.format).toBe("slack");
  });

  it("reuses CONGESTION_ALERT_THRESHOLD rather than a second threshold", () => {
    process.env.ALERT_WEBHOOK_URL = "https://example.test/hook";
    process.env.CONGESTION_ALERT_THRESHOLD = "0.65";
    expect(getAlertConfig()?.options.threshold).toBe(0.65);
  });

  it("ignores nonsense cooldown and hysteresis values", () => {
    process.env.ALERT_WEBHOOK_URL = "https://example.test/hook";
    process.env.ALERT_COOLDOWN_MS = "not-a-number";
    process.env.ALERT_HYSTERESIS = "-1";

    const config = getAlertConfig();
    expect(config?.options.cooldownMs).toBe(15 * 60 * 1000);
    expect(config?.options.hysteresis).toBe(0.05);
  });
});

describe("delivery", () => {
  const config = {
    webhookUrl: "https://example.test/hook",
    format: "generic" as const,
    options: OPTS,
    timeoutMs: 5000,
  };

  const event = {
    kind: "alert" as const,
    network: "mainnet" as const,
    usage: 0.88,
    threshold: 0.8,
    timestamp: "2026-09-04T12:00:00.000Z",
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs JSON to the configured URL", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    await expect(deliverAlert(event, config)).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/hook");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body)).network).toBe("mainnet");
  });

  it("reports a rejection without throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("no", { status: 500 }));

    // A webhook returning 500 must not propagate into the poller.
    await expect(deliverAlert(event, config)).resolves.toBe(false);
  });

  it("swallows a network failure so the poller keeps running", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(deliverAlert(event, config)).resolves.toBe(false);
  });

  it("gives up on a webhook that never answers", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

    await expect(deliverAlert(event, { ...config, timeoutMs: 20 })).resolves.toBe(false);
  });
});

describe("evaluateCongestionAlert: per-network isolation", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    resetAlertState();
    process.env.ALERT_WEBHOOK_URL = "https://example.test/hook";
    process.env.ALERT_WEBHOOK_FORMAT = "generic";
    delete process.env.ALERT_COOLDOWN_MS;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
  });

  afterEach(() => {
    process.env = { ...saved };
    resetAlertState();
    vi.restoreAllMocks();
  });

  it("does not let a mainnet alert suppress a testnet one", async () => {
    await expect(evaluateCongestionAlert("mainnet", 0.95, 0)).resolves.toMatchObject({
      kind: "alert",
      network: "mainnet",
    });

    // Same instant, same cooldown — a shared cooldown would swallow this.
    await expect(evaluateCongestionAlert("testnet", 0.95, 0)).resolves.toMatchObject({
      kind: "alert",
      network: "testnet",
    });
  });

  it("tracks recovery per network", async () => {
    await evaluateCongestionAlert("mainnet", 0.95, 0);
    await evaluateCongestionAlert("testnet", 0.95, 0);

    await expect(evaluateCongestionAlert("mainnet", 0.2, 1_000)).resolves.toMatchObject({
      kind: "recovery",
      network: "mainnet",
    });

    // testnet is still busy and must be untouched by mainnet's recovery.
    expect(getAlertState("testnet").status).toBe("alerting");
  });

  it("sends nothing at all when alerting is not configured", async () => {
    delete process.env.ALERT_WEBHOOK_URL;
    const fetchMock = vi.mocked(globalThis.fetch);

    await expect(evaluateCongestionAlert("mainnet", 0.99, 0)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not record state while disabled, so enabling later starts clean", async () => {
    delete process.env.ALERT_WEBHOOK_URL;
    await evaluateCongestionAlert("mainnet", 0.99, 0);

    expect(getAlertState("mainnet")).toEqual(initialAlertState);
  });
});

describe("wiring: a fee snapshot drives the alert", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    resetAlertState();
    process.env.ALERT_WEBHOOK_URL = "https://example.test/hook";
    process.env.CONGESTION_ALERT_THRESHOLD = "0.8";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
  });

  afterEach(() => {
    process.env = { ...saved };
    resetAlertState();
    vi.restoreAllMocks();
  });

  /** The shape addFeeSnapshot receives; only the usage matters here. */
  function snapshot(ledgerCapacityUsage: number) {
    return {
      fetchedAt: new Date().toISOString(),
      ledgerCapacityUsage,
      feeChargedP50: 100,
      feeChargedP90: 200,
      baseFeeStroops: 100,
      p10: 100,
      p50: 100,
      p90: 200,
      p99: 300,
    } as never;
  }

  it("evaluates congestion when a snapshot lands in the store", async () => {
    const { stores } = await import("./poller.js");

    stores.mainnet.addFeeSnapshot(snapshot(0.95));
    // Delivery is fire-and-forget so the poll is never blocked; yield once for it.
    await vi.waitFor(() => expect(getAlertState("mainnet").status).toBe("alerting"));

    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it("keys the alert to the store's own network", async () => {
    const { stores } = await import("./poller.js");

    stores.testnet.addFeeSnapshot(snapshot(0.95));
    await vi.waitFor(() => expect(getAlertState("testnet").status).toBe("alerting"));

    // A testnet snapshot must not move mainnet.
    expect(getAlertState("mainnet").status).toBe("ok");
  });
});
