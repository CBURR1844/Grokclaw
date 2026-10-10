import { randomUUID } from "node:crypto";
import net from "node:net";
import os from "node:os";
import { listAgentIds } from "openclaw/plugin-sdk/agent-scope-runtime";
import { resolvePairingGatewayUrl } from "openclaw/plugin-sdk/device-bootstrap";
import { isLoopbackHost, resolveGatewayAuth } from "openclaw/plugin-sdk/gateway-runtime";
import { readStringParam } from "openclaw/plugin-sdk/param-readers";
import type {
  AnyAgentTool,
  OpenClawConfig,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { hasConfiguredSecretInput } from "openclaw/plugin-sdk/secret-input";
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
      "Open, check, or close your own computer: a private Linux desktop that keeps its files between chats. open returns environmentId; pass it to the computer tool to see the screen and use the mouse and keyboard. Pass show=true when the user wants to watch. The first open can take several minutes. Close it when the task is done.",
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

// Core's node enrollment refuses these hosts for any worker, so setup refuses them too.
const UNREACHABLE = new net.BlockList();
UNREACHABLE.addSubnet("169.254.0.0", 16, "ipv4");
UNREACHABLE.addSubnet("fe80::", 10, "ipv6");
UNREACHABLE.addAddress("0.0.0.0", "ipv4");
UNREACHABLE.addAddress("::", "ipv6");

/** The address core's node enrollment would hand a computer, resolved from the same inputs. */
async function enrollmentAddress(config: OpenClawConfig) {
  const publicUrl = config.plugins?.entries?.["device-pair"]?.config?.publicUrl;
  const result = await resolvePairingGatewayUrl(config, {
    env: process.env,
    useLocalGateway: config.gateway?.mode === "remote",
    ...(typeof publicUrl === "string" && publicUrl.trim() ? { publicUrl: publicUrl.trim() } : {}),
    publicOriginPreference: "prefer",
    networkInterfaces: () => os.networkInterfaces(),
    runCommandWithTimeout: async (argv, options) =>
      await runCommandWithTimeout(argv, { timeoutMs: options.timeoutMs }),
  });
  if (!result.url) {
    return undefined;
  }
  const host = new URL(result.url).hostname.replace(/^\[|\]$/g, "");
  const family = net.isIP(host);
  const reachable =
    !isLoopbackHost(host) && !(family && UNREACHABLE.check(host, family === 6 ? "ipv6" : "ipv4"));
  return { url: result.url, source: result.source ?? "the Gateway's settings", reachable };
}

/**
 * Refuse a write that would stop the Gateway's next cold start: a non-loopback bind needs a
 * shared secret from config or the environment, not the token a Gateway generates per start.
 */
function assertGatewaySecret(draft: OpenClawConfig): void {
  const auth = resolveGatewayAuth({ authConfig: draft.gateway?.auth, env: process.env });
  const configured = (value: unknown) => hasConfiguredSecretInput(value, draft.secrets?.defaults);
  const secret =
    auth.mode === "trusted-proxy" ||
    (auth.mode === "token" &&
      (Boolean(auth.token?.trim()) || configured(draft.gateway?.auth?.token))) ||
    (auth.mode === "password" &&
      (Boolean(auth.password?.trim()) || configured(draft.gateway?.auth?.password)));
  if (!secret) {
    throw new Error(
      "Bot computers reach the Gateway over Docker's network, which needs a saved Gateway token. Run `openclaw config set gateway.auth.token <token>` (or set OPENCLAW_GATEWAY_TOKEN for the Gateway service), then set up the computer again.",
    );
  }
}

const GRANTED_TOOLS = ["computer", MY_COMPUTER_TOOL];
type ToolLists = { allow?: string[]; alsoAllow?: string[]; deny?: string[] };

export type BotComputerSetup = {
  profileId: string;
  /** Where the computer's OpenClaw node will reach the Gateway. */
  gatewayUrl: string;
  /**
   * none: the Gateway already listens where computers reach it. automatic: it restarts itself to
   * listen on Docker's bridge. manual: config reload is off, so restart the Gateway to finish.
   */
  gatewayRestart: "none" | "automatic" | "manual";
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
  const agentId = normalizeAgentId(params.agentId);
  const current = params.config.current() as OpenClawConfig;
  if (!listAgentIds(current).includes(agentId)) {
    throw new Error(`There is no bot with id "${params.agentId}".`);
  }
  if (current.gateway?.auth?.mode === "none") {
    throw new Error("Bot computers need Gateway sign-in. Set a Gateway token or password first.");
  }
  const bridge = await params.machines.bridgeAddress();
  if (!(await (params.canListen ?? canListenOn)(bridge))) {
    throw new Error(
      `This host cannot listen on Docker's network (${bridge}), so a bot computer could not reach the Gateway. Rootless Docker, Docker Desktop and remote Docker contexts all cause this; bot computers need rootful Docker Engine on the Gateway's host.`,
    );
  }
  const bound = (config: OpenClawConfig): OpenClawConfig => ({
    ...config,
    gateway: { ...config.gateway, bind: "custom", customBindHost: bridge },
  });
  const existing = await enrollmentAddress(current);
  const address = existing?.reachable ? existing : await enrollmentAddress(bound(current));
  if (!address?.reachable) {
    throw new Error(
      address
        ? `Bot computers would be sent to ${address.url} (from ${address.source}), which they cannot reach. Set gateway.publicOrigin (or plugins.entries.device-pair.config.publicUrl) to an address they can reach, or remove it.`
        : "Could not work out where bot computers can reach the Gateway. Set gateway.publicOrigin to an address they can reach.",
    );
  }
  const rebind = address !== existing;
  // Loaded only here: setup is rare, and the matcher lives in a large SDK module.
  const { toolPolicy } = await import("openclaw/plugin-sdk/agent-harness-runtime");
  const refusedBy = (tools: ToolLists | undefined, path: string) => {
    const extra = tools?.alsoAllow?.length ? tools.alsoAllow : undefined;
    const allow = extra
      ? [...(tools?.allow?.length ? tools.allow : ["*"]), ...extra]
      : tools?.allow;
    const matches = toolPolicy.createToolPolicyMatcher({
      ...(allow?.length ? { allow } : {}),
      ...(tools?.deny?.length ? { deny: tools.deny } : {}),
    });
    return GRANTED_TOOLS.every(matches) ? undefined : path;
  };
  const profileId = findComputerProfile(current, agentId) ?? `computer-${agentId}`;
  await params.config.mutateConfigFile({
    afterWrite: { mode: "auto" },
    mutate: (draft) => {
      if (rebind) {
        assertGatewaySecret(draft);
      }
      const profiles = draft.cloudWorkers?.profiles ?? {};
      const profile = profiles[profileId];
      if (profile && readComputerOwner(profile.settings) !== agentId) {
        throw new Error(`Worker profile "${profileId}" already exists for something else.`);
      }
      if (rebind) {
        Object.assign(draft, bound(draft));
      }
      draft.cloudWorkers = {
        ...draft.cloudWorkers,
        desktop: true,
        profiles: {
          ...profiles,
          [profileId]: profile ?? {
            provider: LOCAL_DESKTOP_PROVIDER_ID,
            install: "bundle",
            suspendAfter: IDLE_SUSPEND,
            settings: { agentId },
          },
        },
      };
      // Edit the authored entry, whatever its key's case.
      const entryKey =
        Object.keys(draft.agents?.entries ?? {}).find((key) => normalizeAgentId(key) === agentId) ??
        agentId;
      const entry = draft.agents?.entries?.[entryKey] ?? {};
      const tools = entry.tools ?? {};
      // An agent list replaces the inherited one, so a new alsoAllow starts from the global grants.
      const granted: typeof tools = tools.allow?.length
        ? { ...tools, allow: [...new Set([...tools.allow, ...GRANTED_TOOLS])] }
        : {
            ...tools,
            alsoAllow: [
              ...new Set([...(tools.alsoAllow ?? draft.tools?.alsoAllow ?? []), ...GRANTED_TOOLS]),
            ],
          };
      // Global and agent allow/deny lists are their own filters; an agent grant cannot widen them.
      const refusal =
        refusedBy(draft.tools, "tools.allow or tools.deny") ??
        refusedBy(granted, `agents.entries.${entryKey}.tools.deny`);
      if (refusal) {
        throw new Error(
          `${refusal} keeps this bot from using computer and my_computer. Allow both there, then set up the computer again.`,
        );
      }
      draft.agents = {
        ...draft.agents,
        entries: { ...draft.agents?.entries, [entryKey]: { ...entry, tools: granted } },
      };
    },
  });
  return {
    profileId,
    gatewayUrl: address.url,
    gatewayRestart: !rebind
      ? "none"
      : current.gateway?.reload?.mode === "off"
        ? "manual"
        : "automatic",
  };
}
