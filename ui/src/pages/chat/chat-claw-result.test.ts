import { describe, expect, it } from "vitest";
import { readClawResult } from "./chat-claw-result.ts";

const row = (openclawAutomation: unknown) => [
  {
    message: {
      role: "assistant",
      model: "automation-result",
      content: [{ type: "text", text: "46 emails sorted." }],
      openclawAutomation,
    },
  },
];
const subagent = {
  kind: "subagent",
  runId: "run-1",
  childSessionKey: "agent:sorter:subagent:1",
  agentId: "sorter",
  label: "Inbox Sorter",
};

describe("readClawResult", () => {
  it.each([
    [
      "a finished run with its task",
      { ...subagent, status: "ok", task: " Sort my inbox " },
      { status: "ok", task: "Sort my inbox" },
    ],
    [
      "a failed run without a task",
      { ...subagent, status: "error", task: "  " },
      { status: "error" },
    ],
    ["a timed-out run", { ...subagent, status: "timeout" }, { status: "timeout" }],
    ["a stopped run", { ...subagent, status: "stopped" }, { status: "stopped" }],
  ])("reads %s", (_name, automation, expected) => {
    expect(readClawResult(row(automation))).toEqual(expected);
  });

  it.each([
    ["a routine's result", { kind: "cron", jobId: "job-1", runId: "run-1" }],
    ["an unknown status", { ...subagent, status: "maybe" }],
    ["a row without provenance", undefined],
  ])("ignores %s", (_name, automation) => {
    expect(readClawResult(row(automation))).toBeNull();
  });

  it("decides from the group's first message", () => {
    const result = row({ ...subagent, status: "ok" });
    expect(readClawResult([...result, { message: { role: "assistant" } }])).toEqual({
      status: "ok",
    });
    expect(readClawResult([{ message: { role: "assistant" } }, ...result])).toBeNull();
    expect(readClawResult([])).toBeNull();
  });
});
