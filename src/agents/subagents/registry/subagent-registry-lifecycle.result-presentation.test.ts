// Result runs are presented by the host; their completion never starts a requester turn.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { replaceSessionEntrySync } from "../../../config/sessions/session-accessor.js";
import type { CallGatewayOptions } from "../../../gateway/call.js";
import { resetGatewayWorkAdmission } from "../../../process/gateway-work-admission.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "./subagent-lifecycle-events.js";
import { mockBlockedCompletionDeliveryOwner } from "./subagent-registry-lifecycle-completion.test-support.js";
import {
  createLifecycleControllerFixture,
  createRunEntry,
  readLifecycleRun,
} from "./subagent-registry-lifecycle-controller.test-support.js";
import type {
  SubagentLifecycleController,
  SubagentLifecycleOptions,
} from "./subagent-registry-lifecycle.js";
import { claimSubagentYieldInRuns } from "./subagent-registry-run-pause.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const completionDeliveryMocks = vi.hoisted(() => ({
  blockSubagentCompletionDelivery: vi.fn(),
  mutateRequesterCompletionBatch: vi.fn(),
  ownersByEntry: new Map<object, Pick<SubagentLifecycleOptions, "runs">>(),
}));
const gatewayMocks = vi.hoisted(() => ({
  callGateway: vi.fn(async (_opts: CallGatewayOptions) => ({})),
}));
const browserCleanup = vi.hoisted(() => ({
  cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
}));

vi.mock("../completion/subagent-completion-admission.store.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../completion/subagent-completion-admission.store.js")
  >()),
  blockSubagentCompletionDelivery: completionDeliveryMocks.blockSubagentCompletionDelivery,
  mutateRequesterCompletionBatch: completionDeliveryMocks.mutateRequesterCompletionBatch,
}));
// mock-isolation: Run-end side effects (browser, MCP, session effects, logging) stay outside this state test.
vi.mock("../../../browser-lifecycle-cleanup.js", () => browserCleanup);
// mock-isolation: See above; MCP runtimes are process-wide.
vi.mock("../../agent-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntimeForSessionKey: vi.fn(async () => true),
}));
// mock-isolation: See above; session effects write shared state.
vi.mock("../../internal-session-effects.js", () => ({
  removeInternalSessionEffectsSession: vi.fn(async () => {}),
}));
// mock-isolation: Silences the process logger.
vi.mock("../../../runtime.js", () => ({ defaultRuntime: { log: vi.fn() } }));
// mock-isolation: Each test supplies the announce outcome; the real flow has its own tests.
vi.mock("../announce/subagent-announce.js", () => ({
  captureSubagentCompletionReply: vi.fn(async () => undefined),
  runSubagentAnnounceFlow: vi.fn(async () => "retryable" as const),
}));
// A retryable attempt gives up at once, so the expiry arming path runs without timers.
vi.mock("./subagent-registry-cleanup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./subagent-registry-cleanup.js")>()),
  resolveDeferredCleanupDecision: () => ({ kind: "give-up", reason: "expiry" }),
}));

type AnnounceOutcome = Awaited<ReturnType<SubagentLifecycleOptions["runSubagentAnnounceFlow"]>>;

function startRun(
  entry: SubagentRunRecord,
  outcome: AnnounceOutcome,
  overrides: Partial<SubagentLifecycleOptions> = {},
) {
  const wake = vi.fn(async () => false);
  const announce = vi.fn<SubagentLifecycleOptions["runSubagentAnnounceFlow"]>(async () => outcome);
  const controller: SubagentLifecycleController = createLifecycleControllerFixture(
    {
      entry,
      runSubagentAnnounceFlow: announce,
      maybeWakeRequesterAfterAllChildrenSettled: wake,
      ...overrides,
    },
    {
      callGateway: async <T = Record<string, unknown>>(opts: CallGatewayOptions): Promise<T> =>
        (await gatewayMocks.callGateway(opts)) as T,
      cleanupBrowserSessionsForLifecycleEnd: browserCleanup.cleanupBrowserSessionsForLifecycleEnd,
      ownersByEntry: completionDeliveryMocks.ownersByEntry,
    },
  );
  return { announce, controller, wake };
}

async function completeAndSettle(
  controller: SubagentLifecycleController,
  entry: SubagentRunRecord,
  terminalReply: { disposition: "visible"; text: string } | { disposition: "empty" },
  status: "ok" | "error" = "ok",
) {
  await controller.completeSubagentRun({
    runId: entry.runId,
    endedAt: 4_000,
    outcome: { status },
    reason: SUBAGENT_ENDED_REASON_COMPLETE,
    triggerCleanup: true,
    terminalReply,
  });
  await vi.waitFor(() => expect(readLifecycleRun(entry).cleanupCompletedAt).toBeTypeOf("number"), {
    interval: 1,
  });
}

