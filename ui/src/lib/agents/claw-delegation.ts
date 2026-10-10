import type { SessionsDelegateParams } from "@openclaw/gateway-protocol";
import { truncateCodePoints } from "@openclaw/normalization-core/code-points";
import {
  isCronSessionKey,
  parseAgentSessionKey,
} from "../../../../src/sessions/session-key-utils.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../format-error.ts";
import { readSessionMethodAccess, type SessionMethodAccess } from "../session-method-access.ts";
import { isSubagentSessionKey } from "../sessions/session-key.ts";

/** Starting a Claw from a chat needs operator.write; the Gateway still admits each request. */
export function readClawDelegationAccess(
  snapshot: Parameters<typeof readSessionMethodAccess>[0],
): SessionMethodAccess {
  return readSessionMethodAccess(snapshot, {
    method: "sessions.delegate",
    requiredScope: "operator.write",
  });
}

/** The most text one Claw task carries: the limit sessions.delegate admits. */
const CLAW_TASK_MAX_CHARS = 16_000;

/** Whether text is longer than one Claw task can be, counted the way sessions.delegate counts. */
export function isClawTaskTooLong(task: string): boolean {
  // The Gateway's schema counts code points, so an emoji is one character, not two.
  return truncateCodePoints(task, CLAW_TASK_MAX_CHARS).length < task.length;
}

/**
 * Whether a chat offers its Claws at all. The Gateway admits only a bot's own chat key, so a
 * global-scope chat has none; it refuses helper and routine chats; and an incognito chat stays
 * out of other sessions' reach, Claws included.
 */
export function chatOffersClaws(chat: { sessionKey: string; incognito: boolean }): boolean {
  return (
    !chat.incognito &&
    parseAgentSessionKey(chat.sessionKey) !== null &&
    !isSubagentSessionKey(chat.sessionKey) &&
    !isCronSessionKey(chat.sessionKey)
  );
}

/**
 * Starts a Claw through the chat's bot and returns what to tell the user, or null once it
 * started: the chat's working line shows that. Only a Gateway refusal is certain; any other
 * failure leaves the run unknown. This never retries: a retry reuses the caller's
 * idempotency key, so the Gateway can answer it with the run the first attempt started.
 */
export async function delegateToClaw(
  client: GatewayBrowserClient,
  request: SessionsDelegateParams,
  clawName: string,
): Promise<string | null> {
  try {
    await client.request("sessions.delegate", request);
    return null;
  } catch (error) {
    return error instanceof GatewayRequestError
      ? t("chat.commandControls.failed", { error: formatUiError(error) })
      : t("chat.commandControls.clawUncertain", { name: clawName });
  }
}
