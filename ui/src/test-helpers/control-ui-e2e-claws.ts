import type { MockGatewayWindow } from "./control-ui-e2e-contract.ts";

type ClawRunStatus = "ok" | "error" | "timeout" | "stopped";

/** The Claws a mock Gateway can start, by agent id: the name its result carries and how it ends. */
export type ClawDelegationMock = Record<
  string,
  { label: string; status?: ClawRunStatus; reply?: string }
>;

/**
 * Runs in the page after the mock Gateway: answers sessions.delegate as the Gateway does, then
 * commits an admitted Claw's result to the bot's chat in the shape chat.history projects it.
 * It is serialized into an init script, so it imports nothing.
 */
function installClawDelegationMock(claws: ClawDelegationMock): void {
  const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
  if (!gateway) {
    throw new Error("Claw delegation fixtures require the mock Gateway");
  }
  const FIELDS = new Set(["sessionKey", "sessionId", "targetAgentId", "task", "idempotencyKey"]);
  const HOST_LINES = { error: "hit an error", timeout: "timed out", stopped: "stopped" };
  const isParamsObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const isText = (value: unknown, max: number): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= max;
  const refuse = (code: string, message: string) => ({ __mockError: { code, message } });
  const currentSessionId = (sessionKey: string) => {
    try {
      return gateway.getSessionRow(sessionKey).sessionId;
    } catch {
      return undefined;
    }
  };
  // As on the Gateway, a key belongs to its first request and keeps only an accepted run: a
  // retry joins the run it may have started, and a refused request is evaluated again.
  const keys = new Map<string, { identity: string; result?: Record<string, string> }>();
  let runCount = 0;
  gateway.setRequestHandler("sessions.delegate", ({ params, respond }) => {
    if (!isParamsObject(params) || Object.keys(params).some((key) => !FIELDS.has(key))) {
      respond(refuse("INVALID_REQUEST", "invalid sessions.delegate params"));
      return;
    }
    const { sessionKey, sessionId, targetAgentId, task, idempotencyKey } = params;
    if (
      !isText(sessionKey, 512) ||
      !(sessionId === undefined || isText(sessionId, 512)) ||
      !isText(targetAgentId, 128) ||
      !isText(task, 16_000) ||
      !isText(idempotencyKey, 128)
    ) {
      respond(refuse("INVALID_REQUEST", "invalid sessions.delegate params"));
      return;
    }
    if (sessionId && currentSessionId(sessionKey) !== sessionId) {
      respond(
        refuse("INVALID_REQUEST", "This chat changed since you opened it. Reload and try again."),
      );
      return;
    }
    const identity = JSON.stringify([sessionKey, targetAgentId, task]);
    const known = keys.get(idempotencyKey) ?? { identity };
    if (known.identity !== identity) {
      respond(
        refuse("INVALID_REQUEST", "This request key was already used for a different request."),
      );
      return;
    }
    if (known.result) {
      respond(known.result);
      return;
    }
    keys.set(idempotencyKey, known);
    const claw = claws[targetAgentId];
    if (!claw) {
      respond(refuse("FORBIDDEN", `agentId is not allowed for sessions_spawn: ${targetAgentId}`));
      return;
    }
    runCount += 1;
    const runId = `mock-claw-run-${runCount}`;
    const childSessionKey = `agent:${targetAgentId}:subagent:${runId}`;
    known.result = { status: "accepted", runId, childSessionKey };
    respond(known.result);
    // A real run reports back when the Claw finishes; the mock finishes at once.
    const status = claw.status ?? "ok";
    const text =
      status === "ok"
        ? (claw.reply ?? `${claw.label} finished.`)
        : `${claw.label} didn't finish (${HOST_LINES[status]}). Open the run to see what it did.`;
    const excerpt = task.length > 120 ? `${task.slice(0, 119)}…` : task;
    const source = { agentId: targetAgentId, label: claw.label };
    gateway.commitHistoryMessage(sessionKey, {
      role: "assistant",
      model: "automation-result",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
      openclawAutomation: {
        kind: "subagent",
        runId,
        childSessionKey,
        ...source,
        status,
        task: excerpt,
      },
      senderSession: { sessionKey: childSessionKey, ...source },
      senderLabel: `Forwarded from ${claw.label}`,
      __openclaw: { turnBoundary: true },
    });
  });
}

/** An init script that gives the mock Gateway installed before it a sessions.delegate. */
export function clawDelegationMockInitScript(claws: ClawDelegationMock): string {
  return `(() => { const __name = (target) => target; (${installClawDelegationMock.toString()})(${JSON.stringify(claws)}); })();`;
}
