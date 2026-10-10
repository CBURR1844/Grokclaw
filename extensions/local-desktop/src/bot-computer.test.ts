import type {
  OpenClawConfig,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { createMyComputerTool, setUpBotComputer } from "./bot-computer.js";
import type { DesktopMachines } from "./docker.js";

type Runtime = OpenClawPluginApi["runtime"];

// Core owns and tests tool-policy matching; this still exercises which lists setup consults.
// mock-isolation: A literal matcher keeps this file off the large agent harness module.
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  toolPolicy: {
    createToolPolicyMatcher:
      ({ allow, deny }: { allow?: string[]; deny?: string[] }) =>
      (name: string) =>
        !deny?.includes(name) && (!allow || allow.includes("*") || allow.includes(name)),
  },
}));

const WITH_COMPUTER = {
  agents: { entries: { main: {} } },
  cloudWorkers: {
    profiles: { "computer-main": { provider: "local-desktop", settings: { agentId: "main" } } },
  },
} as unknown as OpenClawConfig;

const OWNER_CONTEXT = {
  agentId: "main",
  sessionKey: "agent:main:main",
  senderIsOwner: true,
  config: WITH_COMPUTER,
} as OpenClawPluginToolContext;

/** Gateway stand-in holding the conversation's one attached environment. */
function fakeGateway(attached?: { id: string; status: string; worker?: { providerId?: string } }) {
  const calls: Array<{ method: string; params: Record<string, unknown>; scopes?: string[] }> = [];
  let environment = attached;
  const gateway = {
    request: async (method: string, params: Record<string, unknown> = {}, options = {}) => {
      calls.push({ method, params, ...("scopes" in options ? { scopes: options.scopes } : {}) });
      if (method === "environments.session.create") {
        environment = { id: "env-1", status: "starting", worker: { providerId: "local-desktop" } };
        return { environment };
      }
      if (method === "environments.session.destroy") {
        environment = undefined;
        return {};
      }
      return environment ? { environment } : { closed: true };
    },
  } as unknown as Runtime["gateway"];
  return { gateway, calls };
}

/** Authored config in `state.config`; `runtime` stands in for a snapshot that differs from it. */
function runtimeConfig(initial: OpenClawConfig, runtime?: OpenClawConfig) {
  const state = { config: initial, writes: 0 };
  const config = {
    current: () => runtime ?? state.config,
    mutateConfigFile: async ({ mutate }: { mutate: (draft: OpenClawConfig) => void }) => {
      const draft = structuredClone(state.config);
      mutate(draft);
      state.config = draft;
      state.writes += 1;
    },
  } as unknown as Runtime["config"];
  return { state, config };
}

const machines = { bridgeAddress: async () => "172.17.0.1" } as DesktopMachines;

describe("my_computer tool", () => {
  it("is offered only to the owner of a bot that has a computer, in a real conversation", () => {
    const { gateway } = fakeGateway();
    const offered = (context: Partial<OpenClawPluginToolContext>) =>
      createMyComputerTool({ context: { ...OWNER_CONTEXT, ...context }, gateway }) !== null;

    expect(offered({})).toBe(true);
    expect(offered({ senderIsOwner: false })).toBe(false);
    expect(offered({ sandboxed: true })).toBe(false);
    expect(offered({ sessionKey: undefined })).toBe(false);
    expect(offered({ agentId: "helper" })).toBe(false);
  });

  it("opens the bot's computer once and reuses it until it is closed", async () => {
    const { gateway, calls } = fakeGateway();
    const tool = createMyComputerTool({ context: OWNER_CONTEXT, gateway })!;

    const opened = await tool.execute("call-1", { action: "open", show: true });
    const again = await tool.execute("call-2", { action: "open" });
    await tool.execute("call-3", { action: "close" });
    const status = await tool.execute("call-4", { action: "status" });
    // Some providers repeat tool call ids across runs; the reopen must still be a new request.
    await tool.execute("call-1", { action: "open" });

    expect(opened.details).toEqual({ environmentId: "env-1", status: "starting" });
    expect(again.details).toEqual({ environmentId: "env-1", status: "starting" });
    expect(status.details).toEqual({ status: "closed" });
    const create = calls.filter((call) => call.method === "environments.session.create");
    expect(create).toEqual([
      {
        method: "environments.session.create",
        params: {
          profileId: "computer-main",
          idempotencyKey: expect.any(String),
          presentation: "desktop",
        },
        scopes: ["operator.admin"],
      },
      {
        method: "environments.session.create",
        params: { profileId: "computer-main", idempotencyKey: expect.any(String) },
        scopes: ["operator.admin"],
      },
    ]);
    expect(create[1]?.params.idempotencyKey).not.toBe(create[0]?.params.idempotencyKey);
    expect(calls.find((call) => call.method === "environments.session.destroy")?.params).toEqual({
      environmentId: "env-1",
    });
  });

  it("replaces a computer that failed to start instead of returning it again", async () => {
    const { gateway, calls } = fakeGateway({
      id: "env-failed",
      status: "error",
      worker: { providerId: "local-desktop" },
    });
    const tool = createMyComputerTool({ context: OWNER_CONTEXT, gateway })!;

    const opened = await tool.execute("call-1", { action: "open" });

    expect(opened.details).toEqual({ environmentId: "env-1", status: "starting" });
    expect(calls.map((call) => call.method)).toEqual([
      "environments.session.status",
      "environments.session.create",
    ]);
  });

  it("leaves another provider's environment alone", async () => {
    const { gateway, calls } = fakeGateway({
      id: "env-cloud",
      status: "ready",
      worker: { providerId: "crabbox" },
    });
    const tool = createMyComputerTool({ context: OWNER_CONTEXT, gateway })!;

    const status = await tool.execute("call-1", { action: "status" });
    await tool.execute("call-2", { action: "close" });

    expect(status.details).toEqual({ status: "closed" });
    expect(calls.some((call) => call.method === "environments.session.destroy")).toBe(false);
  });
});

