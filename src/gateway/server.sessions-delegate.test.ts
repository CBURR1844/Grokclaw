// Real Gateway proof: sessions.delegate starts a Claw through the bot's policy, and the
// Claw's reply lands as a forwarded result row without starting a bot turn.
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { buildAgentRunTerminalReplySnapshot } from "../agents/agent-run-terminal-reply.js";
import type { AgentCommandGatewayIngressOpts } from "../agents/command/types.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { settleSubagentRegistryPersistenceWork } from "../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import {
  agentCommandMock,
  installGatewayTestHooks,
  prepareGatewayReplyRuntimeForTest,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

const BOT_KEY = "agent:main:main";
type Delegated = { status: string; runId: string; childSessionKey: string };
type HistoryMessage = Record<string, unknown> & { __openclaw?: Record<string, unknown> };

describe("sessions.delegate through the Gateway", () => {
  let harness: GatewayServerHarness;
  let sequence = 0;
  let sessionId: string;
  installGatewayTestHooks({
    scope: "suite",
    setup: async () => {
      harness = await startGatewayServerHarness();
    },
    cleanup: async () => harness?.close(),
  });

  // Each Claw reply resolves once its result row is committed to the bot's chat.
  const committed = new Map<string, ReturnType<typeof createDeferred<void>>>();
  const resultRow = (runId: string) => {
    let row = committed.get(runId);
    if (!row) {
      row = createDeferred<void>();
      committed.set(runId, row);
    }
    return row;
  };

  beforeEach(async () => {
    sequence += 1;
    sessionId = `bot-session-${sequence}`;
    // Each agent keeps its own store; the Claw's child sessions live under its own agent.
    const storePath = (agentId: string) =>
      path.join(process.env.OPENCLAW_STATE_DIR!, "agents", agentId, "sessions", "sessions.json");
    testState.sessionStorePath = storePath("{agentId}");
    // The agent command is mocked; spawn admission only needs a model it can resolve.
    const provider = buildMockOpenAiResponsesProvider("http://127.0.0.1:9/v1");
    const configPath = process.env.OPENCLAW_CONFIG_PATH!;
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({ models: { providers: { [provider.providerId]: provider.config } } }),
    );
    testState.agentConfig = { model: { primary: provider.modelRef } };
    testState.agentsConfig = {
      entries: {
        main: { subagents: { allowAgents: ["claw"] } },
        claw: { identity: { name: "Researcher" } },
        other: {},
      },
    };
    await writeSessionStore({
      entries: { [BOT_KEY]: { sessionId, updatedAt: Date.now() } },
      storePath: storePath("main"),
    });
    await prepareGatewayReplyRuntimeForTest({ force: true });
    agentCommandMock.mockReset();
    agentCommandMock.mockImplementation(async (opts: AgentCommandGatewayIngressOpts) => {
      const sessionKey = opts.sessionKey ?? "";
      const routing = {
        runId: opts.runId ?? "",
        sessionKey,
        sessionId: opts.sessionId,
        agentId: opts.agentId,
        lifecycleGeneration: opts.lifecycleGeneration,
      };
      // The child prompt wraps the task, so the reply names only which task it saw.
      const text = `Findings for ${opts.message?.includes("second task") ? "second" : "first"} task`;
      emitAgentEvent({ ...routing, stream: "lifecycle", data: { phase: "start" } });
      await persistSessionTranscriptTurn(
        { sessionId: opts.sessionId ?? "", sessionKey, agentId: opts.agentId },
        {
          cwd: "/tmp",
          updateMode: "none",
          messages: [{ message: { role: "assistant", content: [{ type: "text", text }] } }],
        },
      );
      emitAgentEvent({
        ...routing,
        stream: "lifecycle",
        data: {
          phase: "end",
          terminalReply: buildAgentRunTerminalReplySnapshot({ visibleText: text, rawText: text }),
        },
      });
    });
  });

  async function delegate(
    ws: Awaited<ReturnType<GatewayServerHarness["openClient"]>>["ws"],
    params: {
      targetAgentId: string;
      task: string;
      idempotencyKey: string;
    },
  ) {
    return await rpcReq<Delegated>(ws, "sessions.delegate", {
      sessionKey: BOT_KEY,
      sessionId,
      ...params,
    });
  }

  it("refuses a target outside the bot's allowed agents", async () => {
    const { ws } = await harness.openClient({ scopes: ["operator.read", "operator.write"] });
    const refused = await delegate(ws, {
      targetAgentId: "other",
      task: "Look around",
      idempotencyKey: `refused-${sequence}`,
    });

    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe("FORBIDDEN");
    expect(refused.error?.message).toMatch(/^agentId is not allowed for sessions_spawn/);
    expect(agentCommandMock).not.toHaveBeenCalled();
    ws.close();
  });

  it("shows two concurrent Claw results as forwarded rows without a bot turn", async () => {
    const stop = onSessionTranscriptUpdate((update) => {
      const automation = (update.message as { openclawAutomation?: { runId?: unknown } })
        ?.openclawAutomation;
      if (update.sessionKey === BOT_KEY && typeof automation?.runId === "string") {
        resultRow(automation.runId).resolve();
      }
    });
    const { ws } = await harness.openClient({ scopes: ["operator.read", "operator.write"] });
    try {
      const [first, second] = await Promise.all([
        delegate(ws, {
          targetAgentId: "claw",
          task: "first task",
          idempotencyKey: `a-${sequence}`,
        }),
        delegate(ws, {
          targetAgentId: "claw",
          task: "second task",
          idempotencyKey: `b-${sequence}`,
        }),
      ]);
      expect(first.ok, JSON.stringify(first.error)).toBe(true);
      expect(second.ok, JSON.stringify(second.error)).toBe(true);
      const runs = [first.payload!, second.payload!];
      for (const run of runs) {
        expect(run).toMatchObject({
          status: "accepted",
          childSessionKey: expect.stringMatching(/^agent:claw:subagent:/),
        });
        expect(subagentRuns.get(run.runId)?.completionPresentation).toBe("result");
      }

      await Promise.all(runs.map((run) => resultRow(run.runId).promise));
      await settleSubagentRegistryPersistenceWork();

      const history = await rpcReq<{ messages: HistoryMessage[] }>(ws, "chat.history", {
        sessionKey: BOT_KEY,
        limit: 20,
      });
      expect(history.ok, JSON.stringify(history.error)).toBe(true);
      const rows = history.payload?.messages.filter((message) => message.openclawAutomation) ?? [];
      expect(rows).toHaveLength(2);
      for (const [index, run] of runs.entries()) {
        const row = rows.find(
          (message) => (message.openclawAutomation as { runId?: string }).runId === run.runId,
        );
        expect(row).toMatchObject({
          role: "assistant",
          model: "automation-result",
          senderLabel: "Forwarded from Researcher",
          senderSession: { sessionKey: run.childSessionKey, agentId: "claw", label: "Researcher" },
          openclawAutomation: {
            kind: "subagent",
            runId: run.runId,
            childSessionKey: run.childSessionKey,
            agentId: "claw",
            label: "Researcher",
            status: "ok",
            task: index === 0 ? "first task" : "second task",
          },
          __openclaw: expect.objectContaining({ turnBoundary: true }),
        });
        expect(JSON.stringify(row?.content)).toContain(
          `Findings for ${index === 0 ? "first task" : "second task"}`,
        );
        const entry = subagentRuns.get(run.runId);
        expect(entry?.delivery?.status).toBe("delivered");
        expect(entry?.requesterSettleWake).toBeUndefined();
      }
      const turns = agentCommandMock.mock.calls.map(([opts]) => opts.sessionKey);
      expect(turns).toHaveLength(2);
      expect(turns).not.toContain(BOT_KEY);
    } finally {
      stop();
      ws.close();
    }
  });
});
