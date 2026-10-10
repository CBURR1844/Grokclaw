import type { UiPreferences } from "./settings.ts";

/**
 * BotClaw opens the simple screen with the bot roster. OpenClaw's UI suites
 * were written for the full screen and the agent chip; their setup and mock
 * Gateway restore those defaults through this global.
 */
function upstreamUiDefaults(): boolean {
  return Reflect.get(globalThis, "openclawUpstreamUiDefaults") === true;
}

export function resolveSidebarAgentsMode(stored?: unknown): "chip" | "roster" {
  if (stored === "chip" || stored === "roster") {
    return stored;
  }
  return upstreamUiDefaults() ? "chip" : "roster";
}

/**
 * What the screen presents: the simple screen always shows the bot roster and
 * leaves the stored sidebar mode for when Advanced is turned back on.
 */
export function resolveUiPreset(
  settings: Pick<UiPreferences, "advancedUi" | "sidebarAgentsMode">,
): { advanced: boolean; sidebarAgentsMode: "chip" | "roster" } {
  const advanced = settings.advancedUi ?? upstreamUiDefaults();
  return {
    advanced,
    sidebarAgentsMode: advanced ? resolveSidebarAgentsMode(settings.sidebarAgentsMode) : "roster",
  };
}
