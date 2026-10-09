import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyOnboardingSandboxDefault } from "./setup.sandbox-default.js";

function prompter() {
  return { note: vi.fn(async () => {}) };
}

describe("applyOnboardingSandboxDefault", () => {
  it("sandboxes non-main sessions when Docker answers", async () => {
    const p = prompter();
    const config: OpenClawConfig = { agents: { defaults: { workspace: "/w" } } };
    const next = await applyOnboardingSandboxDefault({
      config,
      prompter: p,
      probeDocker: async () => true,
    });
    expect(next.agents?.defaults?.sandbox?.mode).toBe("non-main");
    expect(next.agents?.defaults?.workspace).toBe("/w");
    expect(p.note).toHaveBeenCalledOnce();
  });

  it("leaves config unchanged and explains the next step without Docker", async () => {
    const p = prompter();
    const config: OpenClawConfig = {};
    const next = await applyOnboardingSandboxDefault({
      config,
      prompter: p,
      probeDocker: async () => false,
    });
    expect(next).toBe(config);
    expect(p.note.mock.calls[0]?.[0]).toContain("agents.defaults.sandbox.mode non-main");
  });

  it("keeps an operator's explicit choice without probing", async () => {
    const probeDocker = vi.fn(async () => true);
    const config: OpenClawConfig = { agents: { defaults: { sandbox: { mode: "off" } } } };
    const next = await applyOnboardingSandboxDefault({ config, prompter: prompter(), probeDocker });
    expect(next).toBe(config);
    expect(probeDocker).not.toHaveBeenCalled();
  });
});
