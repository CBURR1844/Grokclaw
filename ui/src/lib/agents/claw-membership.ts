import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentsListResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import {
  resolveAgentConfigEntryTarget,
  resolveEditableSnapshotConfig,
} from "../config/config-state-model.ts";
import type { RuntimeConfigCapability } from "../config/runtime-config-capability.ts";
import { formatUiError } from "../format-error.ts";
import { clawsOf, isClawAgent } from "./display.ts";

type AgentRow = AgentsListResult["agents"][number];
type ConfigObject = Readonly<Record<string, unknown>>;
type MembershipChange = { botId: string; clawId: string; attach: boolean; lastBot: boolean };
export type ClawMembershipResult = { ok: true } | { ok: false; error: string };

/**
 * Agents a Bot can take on as Claws: unused Claws, then Claws other Bots use, then Bots
 * without Claws of their own. Never the default agent, a system agent or the Bot itself.
 */
export function clawCandidates(list: AgentsListResult, botId: string): AgentRow[] {
  const bot = normalizeAgentId(botId);
  const defaultId = normalizeAgentId(list.defaultId);
  const attached = new Set(clawsOf(list.agents, bot).map((agent) => normalizeAgentId(agent.id)));
  const rank = (agent: AgentRow) =>
    !agent.claw ? 2 : agent.claw.requesterAgentIds.length === 0 ? 0 : 1;
  return list.agents
    .filter((agent) => {
      const id = normalizeAgentId(agent.id);
      return (
        id !== bot &&
        id !== defaultId &&
        agent.kind !== "system" &&
        !attached.has(id) &&
        (isClawAgent(agent) || clawsOf(list.agents, id).length === 0)
      );
    })
    .toSorted((a, b) => rank(a) - rank(b));
}

const isWildcard = (value: unknown) => typeof value === "string" && value.trim() === "*";

/** The list spawn admission reads for a Bot: its own `subagents.allowAgents`, else the defaults'. */
function requesterAllowAgents(
  config: ConfigObject,
  entry: unknown,
): readonly unknown[] | undefined {
  const own = asOptionalRecord(asOptionalRecord(entry)?.subagents)?.allowAgents;
  const defaults = asOptionalRecord(asOptionalRecord(config.agents)?.defaults);
  const inherited = asOptionalRecord(defaults?.subagents)?.allowAgents;
  return Array.isArray(own) ? own : Array.isArray(inherited) ? inherited : undefined;
}

/** A Bot whose list admits every agent cannot drop one Claw without editing its settings. */
export function clawRemovalBlocked(config: ConfigObject | null, botId: string): boolean {
  const entry = config ? resolveAgentConfigEntryTarget(config, botId)?.entry : undefined;
  return Boolean(config && requesterAllowAgents(config, entry)?.some(isWildcard));
}

function membershipPatch(
  config: ConfigObject,
  change: MembershipChange,
): { patch: Record<string, unknown>; replacePaths: string[] } | { error: string } {
  const bot = resolveAgentConfigEntryTarget(config, change.botId);
  const claw = resolveAgentConfigEntryTarget(config, change.clawId);
  // Writing to a missing entry would create a new agent instead of linking two.
  if (!bot || !claw) {
    return { error: t("agentDetails.claws.notConfigured") };
  }
  // With no list anywhere a Bot may start only itself; written lists keep that target.
  const list = requesterAllowAgents(config, bot.entry) ?? [normalizeAgentId(change.botId)];
  if (!change.attach && list.some(isWildcard)) {
    return { error: t("agentDetails.claws.removeBlocked") };
  }
  const clawId = normalizeAgentId(change.clawId);
  const names = (value: unknown) =>
    typeof value === "string" && value.trim() !== "" && normalizeAgentId(value) === clawId;
  const covered = change.attach && list.some((value) => isWildcard(value) || names(value));
  const botKey = bot.path[2];
  const clawKey = claw.path[2];
  const kind = change.attach ? "claw" : change.lastBot ? null : undefined;
  return {
    patch: {
      agents: {
        entries: {
          // An inherited list is seeded from the defaults into the Bot's own entry.
          ...(covered
            ? {}
            : {
                [botKey]: {
                  subagents: {
                    allowAgents: change.attach
                      ? [...list, clawId]
                      : list.filter((value) => !names(value)),
                  },
                },
              }),
          ...(kind === undefined ? {} : { [clawKey]: { kind } }),
        },
      },
    },
    replacePaths: covered ? [] : [`agents.entries.${botKey}.subagents.allowAgents`],
  };
}

async function changeMembership(
  runtimeConfig: RuntimeConfigCapability,
  change: MembershipChange,
  note: string,
): Promise<ClawMembershipResult> {
  if (runtimeConfig.canPatch !== true) {
    return { ok: false, error: t("agentDetails.claws.noAccess") };
  }
  try {
    await runtimeConfig.ensureLoaded();
    // Expected refusals answer here, before the shared config writer records an error.
    const loaded = resolveEditableSnapshotConfig(runtimeConfig.state.configSnapshot);
    const planned = loaded ? membershipPatch(loaded, change) : null;
    if (!planned || "error" in planned) {
      return { ok: false, error: planned?.error ?? t("agentDetails.claws.changeFailed") };
    }
    const patched = await runtimeConfig.patchFromSnapshot((base) => {
      const built = membershipPatch(base, change);
      return "error" in built
        ? built
        : { options: { raw: built.patch, note, replacePaths: built.replacePaths } };
    });
    return patched
      ? { ok: true }
      : { ok: false, error: runtimeConfig.state.lastError ?? t("agentDetails.claws.changeFailed") };
  } catch (error) {
    return { ok: false, error: formatUiError(error) };
  }
}

/** Marks the agent a Claw and lets the Bot start it, in one config patch. */
export function attachClaw(
  runtimeConfig: RuntimeConfigCapability,
  botId: string,
  clawId: string,
): Promise<ClawMembershipResult> {
  return changeMembership(
    runtimeConfig,
    { botId, clawId, attach: true, lastBot: false },
    `Add Claw ${clawId} to ${botId}`,
  );
}

/** Stops the Bot starting this Claw; leaving its last visible Bot makes it a Bot again. */
export function detachClaw(
  runtimeConfig: RuntimeConfigCapability,
  botId: string,
  claw: Pick<AgentRow, "id" | "claw">,
): Promise<ClawMembershipResult> {
  const bot = normalizeAgentId(botId);
  const lastBot = !claw.claw?.requesterAgentIds.some((id) => normalizeAgentId(id) !== bot);
  return changeMembership(
    runtimeConfig,
    { botId, clawId: claw.id, attach: false, lastBot },
    `Remove Claw ${claw.id} from ${botId}`,
  );
}
