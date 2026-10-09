import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsListResult } from "../../api/types.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createConfigCapabilityHarness } from "../config/config-test-harness.ts";
import { attachClaw, clawCandidates, clawRemovalBlocked, detachClaw } from "./claw-membership.ts";

const config = {
  agents: {
    defaults: { subagents: { allowAgents: ["brief"] } },
    entries: {
      main: { default: true },
      forge: { subagents: { allowAgents: ["scout", "sorter"] } },
      scout: { name: "Scout" },
      bloom: { subagents: { allowAgents: ["*"] } },
      sorter: { kind: "claw" },
      brief: { kind: "claw" },
    },
  },
};

function harness() {
  const patches: Array<{ baseHash: string; raw: unknown; replacePaths?: string[] }> = [];
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "config.get") {
      return {
        config,
        sourceConfig: config,
        raw: JSON.stringify(config),
        hash: "base",
        valid: true,
      };
    }
    if (method === "config.patch") {
      const { baseHash, raw, replacePaths } = params as {
        baseHash: string;
        raw: string;
        replacePaths?: string[];
      };
      patches.push({ baseHash, raw: JSON.parse(raw), replacePaths });
      return { ok: true, config, hash: "next" };
    }
    throw new Error(`Unexpected request ${method}`);
  });
  const { runtimeConfig, publish } = createConfigCapabilityHarness(
    request as GatewayBrowserClient["request"],
  );
  return { runtimeConfig, publish, request, patches };
}

const entries = (raw: unknown) => (raw as { agents: { entries: unknown } }).agents.entries;
const listPath = (bot: string) => [`agents.entries.${bot}.subagents.allowAgents`];

describe("claw membership", () => {
  it.each([
    {
      name: "adds the Claw to the Bot's own list",
      bot: "forge",
      claw: "brief",
      patch: {
        forge: { subagents: { allowAgents: ["scout", "sorter", "brief"] } },
        brief: { kind: "claw" },
      },
      replacePaths: listPath("forge"),
    },
    {
      name: "seeds an inherited list from the defaults",
      bot: "scout",
      claw: "sorter",
      patch: {
        scout: { subagents: { allowAgents: ["brief", "sorter"] } },
        sorter: { kind: "claw" },
      },
      replacePaths: listPath("scout"),
    },
    {
      name: "only marks a Claw that a wildcard list already admits",
      bot: "bloom",
      claw: "scout",
      patch: { scout: { kind: "claw" } },
      replacePaths: undefined,
    },
    {
      name: "only marks a Claw that the inherited list already names",
      bot: "scout",
      claw: "brief",
      patch: { brief: { kind: "claw" } },
      replacePaths: undefined,
    },
  ])("attach $name", async ({ bot, claw, patch, replacePaths }) => {
    const f = harness();
    await expect(attachClaw(f.runtimeConfig, bot, claw)).resolves.toEqual({ ok: true });
    expect(f.patches).toHaveLength(1);
    expect(f.patches[0]?.baseHash).toBe("base");
    expect(entries(f.patches[0]?.raw)).toEqual(patch);
    expect(f.patches[0]?.replacePaths).toEqual(replacePaths);
  });

  it.each([
    {
      name: "keeps the Claw while another Bot still starts it",
      bot: "forge",
      claw: { id: "sorter", claw: { requesterAgentIds: ["forge", "bloom"] } },
      patch: { forge: { subagents: { allowAgents: ["scout"] } } },
    },
    {
      name: "turns the Claw back into a Bot when its last Bot lets go",
      bot: "forge",
      claw: { id: "sorter", claw: { requesterAgentIds: ["forge"] } },
      patch: { forge: { subagents: { allowAgents: ["scout"] } }, sorter: { kind: null } },
    },
    {
      name: "writes the Bot's own list when it inherited the Claw",
      bot: "scout",
      claw: { id: "brief", claw: { requesterAgentIds: ["scout", "main"] } },
      patch: { scout: { subagents: { allowAgents: [] } } },
    },
  ])("detach $name", async ({ bot, claw, patch }) => {
    const f = harness();
    await expect(detachClaw(f.runtimeConfig, bot, claw)).resolves.toEqual({ ok: true });
    expect(f.patches).toHaveLength(1);
    expect(entries(f.patches[0]?.raw)).toEqual(patch);
    expect(f.patches[0]?.replacePaths).toEqual(listPath(bot));
  });

  it("refuses to drop one Claw from a Bot that can start every agent", async () => {
    const f = harness();
    await f.runtimeConfig.ensureLoaded();
    expect(clawRemovalBlocked(config, "bloom")).toBe(true);
    expect(clawRemovalBlocked(config, "forge")).toBe(false);
    expect(clawRemovalBlocked(null, "bloom")).toBe(false);
    const result = await detachClaw(f.runtimeConfig, "bloom", {
      id: "sorter",
      claw: { requesterAgentIds: ["bloom", "forge"] },
    });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("any agent") });
    expect(f.patches).toHaveLength(0);
    expect(f.runtimeConfig.state.lastError).toBeNull();
  });

  it("never creates an agent entry and needs config.patch access", async () => {
    const f = harness();
    const missing = await attachClaw(f.runtimeConfig, "forge", "ghost");
    expect(missing.ok).toBe(false);
    f.publish(true, undefined, gatewayHelloForMethods(["config.patch"], ["operator.read"]));
    const denied = await attachClaw(f.runtimeConfig, "forge", "brief");
    expect(denied.ok).toBe(false);
    expect(f.patches).toHaveLength(0);
  });

  it("offers unused Claws first and never the default, system, own or busy Bots", () => {
    const list: AgentsListResult = {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [
        { id: "main" },
        { id: "ops", kind: "system" },
        { id: "forge" },
        { id: "scout" },
        { id: "bloom" },
        { id: "sorter", claw: { requesterAgentIds: ["forge"] } },
        { id: "digest", claw: { requesterAgentIds: ["bloom"] } },
        { id: "brief", claw: { requesterAgentIds: [] } },
      ],
    };
    expect(clawCandidates(list, "scout").map((agent) => agent.id)).toEqual([
      "brief",
      "sorter",
      "digest",
    ]);
    expect(clawCandidates(list, "forge").map((agent) => agent.id)).toEqual([
      "brief",
      "digest",
      "scout",
    ]);
  });
});
