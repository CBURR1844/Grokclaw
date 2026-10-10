// Starts another agent through the requester bot's own sessions_spawn tool and policy.
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateSessionsDelegateParams,
  type SessionsDelegateParams,
  type SessionsDelegateResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { normalizeAcceptedSessionSpawnResult } from "../../agents/accepted-session-spawn.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope-config.js";
import { resolveAgentIdentity } from "../../agents/identity.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../../agents/spawned-context.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-state.js";
import { isCronSessionKey, isSubagentSessionKey } from "../../sessions/session-key-utils.js";
import { resolveSkillDispatchTools } from "../../skills/runtime/tool-dispatch.js";
import { authorizeGatewaySessionCreation } from "../operator-role-policy.js";
import { hasGatewayAdminScope } from "../operator-scopes.js";
import { withOperatorToolGatewayAuthority } from "../server-plugin-in-process-authority.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { resolveSessionSelectedModelRef } from "../session-utils-model-selection.js";
import { withGatewaySessionEntry } from "../session-utils-store.js";
import { withRestartSafeChatPlacement } from "./chat-restart-recovery.js";
import { resolveChatSendCallerContext } from "./gateway-client-identity.js";
import {
  cacheGatewayDedupeResult,
  resolveGatewayInflightRequest,
  runGatewayInflightWork,
  type GatewayInflightResult,
} from "./inflight.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

type DelegateOptions = Omit<GatewayRequestHandlerOptions, "params"> & {
  params: SessionsDelegateParams;
};
type SessionAccess = NonNullable<GatewayRequestHandlerOptions["sessionAccessAuthority"]>;

const STALE_CHAT = "This chat changed since you opened it. Reload and try again.";

async function isWorkerPlaced(options: DelegateOptions, sessionId: string) {
  const service = options.context.workerSessionPlacementService;
  if (!service) {
    return false;
  }
  let placed = false;
  await withRestartSafeChatPlacement(service, sessionId, async ({ facts }) => {
    placed = facts.placement !== undefined && facts.placement.state !== "local";
  });
  return placed;
}

/** Maps the spawn tool's own outcome; a hook block or spawn refusal keeps the owner's text. */
function mapSpawnResult(result: unknown): GatewayInflightResult {
  const accepted = normalizeAcceptedSessionSpawnResult(result);
  if (accepted) {
    const payload: SessionsDelegateResult = {
      status: "accepted",
      runId: accepted.runId,
      childSessionKey: accepted.childSessionKey,
    };
    return { ok: true, payload };
  }
  const details = asOptionalRecord(asOptionalRecord(result)?.details);
  const message =
    normalizeOptionalString(details?.error) ??
    normalizeOptionalString(details?.reason) ??
    "The Claw could not be started.";
  const refused = details?.status === "forbidden" || details?.status === "blocked";
  return {
    ok: false,
    error: errorShape(refused ? ErrorCodes.FORBIDDEN : ErrorCodes.UNAVAILABLE, message),
  };
}

