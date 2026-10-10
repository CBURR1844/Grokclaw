import type {
  OpenClawConfig,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import { createMyComputerTool, setUpBotComputer } from "./bot-computer.js";
import type { DesktopMachines } from "./docker.js";

type Runtime = OpenClawPluginApi["runtime"];

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

function runtimeConfig(initial: OpenClawConfig) {
  const state = { config: initial, writes: 0 };
  const config = {
    current: () => state.config,
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
  it("binds the Gateway to Docker's network and gives the bot its computer and tools", async () => {
    const { state, config } = runtimeConfig({
      gateway: { auth: { mode: "token", token: "synthetic-token" } },
      agents: { entries: { main: {}, helper: { tools: { allow: ["read"] } } } },
    } as unknown as OpenClawConfig);

    const main = await setUpBotComputer({
      agentId: "main",
      machines,
      config,
      canListen: async () => true,
    });
    await setUpBotComputer({ agentId: "helper", machines, config, canListen: async () => true });
    const rerun = await setUpBotComputer({
      agentId: "main",
      machines,
      config,
      canListen: async () => true,
    });

    expect(main).toEqual({
      profileId: "computer-main",
      gatewayUrl: expect.stringMatching(/^ws:\/\/172\.17\.0\.1:\d+$/),
      restarting: true,
    });
    expect(rerun).toEqual({ ...main, restarting: false });
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
    expect(result.agents.entries.main?.tools).toEqual({ alsoAllow: ["computer", "my_computer"] });
    expect(result.agents.entries.helper?.tools).toEqual({
      allow: ["read", "computer", "my_computer"],
    });
  });

  it("keeps an address the Gateway already advertises", async () => {
    const { state, config } = runtimeConfig({
      gateway: { publicOrigin: "https://gateway.example.test" },
    } as unknown as OpenClawConfig);

    const setup = await setUpBotComputer({
      agentId: "main",
      machines,
      config,
      canListen: async () => true,
    });

    expect(setup).toMatchObject({ gatewayUrl: "wss://gateway.example.test", restarting: false });
    expect(state.config.gateway?.bind).toBeUndefined();
  });

  it("refuses before changing anything when computers could not reach or trust the Gateway", async () => {
    const { state, config } = runtimeConfig({
      agents: { entries: { main: {} } },
      gateway: { auth: { mode: "none" } },
    } as unknown as OpenClawConfig);
    const setUp = (agentId: string, canListen = async () => true) =>
      setUpBotComputer({ agentId, machines, config, canListen });

    await expect(setUp("helper")).rejects.toThrow('There is no bot with id "helper".');
    await expect(setUp("main")).rejects.toThrow("Bot computers need Gateway sign-in");
    state.config = { agents: { entries: { main: {} } } } as unknown as OpenClawConfig;
    await expect(setUp("main", async () => false)).rejects.toThrow(
      "Docker Desktop on Mac and Windows is not supported yet",
    );
    expect(state.writes).toBe(0);
  });
});
