// Commits detached background results into an existing conversation generation.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { makeZeroUsageSnapshot } from "../agents/usage.js";
import { resolveSessionWorkStartError } from "../config/sessions/lifecycle.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { readResolvedSessionEntryInWorker } from "../config/sessions/session-accessor.entry.js";
import {
  persistSessionTranscriptTurn,
  type SessionTranscriptTurnPersistOptions,
} from "../config/sessions/session-accessor.js";
import {
  readTranscriptEventId,
  readTranscriptEventMessage,
} from "../config/sessions/session-accessor.sqlite-read.js";
import { findTranscriptEvent } from "../config/sessions/session-transcript-match.js";
import type { SessionTranscriptAssistantMessage } from "../config/sessions/transcript.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { ASSISTANT_DISPLAY_CONTENT_FIELD } from "../shared/assistant-display-content.js";
import {
  OPENCLAW_TRANSCRIPT_ARTIFACT_API,
  OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
} from "../shared/transcript-only-openclaw-assistant.js";
import {
  getSessionWorkAdmissionRelease,
  runExclusiveSessionLifecycleMutation,
} from "./session-lifecycle-admission.js";

// Background completions are durable conversation output, so this identity
// must stay outside the transcript-only delivery-mirror model set.
const AUTOMATION_RESULT_MODEL = "automation-result" as const;

/** "rebound" and "unavailable" are final for the pinned generation; retries cannot commit. */
export type BackgroundSessionResultCommit =
  | { ok: true; messageId: string }
  | { ok: false; kind: "rebound" | "unavailable" | "not_committed"; reason: string };

type BackgroundSessionResultProvenance =
  | { kind: "cron"; jobId: string; runId: string }
  | {
      kind: "subagent";
      runId: string;
      childSessionKey: string;
      agentId: string;
      label?: string;
      status: "ok" | "error" | "timeout" | "stopped";
      task?: string;
    };

/** Serializes a background assistant result behind active work on its target conversation. */
export async function commitBackgroundResultToSession(params: {
  agentId: string;
  sessionKey: string;
  /** Pins output to the conversation generation that admitted the background run. */
  expectedGeneration: { sessionId: string; lifecycleRevision: string | undefined };
  text: string;
  prepareDisplayContent?: () => Promise<readonly Record<string, unknown>[] | undefined>;
  onMessageCommitted?: SessionTranscriptTurnPersistOptions["onMessageCommitted"];
  idempotencyKey: string;
  provenance: BackgroundSessionResultProvenance;
  config: OpenClawConfig;
  signal?: AbortSignal;
  /** Revalidate the producer after preparation and inside the transcript commit. */
  assertCurrent?: () => void;
}): Promise<BackgroundSessionResultCommit> {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const text = normalizeOptionalString(params.text);
  const idempotencyKey = normalizeOptionalString(params.idempotencyKey);
  if (!sessionKey || !text || !idempotencyKey) {
    return {
      ok: false,
      kind: "not_committed",
      reason: "background session result is missing required data",
    };
  }

  const storePath = resolveSessionStorePathCore(params.config.session?.store, {
    agentId: params.agentId,
  });
  const expectedSessionId = normalizeOptionalString(params.expectedGeneration.sessionId);
  if (!expectedSessionId) {
    return {
      ok: false,
      kind: "rebound",
      reason: "background session result has an invalid expected generation",
    };
  }
  const expectedLifecycleRevision = normalizeOptionalString(
    params.expectedGeneration.lifecycleRevision,
  );
  const identities = [sessionKey, expectedSessionId];

  params.assertCurrent?.();
  return await runExclusiveSessionLifecycleMutation("background-result", {
    scope: storePath,
    identities,
    signal: params.signal,
    prepare: async () => {
      const released = getSessionWorkAdmissionRelease({ scope: storePath, identities });
      if (released) {
        await racePromiseWithAbortSignal(released, params.signal);
      }
    },
    run: async () => {
      params.assertCurrent?.();
      const current = await readResolvedSessionEntryInWorker({
        agentId: params.agentId,
        cfg: params.config,
        sessionKey,
      });
      params.assertCurrent?.();
      if (
        current?.sessionId !== expectedSessionId ||
        normalizeOptionalString(current.lifecycleRevision) !== expectedLifecycleRevision
      ) {
        return {
          ok: false,
          kind: "rebound",
          reason: `session rebound for sessionKey: ${sessionKey}`,
        };
      }
      const unavailable = resolveSessionWorkStartError(sessionKey, current, {
        expectedSessionId,
        purpose: "accepted-result-settlement",
      });
      if (unavailable) {
        return { ok: false, kind: "unavailable", reason: unavailable };
      }
      const scope = {
        agentId: params.agentId,
        sessionKey,
        sessionId: expectedSessionId,
        storePath,
      };
      // A retry owns the original committed payload, including its managed-media IDs.
      // Restaging media would conflict with the transcript's exact replay contract.
      const prior = await findTranscriptEvent(scope, { kind: "idempotency", key: idempotencyKey });
      const priorMessage = prior && readTranscriptEventMessage(prior.event);
      const priorId = prior && readTranscriptEventId(prior.event);
      if (prior && (!priorMessage || !priorId)) {
        return {
          ok: false,
          kind: "not_committed",
          reason: "background result transcript identity is unavailable",
        };
      }
      const displayContent = priorMessage
        ? undefined
        : (await params.prepareDisplayContent?.())?.map((block) => Object.assign({}, block));
      const message = {
        role: "assistant",
        content: [{ type: "text", text }],
        ...(displayContent ? { [ASSISTANT_DISPLAY_CONTENT_FIELD]: displayContent } : {}),
        api: OPENCLAW_TRANSCRIPT_ARTIFACT_API,
        provider: OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
        model: AUTOMATION_RESULT_MODEL,
        usage: makeZeroUsageSnapshot(),
        stopReason: "stop",
        timestamp: Date.now(),
        idempotencyKey,
        openclawAutomation: params.provenance,
      } satisfies SessionTranscriptAssistantMessage & {
        idempotencyKey: string;
        openclawAutomation: BackgroundSessionResultProvenance;
      };
      params.assertCurrent?.();
      const committed = await persistSessionTranscriptTurn(scope, {
        cwd: current.spawnedCwd,
        expectedSessionId,
        expectedLifecycleRevision: expectedLifecycleRevision ?? null,
        assertCurrent: () => {
          params.assertCurrent?.();
          params.signal?.throwIfAborted();
        },
        messages: [
          {
            message: priorMessage
              ? { ...priorMessage, content: message.content, openclawAutomation: params.provenance }
              : message,
            idempotencyLookup: "scan",
            ...(priorId
              ? {
                  eventId: priorId,
                  predicate: {
                    kind: "active-entry" as const,
                    entryId: priorId,
                    errorMessage: "background result no longer owns the active transcript",
                  },
                }
              : {}),
          },
        ],
        touchSessionEntry: true,
        updateMode: "inline",
        // A retry can finish media ownership after a committed append failed to publish.
        publishWhen: params.prepareDisplayContent ? "always" : undefined,
        config: params.config,
        onMessageCommitted: params.onMessageCommitted,
      });
      const appended = committed.messages[0];
      return appended
        ? { ok: true, messageId: appended.messageId }
        : {
            ok: false,
            kind: "not_committed",
            reason: committed.rejectedReason ?? "background result was not committed",
          };
    },
  });
}
