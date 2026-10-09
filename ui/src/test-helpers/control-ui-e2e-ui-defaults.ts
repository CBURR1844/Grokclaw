import type { BrowserContext, Page } from "playwright";

/**
 * BotClaw opens the simple screen with the bot roster. Mocked scenarios were
 * written for OpenClaw's full screen and agent chip, so pages and contexts that
 * install the mock Gateway restore those defaults; BotClaw scenarios opt in
 * through stored settings. The mock dev server keeps BotClaw's defaults.
 */
export async function pinUpstreamUiDefaults(target: Page | BrowserContext): Promise<void> {
  await target.addInitScript(() => {
    (globalThis as { openclawUpstreamUiDefaults?: boolean }).openclawUpstreamUiDefaults = true;
  });
}