describe("bot computer setup", () => {
  const AUTH = { mode: "token", token: "synthetic-token" };
  const setUp = (config: Runtime["config"], agentId = "main") =>
    setUpBotComputer({ agentId, machines, config, canListen: async () => true });

  it("binds the Gateway to Docker's network and gives the bot its computer and tools", async () => {
    const { state, config } = runtimeConfig({
      gateway: { auth: AUTH },
      tools: { profile: "coding", alsoAllow: ["browser"] },
      agents: { entries: { main: {} } },
    } as unknown as OpenClawConfig);

    const main = await setUp(config);
    const rerun = await setUp(config);

    expect(main).toEqual({
      profileId: "computer-main",
      gatewayUrl: expect.stringMatching(/^ws:\/\/172\.17\.0\.1:\d+$/),
      gatewayRestart: "automatic",
    });
    expect(rerun).toEqual({ ...main, gatewayRestart: "none" });
    const result = state.config as unknown as {
      gateway: Record<string, unknown>;
      cloudWorkers: { desktop: boolean; profiles: Record<string, unknown> };
      agents: { entries: Record<string, { tools: Record<string, string[]> }> };
    };
    expect(result.gateway).toMatchObject({ bind: "custom", customBindHost: "172.17.0.1" });
    expect(result.cloudWorkers.desktop).toBe(true);
    expect(result.cloudWorkers.profiles["computer-main"]).toEqual({
      provider: "local-desktop",
      install: "bundle",
      suspendAfter: "30m",
      settings: { agentId: "main" },
    });
    // The agent's new list replaces the global one, so it keeps the global grants.
    expect(result.agents.entries.main?.tools).toEqual({
      alsoAllow: ["browser", "computer", "my_computer"],
    });
  });

  it("grants through an agent's tools.allow only when its profile lets the tools through", async () => {
    const withTools = (tools?: Record<string, unknown>) =>
      runtimeConfig({
        gateway: { auth: AUTH },
        ...(tools ? { tools } : {}),
        agents: { entries: { helper: { tools: { allow: ["read"] } } } },
      } as unknown as OpenClawConfig);
    const open = withTools();
    const limited = withTools({ profile: "coding" });
    const granted = withTools({ profile: "coding", alsoAllow: ["computer", "group:plugins"] });

    await setUp(open.config, "helper");
    await expect(setUp(limited.config, "helper")).rejects.toThrow(
      "tools.profile keeps this bot from using computer and my_computer. Add both to tools.alsoAllow, or move agents.entries.helper.tools.allow to tools.alsoAllow, then set up the computer again.",
    );
    await setUp(granted.config, "helper");

    for (const { state } of [open, granted]) {
      expect(state.config.agents?.entries?.helper?.tools).toEqual({
        allow: ["read", "computer", "my_computer"],
      });
    }
    expect(limited.state.writes).toBe(0);
  });

  it("edits the bot's authored entry whatever the case of its key", async () => {
    const { state, config } = runtimeConfig({
      gateway: { auth: AUTH },
      agents: { entries: { Ops: { name: "Ops" } } },
    } as unknown as OpenClawConfig);

    const setup = await setUp(config, "Ops");

    expect(setup).toMatchObject({ profileId: "computer-ops" });
    expect(state.config.agents?.entries).toEqual({
      Ops: { name: "Ops", tools: { alsoAllow: ["computer", "my_computer"] } },
    });
    expect(state.config.cloudWorkers?.profiles?.["computer-ops"]?.settings).toEqual({
      agentId: "ops",
    });
    await expect(setUp(config, "!!!")).rejects.toThrow('There is no bot with id "!!!".');
  });

  it("keeps an address the Gateway already gives workers, and asks for a restart when reload is off", async () => {
    const { state, config } = runtimeConfig({
      gateway: { reload: { mode: "off" } },
      plugins: {
        entries: { "device-pair": { config: { publicUrl: "https://pair.example.test" } } },
      },
    } as unknown as OpenClawConfig);

    const setup = await setUp(config);
    const rerun = await setUp(config);

    expect(setup).toMatchObject({
      gatewayUrl: "wss://pair.example.test",
      gatewayRestart: "manual",
    });
    expect(rerun.gatewayRestart).toBe("none");
    expect(state.config.gateway?.bind).toBeUndefined();
  });

  it("refuses before changing anything when computers could not reach or trust the Gateway", async () => {
    const { state, config } = runtimeConfig({
      agents: { entries: { main: {} } },
      gateway: { auth: { mode: "none" } },
    } as unknown as OpenClawConfig);
    const refuses = async (gateway: Record<string, unknown>, message: string) => {
      state.config = { agents: { entries: { main: {} } }, gateway } as unknown as OpenClawConfig;
      await expect(setUp(config)).rejects.toThrow(message);
    };

    await expect(setUp(config, "helper")).rejects.toThrow('There is no bot with id "helper".');
    await expect(setUp(config)).rejects.toThrow("Bot computers need Gateway sign-in");
    await refuses(
      { publicOrigin: "http://localhost:18789" },
      "Bot computers would be sent to ws://localhost:18789 (from gateway.publicOrigin), which they cannot reach.",
    );
    await refuses(
      { publicOrigin: "not a url" },
      "Could not work out where bot computers can reach the Gateway: Configured gateway.publicOrigin is invalid.",
    );
    state.config = { agents: { entries: { main: {} } } } as unknown as OpenClawConfig;
    await expect(
      setUpBotComputer({ agentId: "main", machines, config, canListen: async () => false }),
    ).rejects.toThrow("bot computers need rootful Docker Engine on the Gateway's host");
    expect(state.writes).toBe(0);
  });

  it("refuses the bind when only this run's generated secret signs the Gateway in", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "");
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "");
    const authored = { agents: { entries: { main: {} } } } as unknown as OpenClawConfig;
    const token = runtimeConfig(authored, {
      ...authored,
      gateway: { auth: { mode: "token", token: "generated-at-startup" } },
    } as unknown as OpenClawConfig);
    const password = runtimeConfig({
      ...authored,
      gateway: { auth: { mode: "password" } },
    } as unknown as OpenClawConfig);

    await expect(setUp(token.config)).rejects.toThrow(
      "needs a saved Gateway token. Run `openclaw config set gateway.auth.token <token>`",
    );
    await expect(setUp(password.config)).rejects.toThrow(
      "needs a saved Gateway password. Run `openclaw config set gateway.auth.password <password>`",
    );
    expect(token.state.writes + password.state.writes).toBe(0);
    vi.unstubAllEnvs();
  });

  it("refuses when a tool list the bot's grant cannot widen excludes its computer tools", async () => {
    const withTools = (config: Record<string, unknown>) =>
      runtimeConfig({ gateway: { auth: AUTH }, ...config } as unknown as OpenClawConfig);
    const global = withTools({ tools: { allow: ["group:fs"] } });
    const agent = withTools({ agents: { entries: { main: { tools: { deny: ["computer"] } } } } });
    const plugin = withTools({ tools: { deny: ["local-desktop"] } });
    const pluginsAllowed = withTools({ tools: { allow: ["group:plugins", "computer"] } });

    await expect(setUp(global.config)).rejects.toThrow(
      "tools.allow or tools.deny keeps this bot from using computer and my_computer.",
    );
    await expect(setUp(agent.config)).rejects.toThrow(
      "agents.entries.main.tools.deny keeps this bot from using computer and my_computer.",
    );
    // Plugin entries name this plugin's tool.
    await expect(setUp(plugin.config)).rejects.toThrow("tools.allow or tools.deny keeps this bot");
    await setUp(pluginsAllowed.config);
    expect(global.state.writes + agent.state.writes + plugin.state.writes).toBe(0);
  });
});
