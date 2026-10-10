import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";

export type ClawResult = {
  status: "ok" | "error" | "timeout" | "stopped";
  /** The Gateway's bounded excerpt of the task the Claw was given. */
  task?: string;
};

const STATUSES: ReadonlySet<unknown> = new Set<ClawResult["status"]>([
  "ok",
  "error",
  "timeout",
  "stopped",
]);

function isStatus(value: unknown): value is ClawResult["status"] {
  return STATUSES.has(value);
}

/**
 * A Claw's result in its bot's chat: the Gateway commits the Claw's final reply as an
 * automation-result row whose raw `openclawAutomation` names the subagent run. Results
 * start their own group, so the group's first message decides.
 */
export function readClawResult(messages: readonly { message: unknown }[]): ClawResult | null {
  const automation = asNullableRecord(asNullableRecord(messages[0]?.message)?.openclawAutomation);
  if (automation?.kind !== "subagent" || !isStatus(automation.status)) {
    return null;
  }
  const task = typeof automation.task === "string" ? automation.task.trim() : "";
  return { status: automation.status, ...(task ? { task } : {}) };
}
