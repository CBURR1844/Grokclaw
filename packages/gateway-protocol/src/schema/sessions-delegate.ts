import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Starts another agent through the requester session's own delegation tool. */
export const SessionsDelegateParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  /** Rejects the request when the session was reset since the caller loaded it. */
  sessionId: Type.Optional(NonEmptyString),
  targetAgentId: NonEmptyString,
  task: Type.String({ minLength: 1, maxLength: 16_000 }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 128 }),
});

export const SessionsDelegateResultSchema = closedObject({
  status: Type.Literal("accepted"),
  runId: NonEmptyString,
  childSessionKey: NonEmptyString,
});

export type SessionsDelegateParams = Static<typeof SessionsDelegateParamsSchema>;
export type SessionsDelegateResult = Static<typeof SessionsDelegateResultSchema>;
