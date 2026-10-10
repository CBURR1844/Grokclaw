// Commits a result run's outcome as a durable row in the requester's chat; never wakes it.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { commitBackgroundResultToSession } from "../../../sessions/background-session-result.js";
import { truncateUtf16WithEllipsis } from "../../../shared/text-truncate.js";
import type { SubagentRunOutcome } from "../subagent-run-outcome.types.js";
import { getRuntimeConfig, resolveAgentIdFromSessionKey } from "./subagent-announce.runtime.js";

const TASK_EXCERPT_MAX_CHARS = 120;

const UNFINISHED_REASONS = {
  timeout: "timed out",
  stopped: "stopped",
  error: "hit an error",
} as const;

type SubagentResultStatus = "ok" | keyof typeof UNFINISHED_REASONS;

export type SubagentResultPresentationOutcome =
  | "delivered"
  | "intentional_non_delivery"
  | "retryable";

function resolveResultText(name: string, status: SubagentResultStatus, reply: string | undefined) {
  if (status !== "ok") {
    return `${name} didn't finish (${UNFINISHED_REASONS[status]}). Open the run to see what it did.`;
  }
  return reply ?? `${name} finished without a reply. Open the run to see what it did.`;
}

/**
 * The row is an assistant row in the bot's transcript, so every harness replays it as the bot's
 * own output. This header, written once with the row, tells the bot's model whose report it is.
 */
function resolveModelAttribution(params: {
  name: string;
  agentId: string;
  runId: string;
  status: SubagentResultStatus;
  task?: string;
}) {
  const task = params.task ? ` Task: "${params.task}".` : "";
  return (
    `[Result from the Claw ${params.name} (agent ${params.agentId}, run ${params.runId}), ` +
    `status ${params.status}.${task} The user sees it as a card from ${params.name}. ` +
    `It is ${params.name}'s report, not your reply.]`
  );
}

export async function presentSubagentResult(params: {
  requesterSessionKey: string;
  requesterAgentId?: string;
  /** The generation admitted at spawn; a reset or replaced chat never receives the row. */
  requesterSessionId?: string;
  requesterLifecycleRevision?: string;
  childSessionKey: string;
  childRunId: string;
  childAgentId?: string;
  label?: string;
  task?: string;
  status: SubagentRunOutcome["status"];
  reply?: string;
  isCurrent: () => boolean;
  signal?: AbortSignal;
}): Promise<SubagentResultPresentationOutcome> {
  const requesterSessionId = normalizeOptionalString(params.requesterSessionId);
  if (!requesterSessionId) {
    // Spawn admission requires this generation, so a missing one cannot recover on retry.
    return "intentional_non_delivery";
  }
  const status: SubagentResultStatus = params.status === "unknown" ? "stopped" : params.status;
  const childAgentId = params.childAgentId ?? resolveAgentIdFromSessionKey(params.childSessionKey);
  const label = normalizeOptionalString(params.label);
  const name = label ?? childAgentId;
  const rawTask = normalizeOptionalString(params.task);
  const task = rawTask ? truncateUtf16WithEllipsis(rawTask, TASK_EXCERPT_MAX_CHARS) : undefined;
  const result = resolveResultText(name, status, normalizeOptionalString(params.reply));
  const attribution = resolveModelAttribution({
    name,
    agentId: childAgentId,
    runId: params.childRunId,
    status,
    task,
  });
  const committed = await commitBackgroundResultToSession({
    agentId: params.requesterAgentId ?? resolveAgentIdFromSessionKey(params.requesterSessionKey),
    sessionKey: params.requesterSessionKey,
    expectedGeneration: {
      sessionId: requesterSessionId,
      lifecycleRevision: params.requesterLifecycleRevision,
    },
    text: `${attribution}\n\n${result}`,
    // People see only the Claw's result; the attribution is for the bot's model.
    prepareDisplayContent: async () => [{ type: "text", text: result }],
    idempotencyKey: `subagent-result:${params.childRunId}`,
    provenance: {
      kind: "subagent",
      runId: params.childRunId,
      childSessionKey: params.childSessionKey,
      agentId: childAgentId,
      ...(label ? { label } : {}),
      status,
      ...(task ? { task } : {}),
    },
    config: getRuntimeConfig(),
    signal: params.signal,
    assertCurrent: () => {
      if (!params.isCurrent()) {
        throw new Error("Subagent result delivery is no longer current.");
      }
    },
  });
  if (committed.ok) {
    return "delivered";
  }
  return committed.kind === "not_committed" ? "retryable" : "intentional_non_delivery";
}
