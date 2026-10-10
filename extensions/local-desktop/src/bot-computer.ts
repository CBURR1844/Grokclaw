import { randomUUID } from "node:crypto";
import net from "node:net";
import os from "node:os";
import { listAgentIds } from "openclaw/plugin-sdk/agent-scope-runtime";
import { resolvePairingGatewayUrl } from "openclaw/plugin-sdk/device-bootstrap";
import { readStringParam } from "openclaw/plugin-sdk/param-readers";
import type {
  AnyAgentTool,
  OpenClawConfig,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import type { DesktopMachines } from "./docker.js";
import { LOCAL_DESKTOP_PROVIDER_ID, readComputerOwner } from "./provider.js";

// One computer per bot: a cloudWorkers profile names the bot in its settings, and the bot
// opens that profile's environment in whichever conversation it is working in.

export const MY_COMPUTER_TOOL = "my_computer";
const IDLE_SUSPEND = "30m";

type Gateway = OpenClawPluginApi["runtime"]["gateway"];
type EnvironmentSummary = {
  id: string;
  status: string;
  worker?: { providerId?: string; error?: string };
};

function findComputerProfile(config: OpenClawConfig | undefined, agentId: string) {
  return Object.entries(config?.cloudWorkers?.profiles ?? {}).find(
    ([, profile]) =>
      profile.provider === LOCAL_DESKTOP_PROVIDER_ID &&
      readComputerOwner(profile.settings) === agentId,
  )?.[0];
}

function describe(environment: EnvironmentSummary | undefined) {
  return environment
    ? {
        environmentId: environment.id,
        status: environment.status,
        ...(environment.worker?.error ? { error: environment.worker.error } : {}),
      }
    : { status: "closed" };
}

export function createMyComputerTool(params: {
  context: OpenClawPluginToolContext;
  gateway: Gateway;
}): AnyAgentTool | null {
  const { context, gateway } = params;
  const config = () => context.getRuntimeConfig?.() ?? context.runtimeConfig ?? context.config;
  const { agentId } = context;
  // Same audience as the computer tool it feeds: the owner, in a persistent conversation.
  if (
    context.sandboxed ||
    context.senderIsOwner === false ||
    !agentId ||
    !context.sessionKey ||
    !findComputerProfile(config(), agentId)
  ) {
    return null;
  }
  const attached = async (): Promise<EnvironmentSummary | undefined> => {
    const status = await gateway.request<{ environment?: EnvironmentSummary; closed?: boolean }>(
      "environments.session.status",
      {},
      { timeoutMs: 30_000, scopes: ["operator.read"] },
    );
    return status.environment?.worker?.providerId === LOCAL_DESKTOP_PROVIDER_ID && !status.closed
      ? status.environment
      : undefined;
  };
  return {
    name: MY_COMPUTER_TOOL,
    label: "My computer",
    description:
      "Open, check, or close your own computer: a private Linux desktop that keeps its files between chats. open returns environmentId; pass it to the computer tool to see the screen and use the mouse and keyboard. Pass show=true when the user wants to watch. The first open can take several minutes. The computer closes itself after 30 idle minutes; close it sooner when the task is done.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["open", "status", "close"] },
        show: {
          type: "boolean",
          description: "open: show the desktop in the user's side panel while it starts.",
        },
      },
    },
    resultContentSource: "network",
    async execute(_toolCallId, rawArgs, signal) {
      signal?.throwIfAborted();
      // SAFETY: the tool executor validates the declared object schema before calling execute.
      const args = rawArgs as Record<string, unknown>;
      const action = readStringParam(args, "action", { required: true });
      const profileId = findComputerProfile(config(), agentId);
      if (!profileId) {
        throw new Error("This bot no longer has a computer. Ask the owner to set one up.");
      }
      if (action === "status") {
        return jsonResult(describe(await attached()));
      }
      if (action === "close") {
        const environment = await attached();
        if (environment) {
          await gateway.request(
            "environments.session.destroy",
            { environmentId: environment.id },
            { timeoutMs: 5 * 60_000, scopes: ["operator.admin"] },
          );
        }
        return jsonResult({ status: "closed" });
      }
      // A computer that failed or is stopping is replaced; create closes its attachment.
      const previous = await attached();
      if (previous?.status === "starting" || previous?.status === "available") {
        return jsonResult(describe(previous));
      }
      // Each open is a new request. Tool call ids are not unique across runs with every model
      // provider, and core refuses to reuse the key of a stopped request.
      const idempotencyKey = randomUUID();
      const created = await gateway.request<{ environment?: EnvironmentSummary }>(
        "environments.session.create",
        {
          profileId,
          idempotencyKey,
          ...(args.show === true ? { presentation: "desktop" } : {}),
        },
        { timeoutMs: 60 * 60_000, scopes: ["operator.admin"] },
      );
      return jsonResult(describe(created.environment));
    },
  };
}