async function delegate(
  options: DelegateOptions,
  access: SessionAccess,
): Promise<GatewayInflightResult> {
  const { client, context, params: request } = options;
  const assertCurrent = () => {
    options.signal?.throwIfAborted();
    access.assertCurrent();
  };
  const cfg = context.getRuntimeConfig();
  const ceiling = authorizeGatewaySessionCreation({ cfg, client, agentId: request.targetAgentId });
  if (ceiling) {
    return { ok: false, error: ceiling };
  }
  const { agentId, sessionKey, sessionId } = access.target;
  const entry = await withGatewaySessionEntry(
    sessionKey,
    { agentId },
    (session) => session.entry,
    cfg,
  );
  if (!entry || entry.sessionId !== sessionId) {
    return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, STALE_CHAT) };
  }
  const caller = resolveChatSendCallerContext(client);
  const model = resolveSessionSelectedModelRef({
    cfg,
    agentId,
    sessionKey,
    source: {
      entry,
      // Inherited model choices come from the resident projection, never a main-thread read.
      readSourceEntry: (key) =>
        getSessionRowProjection(context)?.sharingTarget({ agentId, key })?.entry,
    },
    manifestPlugins: getGatewayPluginMetadataSnapshot() ?? [],
  });
  const tools = await resolveSkillDispatchTools(
    {
      message: {
        surface: caller.Surface,
        provider: caller.Provider,
        senderId: caller.SenderId,
        senderName: caller.SenderName,
        senderUsername: caller.SenderUsername,
      },
      cfg,
      agentId,
      sessionEntry: entry,
      sessionKey,
      workspaceDir:
        resolveIngressWorkspaceOverrideForSessionRun({
          spawnedBy: entry.spawnedBy,
          workspaceDir: entry.spawnedWorkspaceDir,
          cwd: entry.spawnedCwd,
        }) ?? resolveAgentWorkspaceDir(cfg, agentId),
      provider: model.provider,
      model: model.model,
      senderIsOwner: hasGatewayAdminScope(client),
      senderId: caller.SenderId,
      completionPresentation: "result",
    },
    await import("../../agents/openclaw-tools.js"),
  );
  const tool = tools.find((candidate) => candidate.name === "sessions_spawn");
  if (!tool) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.FORBIDDEN,
        "This bot's tool settings don't let it start helpers.",
      ),
    };
  }
  const label = normalizeOptionalString(resolveAgentIdentity(cfg, request.targetAgentId)?.name);
  const args = {
    agentId: request.targetAgentId,
    task: request.task,
    ...(label ? { label } : {}),
    mode: "run",
    context: "isolated",
    cleanup: "keep",
    ...(access.sandboxRequired ? { sandbox: "require" } : {}),
  };
  assertCurrent();
  const result = await withOperatorToolGatewayAuthority(
    {
      authenticatedUserProfile: cfg.gateway?.roles ? client?.authenticatedUserProfile : undefined,
      operatorRoleActor: client?.internal?.operatorRoleActor,
      scopes: client?.connect.scopes ?? [],
      assertCurrent,
    },
    async () => {
      assertCurrent();
      return await tool.execute(
        `sessions.delegate:${request.idempotencyKey}`,
        args,
        options.signal,
      );
    },
  );
  return mapSpawnResult(result);
}

async function handleSessionsDelegate(options: DelegateOptions) {
  const { params: request, respond, context } = options;
  const access = options.sessionAccessAuthority;
  if (!access) {
    throw new Error("sessions.delegate requires router-prepared session access.");
  }
  if (isSubagentSessionKey(request.sessionKey) || isCronSessionKey(request.sessionKey)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Claws can't be started from a helper's or a routine's chat.",
      ),
    );
    return;
  }
  if (request.sessionId !== undefined && request.sessionId !== access.target.sessionId) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, STALE_CHAT));
    return;
  }
  // Placed turns spawn through the worker executor; this host path cannot reach it.
  if (await isWorkerPlaced(options, access.target.sessionId)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "This chat runs on a remote worker. Sending to a Claw isn't available here yet.",
      ),
    );
    return;
  }
  const dedupeKey = `sessions.delegate:${request.idempotencyKey}`;
  const identityKey = `${dedupeKey}:identity`;
  const requestIdentity = sha256Hex(
    JSON.stringify([request.sessionKey, request.targetAgentId, request.task]),
  );
  const completed = context.dedupe.get(dedupeKey);
  const prior = context.dedupe.get(identityKey);
  if (
    (completed && completed.requestIdentity !== requestIdentity) ||
    (prior && prior.requestIdentity !== requestIdentity)
  ) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "This request key was already used for a different request.",
      ),
    );
    return;
  }
  // The bounded, TTL-pruned dedupe store also holds the in-flight identity claim.
  context.dedupe.set(identityKey, { ts: Date.now(), ok: true, requestIdentity });
  const inflight = resolveGatewayInflightRequest({
    context,
    dedupeKey,
    idempotencyKey: request.idempotencyKey,
    respond,
  });
  if (inflight.kind === "handled") {
    await inflight.done;
    return;
  }
  const work = (async (): Promise<GatewayInflightResult> => {
    try {
      const result = await delegate(options, access);
      // Only a started run has a side effect to replay. A refusal can clear (a finished
      // helper frees a slot, policy changes), so a same-key retry is evaluated again.
      if (result.ok) {
        cacheGatewayDedupeResult({ context, dedupeKey, requestIdentity, result });
      }
      return result;
    } catch (cause) {
      // An interrupted start is uncertain, so a retry with the same key may try again.
      return {
        ok: false,
        error:
          cause instanceof SessionMutationAuthorizationChangedError
            ? cause.error
            : errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(cause)),
      };
    }
  })();
  await runGatewayInflightWork({ inflightMap: inflight.inflightMap, dedupeKey, work, respond });
}

export const sessionsDelegateHandlers: GatewayRequestHandlers = {
  "sessions.delegate": defineValidatedGatewayMethod(
    "sessions.delegate",
    validateSessionsDelegateParams,
    handleSessionsDelegate,
  ),
};
