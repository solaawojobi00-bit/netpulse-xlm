/*
 * The alert rule panel (#214) driven through its own controls, against the
 * real HTTP test server rather than a stubbed client: each case asserts what
 * the visitor sees and what the server ended up holding.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startAlertRuleServer,
  startLegacyBackend,
  type AlertRuleTestServer,
} from "../test/alertRuleServer";

let server: AlertRuleTestServer;
let Panel: typeof import("./AlertRulesPanel").AlertRulesPanel;

async function loadPanel(origin: string) {
  vi.stubEnv("VITE_API_URL", origin);
  vi.resetModules();
  ({ AlertRulesPanel: Panel } = await import("./AlertRulesPanel"));
}

beforeEach(async () => {
  server = await startAlertRuleServer();
  await loadPanel(server.url);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await server.close();
});

describe("AlertRulesPanel", () => {
  it("lists the rules for the network and says so when there are none", async () => {
    server.seed({ name: "Mainnet congestion", network: "mainnet" });
    const { unmount } = render(<Panel network="mainnet" />);
    expect(
      await screen.findByRole("heading", { name: "Mainnet congestion" }),
    ).toBeInTheDocument();
    unmount();

    render(<Panel network="testnet" />);
    expect(await screen.findByText(/No alert rules on testnet/)).toBeVisible();
  });

  it("creates a rule, and refuses a bad threshold before asking the server", async () => {
    const user = userEvent.setup();
    render(<Panel network="mainnet" />);
    await user.click(await screen.findByRole("button", { name: "New rule" }));

    await user.type(screen.getByLabelText("Rule name"), "Busy ledgers");
    await user.type(screen.getByLabelText("Threshold"), "5");
    await user.click(screen.getByRole("button", { name: "Create rule" }));
    expect(server.rules()).toHaveLength(0);
    expect(document.querySelector(".alert-field__error")).not.toBeNull();

    await user.clear(screen.getByLabelText("Threshold"));
    await user.type(screen.getByLabelText("Threshold"), "0.8");
    await user.click(screen.getByRole("button", { name: "Create rule" }));

    expect(
      await screen.findByRole("heading", { name: "Busy ledgers" }),
    ).toBeInTheDocument();
    expect(server.rules().map((r) => r.name)).toEqual(["Busy ledgers"]);
  });

  it("edits, disables and deletes a rule", async () => {
    const user = userEvent.setup();
    const id = server.seed({ name: "Slow ledgers", metric: "closeTime" });
    render(<Panel network="mainnet" />);

    await user.click(
      await screen.findByRole("button", { name: "Edit rule Slow ledgers" }),
    );
    const name = screen.getByLabelText("Rule name");
    await user.clear(name);
    await user.type(name, "Sluggish ledgers");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("heading", { name: "Sluggish ledgers" });
    expect(server.rule(id)?.name).toBe("Sluggish ledgers");

    await user.click(
      screen.getByRole("button", { name: "Disable rule Sluggish ledgers" }),
    );
    await screen.findByRole("button", {
      name: "Enable rule Sluggish ledgers",
    });
    expect(server.rule(id)?.enabled).toBe(false);

    await user.click(
      screen.getByRole("button", { name: "Delete rule Sluggish ledgers" }),
    );
    await user.click(screen.getByRole("button", { name: "Keep it" }));
    expect(server.rules()).toHaveLength(1);

    await user.click(
      screen.getByRole("button", { name: "Delete rule Sluggish ledgers" }),
    );
    await user.click(screen.getByRole("button", { name: "Delete rule" }));
    await screen.findByText(/No alert rules on mainnet/);
    expect(server.rules()).toHaveLength(0);
  });

  it("adds, disables and removes a delivery target", async () => {
    const user = userEvent.setup();
    const id = server.seed({ name: "Fees" });
    render(<Panel network="mainnet" />);

    await user.click(
      await screen.findByRole("button", { name: "Add target to Fees" }),
    );
    await user.click(screen.getByRole("button", { name: "Add target" }));
    expect(server.rule(id)?.targets).toHaveLength(0);

    await user.type(
      screen.getByLabelText("Webhook URL"),
      "https://hooks.example.com/secret",
    );
    await user.click(screen.getByRole("button", { name: "Add target" }));
    await screen.findByText("https://hooks.example.com/***");
    expect(server.rule(id)?.targets).toHaveLength(1);

    await user.click(
      screen.getByRole("button", {
        name: "Disable delivery to https://hooks.example.com/***",
      }),
    );
    await screen.findByRole("button", {
      name: "Enable delivery to https://hooks.example.com/***",
    });
    expect(server.rule(id)?.targets[0]?.enabled).toBe(false);

    await user.click(
      screen.getByRole("button", {
        name: "Remove delivery to https://hooks.example.com/***",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Keep it" }));
    await user.click(
      screen.getByRole("button", {
        name: "Remove delivery to https://hooks.example.com/***",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Remove target" }));
    await screen.findByText(/No targets yet/);
    expect(server.rule(id)?.targets).toHaveLength(0);
  });

  it("offers a retry when the list fails to load", async () => {
    const user = userEvent.setup();
    server.seed({ name: "Recovered" });
    server.failNext();
    render(<Panel network="mainnet" />);

    await user.click(await screen.findByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("heading", { name: "Recovered" }),
    ).toBeInTheDocument();
  });

  it("says the API is missing when the backend predates it", async () => {
    const legacy = await startLegacyBackend();
    try {
      await loadPanel(legacy.url);
      render(<Panel network="mainnet" />);
      expect(
        await screen.findByText(
          /does not expose the alert rule management API/,
        ),
      ).toBeVisible();
    } finally {
      await legacy.close();
    }
  });
});
