// Host-presented result runs: request validation and the durable registration flag.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installAcceptedSubagentGatewayMock } from "../../test-helpers/subagent-gateway.js";
import {
  createConfigOverride,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
  supportedSpawnModelChoice,
} from "./subagent-spawn.test-helpers.js";

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  loadSessionStoreMock: vi.fn(),
  prepareModelChoiceMock: vi.fn<typeof supportedSpawnModelChoice>(),
  updateSessionStoreMock: vi.fn(),
  registerSubagentRunMock: vi.fn(),
  startQueuedSubagentRunMock: vi.fn(),
  settleFailedQueuedSubagentLaunchMock: vi.fn(),
  completeCollectorLaunchCleanupMock: vi.fn(),
  emitSessionLifecycleEventMock: vi.fn(),
  dispatchGatewayMethodInProcessMock: vi.fn(),
  hasInProcessGatewayContextMock: vi.fn(),
  resolveContextEngineMock: vi.fn(),
  resolveSandboxRuntimeStatusMock: vi.fn(() => ({ sandboxed: false, sandboxRequired: false })),
}));

let configOverride: Record<string, unknown>;
let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;
let resetSubagentRegistryForTests: typeof import("../registry/subagent-registry.test-helpers.js").resetSubagentRegistryForTests;

const RESULT_NOTE = "The final reply is shown to the user in the requester's chat as the result.";

function spawnResult(
  params: Parameters<typeof spawnSubagentDirect>[0],
  agentSessionKey = "agent:main:main",
) {
  return spawnSubagentDirect(params, { agentSessionKey, completionPresentation: "result" });
}

function expectNoChildEffects() {
  expect(hoisted.updateSessionStoreMock).not.toHaveBeenCalled();
  expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
  expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
}

describe("result presentation spawn admission", () => {
  beforeAll(async () => {
    ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      ...hoisted,
      getRuntimeConfig: () => configOverride,
      resolveContextEngineMock: hoisted.resolveContextEngineMock,
      resolveSandboxRuntimeStatus: hoisted.resolveSandboxRuntimeStatusMock,
      sessionStorePath: "/tmp/subagent-spawn-result-store.json",
    }));
  });

  beforeEach(async () => {
    await resetSubagentRegistryForTests();
    for (const mock of Object.values(hoisted)) {
      mock.mockReset();
    }
    hoisted.prepareModelChoiceMock.mockImplementation(supportedSpawnModelChoice);
    hoisted.startQueuedSubagentRunMock.mockResolvedValue(true);
    hoisted.hasInProcessGatewayContextMock.mockReturnValue(false);
    hoisted.resolveContextEngineMock.mockResolvedValue({});
    hoisted.resolveSandboxRuntimeStatusMock.mockReturnValue({
      sandboxed: false,
      sandboxRequired: false,
    });
    hoisted.loadSessionStoreMock.mockReturnValue({});
    installAcceptedSubagentGatewayMock(hoisted.callGatewayMock);
    configOverride = createConfigOverride();
  });

  it.each([
    { mode: "session" },
    { thread: true },
    { expectsCompletionMessage: false },
    { completionTarget: "parent" },
  ] as const)("rejects a result run that cannot present its reply: %j", async (options) => {
    const result = await spawnResult({ task: "summarize", ...options });
    expect(result).toEqual({
      status: "error",
      error:
        'A result run requires mode="run", no thread, collector or private completion, and completion notifications enabled.',
    });
    expectNoChildEffects();
  });

  it("rejects a result run without the bot's current chat", async () => {
    const result = await spawnResult({ task: "summarize" }, "agent:main:missing");
    expect(result).toEqual({
      status: "error",
      error: "A Claw result needs the bot's current chat.",
    });
    expectNoChildEffects();
  });

  it("registers the host-presented run against the requester generation", async () => {
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:main:main": {
        sessionId: "requester-session",
        lifecycleRevision: "requester-revision",
        updatedAt: 1,
      },
    });
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);

    const result = await spawnResult({ task: "summarize", mode: "run" });

    expect(result).toMatchObject({ status: "accepted" });
    expect(hoisted.registerSubagentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: result.runId,
        completionPresentation: "result",
        completionRequesterSessionId: "requester-session",
        completionRequesterLifecycleRevision: "requester-revision",
        expectsCompletionMessage: true,
      }),
      expect.anything(),
    );
    await vi.waitFor(() =>
      expect(hoisted.callGatewayMock).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "agent",
          params: expect.objectContaining({
            extraSystemPrompt: expect.stringContaining(RESULT_NOTE),
          }),
        }),
      ),
    );
  });
});