async function canListenOn(host: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(0, host, () => server.close(() => resolve(true)));
  });
}

async function advertisedGatewayUrl(config: OpenClawConfig): Promise<string | undefined> {
  const result = await resolvePairingGatewayUrl(config, {
    env: process.env,
    publicOriginPreference: "prefer",
    networkInterfaces: () => os.networkInterfaces(),
  });
  if (!result.url) {
    return undefined;
  }
  const host = new URL(result.url).hostname.replace(/^\[|\]$/g, "");
  return net.isIP(host) && /^(127\.|::1$|0\.0\.0\.0$)/.test(host) ? undefined : result.url;
}

export type BotComputerSetup = {
  profileId: string;
  /** Where the computer's OpenClaw node will reach the Gateway. */
  gatewayUrl: string;
  /** The Gateway restarts to start listening where computers can reach it. */
  restarting: boolean;
};

/**
 * Give a bot its computer. Lets Docker containers reach the Gateway (binding it to Docker's
 * bridge only when nothing else already advertises a reachable address), turns on the
 * desktop viewer, adds the bot's profile, and allows the bot its computer tools.
 */
export async function setUpBotComputer(params: {
  agentId: string;
  machines: DesktopMachines;
  config: OpenClawPluginApi["runtime"]["config"];
  canListen?: (host: string) => Promise<boolean>;
}): Promise<BotComputerSetup> {
  const { agentId } = params;
  const current = params.config.current() as OpenClawConfig;
  if (!listAgentIds(current).includes(agentId)) {
    throw new Error(`There is no bot with id "${agentId}".`);
  }
  if (current.gateway?.auth?.mode === "none") {
    throw new Error("Bot computers need Gateway sign-in. Set a Gateway token or password first.");
  }
  const bridge = await params.machines.bridgeAddress();
  if (!(await (params.canListen ?? canListenOn)(bridge))) {
    throw new Error(
      `This host cannot listen on Docker's network (${bridge}). Docker Desktop on Mac and Windows is not supported yet; use Docker Engine on Linux.`,
    );
  }
  const keepUrl = await advertisedGatewayUrl(current);
  const bound = (config: OpenClawConfig): OpenClawConfig => ({
    ...config,
    gateway: { ...config.gateway, bind: "custom", customBindHost: bridge },
  });
  const gatewayUrl = keepUrl ?? (await advertisedGatewayUrl(bound(current)));
  if (!gatewayUrl) {
    throw new Error("Could not work out an address where bot computers can reach the Gateway.");
  }
  const profileId = findComputerProfile(current, agentId) ?? `computer-${agentId}`;
  await params.config.mutateConfigFile({
    afterWrite: { mode: "auto" },
    mutate: (draft) => {
      const profiles = draft.cloudWorkers?.profiles ?? {};
      const existing = profiles[profileId];
      if (existing && readComputerOwner(existing.settings) !== agentId) {
        throw new Error(`Worker profile "${profileId}" already exists for something else.`);
      }
      if (!keepUrl) {
        Object.assign(draft, bound(draft));
      }
      draft.cloudWorkers = {
        ...draft.cloudWorkers,
        desktop: true,
        profiles: {
          ...profiles,
          [profileId]: existing ?? {
            provider: LOCAL_DESKTOP_PROVIDER_ID,
            install: "bundle",
            suspendAfter: IDLE_SUSPEND,
            settings: { agentId },
          },
        },
      };
      const entry = draft.agents?.entries?.[agentId] ?? {};
      const tools = entry.tools ?? {};
      const listKey = tools.allow?.length ? "allow" : "alsoAllow";
      draft.agents = {
        ...draft.agents,
        entries: {
          ...draft.agents?.entries,
          [agentId]: {
            ...entry,
            tools: {
              ...tools,
              [listKey]: [...new Set([...(tools[listKey] ?? []), "computer", MY_COMPUTER_TOOL])],
            },
          },
        },
      };
    },
  });
  return { profileId, gatewayUrl, restarting: !keepUrl };
}
