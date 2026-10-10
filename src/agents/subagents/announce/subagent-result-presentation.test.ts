import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackgroundSessionResultCommit } from "../../../sessions/background-session-result.js";
import { presentSubagentResult } from "./subagent-result-presentation.js";

const commitMocks = vi.hoisted(() => ({
  commitBackgroundResultToSession:
    vi.fn<(input: Record<string, unknown>) => Promise<BackgroundSessionResultCommit>>(),
}));

// mock-isolation: Transcript commits write SQLite; the test checks only what would be committed.
vi.mock("../../../sessions/background-session-result.js", () => commitMocks);
// mock-isolation: The announce runtime barrel loads live config; the test pins a synthetic store.
vi.mock("./subagent-announce.runtime.js", () => ({
  getRuntimeConfig: () => ({ session: { store: "/synthetic/sessions.json" } }),
  resolveAgentIdFromSessionKey: (key: string) => key.split(":")[1] ?? "main",
}));

const base = {
  requesterSessionKey: "agent:main:main",
  requesterAgentId: "main",
  requesterSessionId: "requester-session",
  requesterLifecycleRevision: "requester-revision",
  childSessionKey: "agent:claw:subagent:child",
  childRunId: "run-claw",
  childAgentId: "claw",
  label: "Researcher",
  task: "Summarize the thread",
  status: "ok",
  reply: "Here is the summary.",
  isCurrent: () => true,
} as const;

function committedInput() {
  const call = commitMocks.commitBackgroundResultToSession.mock.calls.at(-1);
  if (!call) {
    throw new Error("Expected a committed result");
  }
  return call[0];
}

describe("presentSubagentResult", () => {
  beforeEach(() => {
    commitMocks.commitBackgroundResultToSession.mockReset();
    commitMocks.commitBackgroundResultToSession.mockResolvedValue({ ok: true, messageId: "m1" });
  });

  it("commits the Claw's own reply to the generation admitted at spawn", async () => {
    await expect(presentSubagentResult(base)).resolves.toBe("delivered");
    expect(committedInput()).toMatchObject({
      agentId: "main",
      sessionKey: "agent:main:main",
      expectedGeneration: {
        sessionId: "requester-session",
        lifecycleRevision: "requester-revision",
      },
      text: "Here is the summary.",
      idempotencyKey: "subagent-result:run-claw",
      provenance: {
        kind: "subagent",
        runId: "run-claw",
        childSessionKey: "agent:claw:subagent:child",
        agentId: "claw",
        label: "Researcher",
        status: "ok",
        task: "Summarize the thread",
      },
    });
  });

  it.each([
    [
      "timeout",
      "timeout",
      "Researcher didn't finish (timed out). Open the run to see what it did.",
    ],
    ["error", "error", "Researcher didn't finish (hit an error). Open the run to see what it did."],
    ["unknown", "stopped", "Researcher didn't finish (stopped). Open the run to see what it did."],
  ] as const)("writes a host line for a %s run", async (status, recorded, text) => {
    await presentSubagentResult({ ...base, status, reply: "partial progress" });
    expect(committedInput()).toMatchObject({ text, provenance: { status: recorded } });
  });

  it("names an unlabeled empty success by agent and bounds the task excerpt", async () => {
    await presentSubagentResult({ ...base, label: undefined, reply: "  ", task: "x".repeat(400) });
    const input = committedInput();
    expect(input.text).toBe("claw finished without a reply. Open the run to see what it did.");
    expect(input.provenance).not.toHaveProperty("label");
    expect((input.provenance as { task: string }).task).toHaveLength(120);
  });

  it.each([
    ["rebound", "intentional_non_delivery"],
    ["unavailable", "intentional_non_delivery"],
    ["not_committed", "retryable"],
  ] as const)("maps a %s commit to %s", async (kind, outcome) => {
    commitMocks.commitBackgroundResultToSession.mockResolvedValue({
      ok: false,
      kind,
      reason: kind,
    });
    await expect(presentSubagentResult(base)).resolves.toBe(outcome);
  });

  it("drops a run without a requester generation instead of retrying it", async () => {
    await expect(presentSubagentResult({ ...base, requesterSessionId: undefined })).resolves.toBe(
      "intentional_non_delivery",
    );
    expect(commitMocks.commitBackgroundResultToSession).not.toHaveBeenCalled();
  });

  it("refuses to commit after the delivery owner changes", async () => {
    let current = true;
    commitMocks.commitBackgroundResultToSession.mockImplementation(async () => {
      current = false;
      (committedInput().assertCurrent as () => void)();
      return { ok: true, messageId: "m1" };
    });
    await expect(presentSubagentResult({ ...base, isCurrent: () => current })).rejects.toThrow(
      "no longer current",
    );
  });
});
