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

/** What people see: the row's display content. */
async function shownText() {
  const prepare = committedInput().prepareDisplayContent as () => Promise<{ text: string }[]>;
  const blocks = await prepare();
  return blocks.map((block) => block.text).join("");
}

describe("presentSubagentResult", () => {
  beforeEach(() => {
    commitMocks.commitBackgroundResultToSession.mockReset();
    commitMocks.commitBackgroundResultToSession.mockResolvedValue({ ok: true, messageId: "m1" });
  });

  it("commits the Claw's own reply to the generation admitted at spawn, named for the bot's model", async () => {
    await expect(presentSubagentResult(base)).resolves.toBe("delivered");
    expect(committedInput()).toMatchObject({
      agentId: "main",
      sessionKey: "agent:main:main",
      expectedGeneration: {
        sessionId: "requester-session",
        lifecycleRevision: "requester-revision",
      },
      text:
        '[Result from the Claw Researcher (agent claw, run run-claw), status ok. Task: "Summarize the thread". ' +
        "The user sees it as a card from Researcher. It is Researcher's report, not your reply.]" +
        "\n\nHere is the summary.",
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
    expect(await shownText()).toBe("Here is the summary.");
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
    expect(committedInput()).toMatchObject({ provenance: { status: recorded } });
    expect(committedInput().text).toContain(`, status ${recorded}.`);
    expect(committedInput().text).toContain(`.]\n\n${text}`);
    expect(await shownText()).toBe(text);
  });

  it("names an unlabeled empty success by agent and bounds the task excerpt", async () => {
    await presentSubagentResult({ ...base, label: undefined, reply: "  ", task: "x".repeat(400) });
    const input = committedInput();
    const task = (input.provenance as { task: string }).task;
    expect(await shownText()).toBe(
      "claw finished without a reply. Open the run to see what it did.",
    );
    expect(input.text).toContain(`[Result from the Claw claw (agent claw, run run-claw)`);
    expect(input.text).toContain(`Task: "${task}".`);
    expect(input.provenance).not.toHaveProperty("label");
    expect(task).toHaveLength(120);
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
