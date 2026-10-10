import { expect, it } from "vitest";
import type { AgentsListResult, GatewaySessionRow } from "../api/types.ts";
import { clawDelegationMockInitScript } from "../test-helpers/control-ui-e2e-claws.ts";
import {
  controlUiBundledSettingsStorageKey,
  defaultControlUiFeatureMethods,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "BotClaw Run a Claw from Details" });
const desktop = {
  locale: "en-US",
  serviceWorkers: "block",
  viewport: { width: 1280, height: 900 },
} as const;

const agentsList: AgentsListResult = {
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: [
    { id: "main", name: "Harbor" },
    { id: "brief", name: "Morning Brief", claw: { requesterAgentIds: ["main"] } },
  ],
};
const rows = [
  { key: "agent:main:main", kind: "direct", agentId: "main", isMain: true },
] satisfies GatewaySessionRow[];

suite.define(() => {
  it("runs an unscheduled Claw with a task from Details and shows its result in the chat", async () => {
    await suite.withPage(desktop, async ({ page }) => {
      await page.addInitScript(
        ({ key }) => localStorage.setItem(key, JSON.stringify({ advancedUi: false })),
        { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl) },
      );
      const gateway = await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "sessions.delegate"],
        sessions: rows,
        historyMessages: [
          { role: "user", content: [{ type: "text", text: "What's on today?" }] },
          { role: "assistant", content: [{ type: "text", text: "Two meetings so far." }] },
        ],
        methodResponses: {
          "agents.list": agentsList,
          // No routines anywhere: Morning Brief runs only when asked.
          "cron.list": cronListResponseFixture({
            jobs: [],
            snapshotRevision: "no-jobs",
            total: 0,
            offset: 0,
            limit: 50,
            hasMore: false,
            nextOffset: null,
          }),
        },
      });
      await page.addInitScript({
        content: clawDelegationMockInitScript({
          brief: { label: "Morning Brief", reply: "Today's brief: 3 meetings and 2 deadlines." },
        }),
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await waitForControlUiRoute(page, { routeId: "chat" });

      const harbor = page.locator('[data-agent-group="main"]');
      await harbor.locator(".sidebar-agent-roster__row").click({ button: "right" });
      await harbor.getByRole("menuitem", { name: "Show details", exact: true }).click();
      const pane = page.locator(".chat-pane-cache__pane--active");
      const claw = pane.locator('[data-panel-slot="agent"] [data-claw-id="brief"]');
      await claw.getByText("No schedule yet").waitFor();
      await claw.getByRole("button", { name: "Run Morning Brief", exact: true }).click();

      const dialog = page.locator("openclaw-modal-dialog form.claw-task-dialog");
      await dialog
        .getByRole("textbox", { name: "What should Morning Brief do?" })
        .fill("Write today's brief");
      await dialog.getByRole("button", { name: "Run", exact: true }).click();
      await dialog.waitFor({ state: "detached" });

      const card = pane.locator('.chat-group--forwarded[data-result-status="ok"]');
      await card.waitFor({ state: "visible" });
      expect(await card.locator(".chat-reply-attribution__task").textContent()).toBe(
        "Task: Write today's brief",
      );
      expect(await card.textContent()).toContain("3 meetings and 2 deadlines");
      const [delegated] = await gateway.getRequests("sessions.delegate");
      expect(delegated?.params).toMatchObject({
        sessionKey: "agent:main:main",
        sessionId: expect.any(String),
        targetAgentId: "brief",
        task: "Write today's brief",
      });
    });
  });
});
