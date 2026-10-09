import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI simple screen and Advanced switch" });
const viewport = { height: 900, width: 1280 };
const storedLayout = {
  sidebarAgentsMode: "chip",
  sidebarEntries: ["route:usage", "route:plugins"],
} as const;

async function openSimpleScreen(page: Page, path: string, routeId: string) {
  const settingsKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
  await page.addInitScript(
    ({ key, layout }) => {
      if (localStorage.getItem(key) === null) {
        localStorage.setItem(key, JSON.stringify({ ...layout, advancedUi: false }));
      }
    },
    { key: settingsKey, layout: storedLayout },
  );
  await installMockGateway(page);
  await page.goto(`${suite.server.baseUrl}${path}`);
  await waitForControlUiRoute(page, { routeId });
  return {
    stored: () =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, unknown>,
        settingsKey,
      ),
  };
}

suite.define(() => {
  it("hides advanced controls until Advanced is turned on, then restores them in place", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport },
      async ({ page }) => {
        const { stored } = await openSimpleScreen(page, "chat", "chat");
        const sidebar = page.locator("openclaw-app-sidebar");
        const routeEntries = sidebar.locator('.sidebar-zone-entry[data-sidebar-entry^="route:"]');
        const header = page.locator(".chat-pane-cache__pane--active .chat-pane__header");
        const composer = page.locator(".chat-pane-cache__pane--active .agent-chat__input");
        const textarea = composer.locator(".agent-chat__composer-combobox textarea");
        const addMenu = composer.locator("wa-dropdown.agent-chat__capability-menu");
        const slashMenu = composer.locator(".slash-menu[role='listbox']");
        const addMenuOpen = () =>
          addMenu.evaluate((node) => (node as HTMLElement & { open: boolean }).open);

        // Simple screen: bots list, a static brand, no page links, a bot header
        // instead of crumbs and panel controls, and no composer pickers.
        await expect
          .poll(() => sidebar.locator(".sidebar-workspace-header__main--static").textContent())
          .toMatch(/BotClaw/);
        expect(await sidebar.locator(".sidebar-agent-card__main").count()).toBe(0);
        expect(await routeEntries.count()).toBe(0);
        await expect.poll(() => header.locator("openclaw-agent-identity").count()).toBe(1);
        expect(await composer.locator(".agent-chat__composer-controls").count()).toBe(0);

        // Typing "/" opens the + menu instead of the command list.
        await textarea.click();
        await page.keyboard.type("/");
        await expect.poll(addMenuOpen).toBe(true);
        expect(await textarea.inputValue()).toBe("");
        expect(await slashMenu.count()).toBe(0);
        await page.keyboard.press("Escape");
        await expect.poll(addMenuOpen).toBe(false);

        await sidebar.locator(".sidebar-identity-card").click();
        await sidebar
          .locator('.sidebar-identity-menu wa-dropdown-item[value="command:advanced"]')
          .click();

        // Advanced: the stored chip layout and page links come back without a
        // reload, and "/" lists commands again.
        await expect
          .poll(() => sidebar.locator(".sidebar-agent-card__main").isVisible())
          .toBe(true);
        await expect.poll(() => routeEntries.count()).toBe(2);
        await expect.poll(() => header.locator("openclaw-agent-identity").count()).toBe(0);
        await expect.poll(() => composer.locator(".agent-chat__composer-controls").count()).toBe(1);
        await textarea.click();
        await page.keyboard.type("/");
        await expect.poll(() => slashMenu.isVisible()).toBe(true);
        expect(await addMenuOpen()).toBe(false);

        expect(await stored()).toMatchObject({ ...storedLayout, advancedUi: true });
      },
    );
  });

  it("keeps the new chat page and settings list short on the simple screen", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport },
      async ({ page }) => {
        await openSimpleScreen(page, "new", "new-session");
        const composer = page.locator(".new-session-page__composer");
        await composer.waitFor();
        expect(await page.locator(".new-session-page__triggers").count()).toBe(0);
        expect(await composer.locator('[data-chat-model-select="true"]').count()).toBe(0);

        await page.goto(`${suite.server.baseUrl}settings/about`);
        await waitForControlUiRoute(page, { routeId: "about" });
        await expect
          .poll(() => page.locator(".settings-sidebar__item-label").allTextContents())
          .toEqual([
            "Ask BotClaw",
            "Profile",
            "Appearance",
            "Notifications",
            "Devices",
            "Agents",
            "Models",
            "Approvals",
            "About",
          ]);
      },
    );
  });
});