const resultRun = (completionPresentation?: "result") =>
  createRunEntry({
    expectsCompletionMessage: true,
    completionRequesterSessionId: "requester-session",
    ...(completionPresentation ? { completionPresentation } : {}),
  });

describe("result presentation lifecycle", () => {
  beforeAll(() => {
    // Session reads and retained generation checks must observe the same canonical row.
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:subagent:child" },
      { sessionId: "child-session-id", lifecycleRevision: "child-revision", updatedAt: 1 },
    );
  });

  beforeEach(() => {
    resetGatewayWorkAdmission();
    vi.clearAllMocks();
    mockBlockedCompletionDeliveryOwner(completionDeliveryMocks);
  });

  it("arms the requester settle wake for an ordinary completion", async () => {
    const entry = resultRun();
    const { controller, wake } = startRun(entry, "delivered");
    await completeAndSettle(controller, entry, { disposition: "visible", text: "Done." });
    await vi.waitFor(() => expect(wake).toHaveBeenCalledOnce(), { interval: 1 });
  });

  it.each([
    { outcome: "delivered", status: "ok", delivery: "delivered" },
    { outcome: "intentional_non_delivery", status: "ok", delivery: "failed" },
    // A failed run that cannot be presented gives up through the expiry path.
    { outcome: "retryable", status: "error", delivery: "failed" },
  ] as const)(
    "never arms the requester settle wake after a $outcome result",
    async ({ outcome, status, delivery }) => {
      const entry = resultRun("result");
      const { announce, controller, wake } = startRun(entry, outcome);
      await completeAndSettle(controller, entry, { disposition: "visible", text: "Done." }, status);

      expect(announce).toHaveBeenCalledWith(
        expect.objectContaining({
          completionPresentation: "result",
          completionRequesterSessionId: "requester-session",
        }),
      );
      const settled = readLifecycleRun(entry);
      expect(settled.requesterSettleWake).toBeUndefined();
      expect(settled.delivery?.status).toBe(delivery);
      expect(wake).not.toHaveBeenCalled();
    },
  );

  it("gives up an unpresented success without suspending it into a requester wake", async () => {
    // The commit kept failing until expiry; suspension would hand the findings to the bot.
    const entry = resultRun("result");
    const settled = createDeferred<void>();
    const wake = vi.fn(async () => {
      settled.resolve();
      return false;
    });
    const { controller } = startRun(entry, "retryable", {
      maybeWakeRequesterAfterAllChildrenSettled: wake,
      // Terminal cleanup ends with the ended hook; awaiting it avoids polling.
      shouldEmitEndedHookForRun: () => true,
      emitSubagentEndedHookForRun: vi.fn(async () => settled.resolve()),
    });
    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: true,
      terminalReply: { disposition: "visible", text: "Done." },
    });
    await settled.promise;

    const settledRun = readLifecycleRun(entry);
    expect(settledRun.delivery?.status).toBe("failed");
    expect(settledRun.requesterSettleWake).toBeUndefined();
    // The blocked-delivery system event is queued only by the suspension owner.
    expect(completionDeliveryMocks.blockSubagentCompletionDelivery).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
  });

  it("refuses a pause notice so a waiting Claw cannot wake the requester", async () => {
    const entry = resultRun("result");
    const runs = new Map([[entry.runId, entry]]);
    const claim = await claimSubagentYieldInRuns({
      runId: entry.runId,
      sessionKey: entry.childSessionKey,
      agentId: "main",
      waitForMessage: true,
      acknowledgment: "Which repository should I read?",
      hasPendingWork: () => false,
      runs,
      context: captureOpenClawStateWorkerContext(),
      assertCurrent: () => {},
    });

    // Like a collector run, the Claw is told to finish; its final reply becomes the card.
    expect(claim).toBe("nothing-pending");
    expect(runs.get(entry.runId)?.requesterSettleWake).toBeUndefined();
  });

  it("presents an empty success instead of closing it silently", async () => {
    const entry = resultRun("result");
    const { announce, controller, wake } = startRun(entry, "delivered");
    await completeAndSettle(controller, entry, { disposition: "empty" });

    expect(announce).toHaveBeenCalledOnce();
    expect(readLifecycleRun(entry).delivery?.status).toBe("delivered");
    expect(wake).not.toHaveBeenCalled();
  });
});
