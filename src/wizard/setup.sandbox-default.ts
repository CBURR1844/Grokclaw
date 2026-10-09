/** Onboarding default for sandboxed tool execution: on when a container engine can run it. */
import { isContainerEngineAvailable } from "../agents/sandbox/container-engine.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { t } from "./i18n/index.js";
import type { WizardPrompter } from "./prompts.js";

/**
 * Turns on `non-main` sandboxing when the operator has not chosen a mode and Docker answers.
 * The main DM session stays on the host, so a fresh install keeps working; group and channel
 * sessions, which carry the most prompt-injection risk, run contained. Without Docker the
 * config is left unchanged and the operator is told how to turn it on later.
 */
export async function applyOnboardingSandboxDefault(params: {
  config: OpenClawConfig;
  prompter: Pick<WizardPrompter, "note">;
  probeDocker?: () => Promise<boolean>;
}): Promise<OpenClawConfig> {
  const { config, prompter } = params;
  const defaults = config.agents?.defaults;
  if (defaults?.sandbox?.mode !== undefined) {
    return config;
  }
  const dockerAvailable = await (
    params.probeDocker ?? (() => isContainerEngineAvailable("docker"))
  )();
  if (!dockerAvailable) {
    await prompter.note(
      [
        t("wizard.sandbox.unavailable"),
        formatCliCommand("openclaw config set agents.defaults.sandbox.mode non-main"),
      ].join("\n"),
      t("wizard.sandbox.title"),
    );
    return config;
  }
  await prompter.note(t("wizard.sandbox.enabled"), t("wizard.sandbox.title"));
  return {
    ...config,
    agents: {
      ...config.agents,
      defaults: {
        ...defaults,
        sandbox: { ...defaults?.sandbox, mode: "non-main" },
      },
    },
  };
}
