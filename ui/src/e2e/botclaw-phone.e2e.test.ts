import type { BrowserContext, Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { AgentsListResult, GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { clawDelegationMockInitScript } from "../test-helpers/control-ui-e2e-claws.ts";
import {
  controlUiBundledSettingsStorageKey,
  defaultControlUiFeatureMethods,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForMobileSidebarDrawerOpen } from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({ name: "BotClaw phone layout" });
const phone = {
  locale: "en-US",
  serviceWorkers: "block",
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
} as const;

const agentsList: AgentsListResult = {
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: [
    { id: "main", name: "Harbor" },
    { id: "forge", name: "Forge" },
    { id: "sorter", name: "Inbox Sorter", claw: { requesterAgentIds: ["main"] } },
  ],
};
const rows = [
  { key: "agent:main:main", kind: "direct", agentId: "main", isMain: true },
  { key: "agent:forge:main", kind: "direct", agentId: "forge", isMain: true },
] satisfies GatewaySessionRow[];

/** The simple screen on a phone, with a frozen clock so a hold lasts exactly as long as asked. */
async function openPhone(page: Page, context: BrowserContext) {
  await page.clock.install();
  await page.addInitScript(
    ({ key }) => {
      localStorage.setItem(key, JSON.stringify({ advancedUi: false }));
      // Chromium's own long-press menu is trusted; the iOS path this proves never is.
      Object.assign(window, { trustedMenus: 0 });
      addEventListener(
        "contextmenu",
        (event) => {
          if (event.isTrusted) {
            Reflect.set(window, "trustedMenus", Number(Reflect.get(window, "trustedMenus")) + 1);
          }
        },
        true,
      );
    },
    { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl) },
  );
  const gateway = await installMockGateway(page, {
    featureMethods: [...defaultControlUiFeatureMethods, "sessions.delegate"],
    sessions: rows,
    historyMessages: [
      { role: "user", content: [{ type: "text", text: "Sort my inbox" }] },
      { role: "assistant", content: [{ type: "text", text: "Done. 46 emails sorted." }] },
    ],
    methodResponses: {
      "agents.list": agentsList,
      "sessions.list": {
        ts: Date.now(),
        path: "",
        count: rows.length,
        defaults: { model: null, modelProvider: null, contextTokens: null },
        sessions: rows,
      } satisfies SessionsListResult,
    },
  });
  await page.addInitScript({
    content: clawDelegationMockInitScript({
      sorter: { label: "Inbox Sorter", reply: "Sorted 46 emails into 4 folders." },
    }),
  });
  await page.goto(`${suite.server.baseUrl}chat`);
  await waitForControlUiRoute(page, { routeId: "chat" });
  const touch = await context.newCDPSession(page);
  return {
    gateway,
    /** Holds a finger on the element for the long-press time and returns the lift. */
    hold: async (target: Locator) => {
      const box = await target.boundingBox();
      if (!box) {
        throw new Error("expected a visible long-press target");
      }
      const point = { x: box.x + Math.min(box.width / 2, 40), y: box.y + box.height / 2, id: 1 };
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
      await page.clock.runFor(500);
      return () => touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    },
    trustedMenus: () => page.evaluate(() => Number(Reflect.get(window, "trustedMenus"))),
  };
}

/** Waits out the opening animation, then checks the menu spans the bottom of the screen. */
async function expectSheet(
  read: () => Promise<{ x: number; width: number; y: number; height: number } | null>,
) {
  await expect
    .poll(async () => {
      const box = await read();
      return box && [box.x, box.width, box.y + box.height].map(Math.round);
    })
    .toEqual([0, 390, 844]);
}

suite.define(() => {
  it("opens a bot's menu by long press as a sheet, and its Details fill the screen", async () => {
    await suite.withPage(phone, async ({ page, context }) => {
      const { hold, trustedMenus } = await openPhone(page, context);
      await page.locator(".chat-pane__nav-toggle:visible").first().tap();
      await waitForMobileSidebarDrawerOpen(page);
      const forge = page.locator('[data-agent-group="forge"]');
      const dropdown = forge.locator("wa-dropdown.sidebar-agent-roster__menu");
      const menuBox = () =>
        dropdown.evaluate((element) => {
          const rect = element.shadowRoot?.querySelector('[part~="menu"]')?.getBoundingClientRect();
          return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
        });

      const pathname = new URL(page.url()).pathname;
      const lift = await hold(forge.locator(".sidebar-agent-roster__row"));
      await forge.getByRole("menuitem", { name: "Show details", exact: true }).waitFor();
      await expectSheet(menuBox);
      // Lifting the finger neither follows the row's link nor closes the menu.
      await lift();
      expect(new URL(page.url()).pathname).toBe(pathname);
      expect(
        await dropdown.evaluate((element: HTMLElement & { open: boolean }) => element.open),
      ).toBe(true);
      expect(await trustedMenus()).toBe(0);

      await forge.getByRole("menuitem", { name: "Show details", exact: true }).tap();
      const pane = page.locator(".chat-pane-cache__pane--active");
      const details = pane.locator('[data-panel-slot="agent"] .agent-details');
      await details.waitFor({ state: "visible" });
      await expect.poll(async () => (await details.boundingBox())?.width).toBeGreaterThan(380);
      expect(await pane.locator(".agent-chat__input").isVisible()).toBe(false);
      expect(await pane.locator(".side-panel__expand").isVisible()).toBe(false);

      // Close brings the chat back.
      await pane.locator(".side-panel__minimize").tap();
      await pane.locator(".agent-chat__input").waitFor({ state: "visible" });
      expect(await details.isVisible()).toBe(false);
    });
  });

  it("opens the message menu by long press as a sheet without revealing the message footer", async () => {
    await suite.withPage(phone, async ({ page, context }) => {
      const { hold, trustedMenus } = await openPhone(page, context);
      const bubble = page
        .locator(".chat-pane-cache__pane--active .chat-bubble")
        .filter({ hasText: "46 emails sorted" });
      await bubble.waitFor({ state: "visible" });

      const lift = await hold(bubble);
      const menu = page.locator(".chat-reply-context-menu");
      await menu.waitFor({ state: "visible" });
      await expectSheet(() => menu.boundingBox());
      await lift();
      await page.clock.runFor(1_000);
      expect(await menu.isVisible()).toBe(true);
      expect(await page.locator(".chat-group--meta-revealed, .chat-selection-popup").count()).toBe(
        0,
      );
      expect(await page.evaluate(() => getSelection()?.isCollapsed ?? true)).toBe(true);
      expect(await trustedMenus()).toBe(0);
    });
  });

  it("sends a message to a Claw from the long-press sheet and shows the Claw's result", async () => {
    await suite.withPage(phone, async ({ page, context }) => {
      const { gateway, hold } = await openPhone(page, context);
      const pane = page.locator(".chat-pane-cache__pane--active");
      const request = pane.locator(".chat-bubble").filter({ hasText: "Sort my inbox" });
      await request.waitFor({ state: "visible" });

      const lift = await hold(request);
      const send = page
        .locator(".chat-reply-context-menu")
        .getByRole("menuitem", { name: "Send to Inbox Sorter", exact: true });
      await send.waitFor({ state: "visible" });
      await lift();
      await send.tap();

      const card = pane.locator('.chat-group--forwarded[data-result-status="ok"]');
      await card.waitFor({ state: "visible" });
      expect(await card.locator(".chat-reply-attribution__task").textContent()).toBe(
        "Task: Sort my inbox",
      );
      expect(await card.textContent()).toContain("Sorted 46 emails into 4 folders.");
      const [delegated] = await gateway.getRequests("sessions.delegate");
      expect(delegated?.params).toMatchObject({
        sessionKey: "agent:main:main",
        targetAgentId: "sorter",
        task: "Sort my inbox",
      });
    });
  });
});
