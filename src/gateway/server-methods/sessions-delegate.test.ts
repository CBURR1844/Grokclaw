// sessions.delegate handler: check order, refusals, dedupe, and the fixed spawn call.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { GatewaySessionAccessAuthority } from "../session-access-authority.js";
import { sessionsDelegateHandlers } from "./sessions-delegate.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions, RespondFn } from "./types.js";

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  authorizeGatewaySessionCreation: vi.fn(),
  withGatewaySessionEntry: vi.fn(),
  resolveSkillDispatchTools: vi.fn(),
  withOperatorToolGatewayAuthority: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("../operator-role-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../operator-role-policy.js")>()),
  authorizeGatewaySessionCreation: (params: unknown) => {
    mocks.calls.push("role-ceiling");
    return mocks.authorizeGatewaySessionCreation(params);
  },
}));
// mock-isolation: Session rows live in SQLite workers; the handler only consumes the entry it is given.
vi.mock("../session-utils-store.js", () => ({
  withGatewaySessionEntry: async (
    key: string,
    options: unknown,
    consume: (session: { entry: SessionEntry | undefined }) => unknown,
  ) => {
    mocks.calls.push("entry");
    return consume({ entry: mocks.withGatewaySessionEntry(key, options) });
  },
}));
vi.mock("../session-utils-model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils-model-selection.js")>()),
  resolveSessionSelectedModelRef: () => ({ provider: "test-provider", model: "test-model" }),
}));
vi.mock("../../agents/identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/identity.js")>()),
  resolveAgentIdentity: (_cfg: unknown, agentId: string) =>
    agentId === "claw" ? { name: "Researcher" } : undefined,
}));
// mock-isolation: The real tool factory loads plugins and every tool; tool resolution is faked below.
vi.mock("../../agents/openclaw-tools.js", () => ({ createOpenClawToolsAsync: vi.fn() }));
// mock-isolation: Tool-policy layering has its own tests; this file checks the handler's order and mapping.
vi.mock("../../skills/runtime/tool-dispatch.js", () => ({
  resolveSkillDispatchTools: async (params: unknown) => {
    mocks.calls.push("tools");
    return mocks.resolveSkillDispatchTools(params);
  },
}));
// mock-isolation: The real authority binds process-wide Gateway state; the fake only records the call order.
vi.mock("../server-plugin-in-process-authority.js", () => ({
  withOperatorToolGatewayAuthority: async (
    authority: { assertCurrent: () => void },
    run: () => Promise<unknown>,
  ) => {
    mocks.withOperatorToolGatewayAuthority(authority);
    authority.assertCurrent();
    return await run();
  },
}));

const SESSION_KEY = "agent:main:main";
const CHILD_KEY = "agent:claw:subagent:child";

function accepted(runId = "run-1") {
  return { details: { status: "accepted", runId, childSessionKey: CHILD_KEY } };
}

function fixture(overrides: { sandboxRequired?: boolean; placement?: "local" | "worker" } = {}) {
  let current = true;
  const access: GatewaySessionAccessAuthority = {
    target: { agentId: "main", sessionKey: SESSION_KEY, sessionId: "session-1" },
    sandboxRequired: overrides.sandboxRequired ?? false,
    assertCurrent: () => {
      mocks.calls.push("assert-current");
      if (!current) {
        throw new Error("Session access changed.");
      }
    },
    retain: vi.fn(),
    retainSession: vi.fn(),
    release: vi.fn(),
  };
  const placement = overrides.placement;
  const context = {
    dedupe: new Map(),
    getRuntimeConfig: () => ({}),
    ...(placement
      ? {
          workerSessionPlacementService: {
            prepareRuntimeRefresh: async () => ({
              placement: { state: placement },
              release: () => {},
            }),
          },
        }
      : {}),
  } as unknown as GatewayRequestContext;
  const invoke = async (params: Record<string, unknown> = {}) => {
    const respond = vi.fn<RespondFn>();
    const options: GatewayRequestHandlerOptions = {
      params: {
        sessionKey: SESSION_KEY,
        targetAgentId: "claw",
        task: "Summarize the thread",
        idempotencyKey: "key-1",
        ...params,
      },
      respond,
      context,
      req: { type: "req", id: "1", method: "sessions.delegate" },
      client: { connect: { scopes: ["operator.write"] } } as GatewayRequestHandlerOptions["client"],
      isWebchatConnect: () => false,
      sessionAccessAuthority: access,
    };
    await sessionsDelegateHandlers["sessions.delegate"]!(options);
    return respond.mock.calls;
  };
  return {
    invoke,
    setCurrent: (value: boolean) => {
      current = value;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls.length = 0;
  mocks.authorizeGatewaySessionCreation.mockReturnValue(undefined);
  mocks.withGatewaySessionEntry.mockReturnValue({ sessionId: "session-1", updatedAt: 1 });
  mocks.execute.mockImplementation(async () => {
    mocks.calls.push("execute");
    return accepted();
  });
  mocks.resolveSkillDispatchTools.mockReturnValue([
    { name: "read", execute: vi.fn() },
    { name: "sessions_spawn", execute: mocks.execute },
  ]);
});

describe("sessions.delegate", () => {
  it("starts the Claw through the bot's own sessions_spawn with fixed arguments", async () => {
    const calls = await fixture().invoke();

    expect(calls).toEqual([
      [
        true,
        { status: "accepted", runId: "run-1", childSessionKey: CHILD_KEY },
        undefined,
        undefined,
      ],
    ]);
    expect(mocks.calls).toEqual([
      "role-ceiling",
      "entry",
      "tools",
      "assert-current",
      "assert-current",
      "assert-current",
      "execute",
    ]);
    expect(mocks.authorizeGatewaySessionCreation).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "claw" }),
    );
    expect(mocks.resolveSkillDispatchTools).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        sessionKey: SESSION_KEY,
        sessionEntry: { sessionId: "session-1", updatedAt: 1 },
        completionPresentation: "result",
      }),
    );
    expect(mocks.withOperatorToolGatewayAuthority).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: ["operator.write"] }),
    );
    expect(mocks.execute).toHaveBeenCalledWith(
      "sessions.delegate:key-1",
      {
        agentId: "claw",
        task: "Summarize the thread",
        label: "Researcher",
        mode: "run",
        context: "isolated",
        cleanup: "keep",
      },
      undefined,
    );
  });

  it("keeps a required sandbox and omits the label for an unnamed agent", async () => {
    await fixture({ sandboxRequired: true }).invoke({ targetAgentId: "helper" });
    expect(mocks.execute.mock.calls[0]?.[1]).toEqual({
      agentId: "helper",
      task: "Summarize the thread",
      mode: "run",
      context: "isolated",
      cleanup: "keep",
      sandbox: "require",
    });
  });

  it.each([
    {
      name: "a helper's chat",
      params: { sessionKey: "agent:main:subagent:child" },
      message: "Claws can't be started from a helper's or a routine's chat.",
    },
    {
      name: "a routine's chat",
      params: { sessionKey: "agent:main:cron:daily" },
      message: "Claws can't be started from a helper's or a routine's chat.",
    },
    {
      name: "a stale session id",
      params: { sessionId: "session-0" },
      message: "This chat changed since you opened it. Reload and try again.",
    },
  ])("refuses $name before any work", async ({ params, message }) => {
    const calls = await fixture().invoke(params);
    expect(calls).toEqual([[false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message)]]);
    expect(mocks.calls).toEqual([]);
  });

  it("refuses a worker-placed chat before any work", async () => {
    const calls = await fixture({ placement: "worker" }).invoke();
    expect(calls[0]?.[2]).toEqual(
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "This chat runs on a remote worker. Sending to a Claw isn't available here yet.",
      ),
    );
    expect(mocks.calls).toEqual([]);
  });

  it("returns the target role ceiling before reading the chat", async () => {
    const denied = errorShape(ErrorCodes.FORBIDDEN, "Your role can't start this agent.");
    mocks.authorizeGatewaySessionCreation.mockReturnValue(denied);
    expect(await fixture({ placement: "local" }).invoke()).toEqual([
      [false, undefined, denied, undefined],
    ]);
    expect(mocks.calls).toEqual(["role-ceiling"]);
  });

  it.each([
    { name: "a missing chat", entry: undefined },
    { name: "a replaced chat", entry: { sessionId: "session-2", updatedAt: 1 } },
  ])("refuses $name read from the store", async ({ entry }) => {
    mocks.withGatewaySessionEntry.mockReturnValue(entry);
    const calls = await fixture().invoke();
    expect(calls[0]?.[2]?.message).toBe(
      "This chat changed since you opened it. Reload and try again.",
    );
    expect(mocks.calls).not.toContain("tools");
  });

  it("refuses when the bot's tool policy hides sessions_spawn", async () => {
    mocks.resolveSkillDispatchTools.mockReturnValue([{ name: "read", execute: vi.fn() }]);
    const calls = await fixture().invoke();
    expect(calls[0]?.[2]).toEqual(
      errorShape(ErrorCodes.FORBIDDEN, "This bot's tool settings don't let it start helpers."),
    );
  });

  it.each([
    {
      details: { status: "forbidden", error: "agentId is not allowed for sessions_spawn" },
      error: errorShape(ErrorCodes.FORBIDDEN, "agentId is not allowed for sessions_spawn"),
    },
    {
      details: { status: "blocked", reason: "Blocked by policy hook." },
      error: errorShape(ErrorCodes.FORBIDDEN, "Blocked by policy hook."),
    },
    {
      details: { status: "error", error: "Spawn queue is full." },
      error: errorShape(ErrorCodes.UNAVAILABLE, "Spawn queue is full."),
    },
  ])("keeps the spawn owner's $details.status text", async ({ details, error }) => {
    mocks.execute.mockResolvedValue({ details });
    expect((await fixture().invoke())[0]?.[2]).toEqual(error);
  });

  it("rechecks session access before the spawn side effect", async () => {
    const f = fixture();
    mocks.resolveSkillDispatchTools.mockImplementationOnce(() => {
      f.setCurrent(false);
      return [{ name: "sessions_spawn", execute: mocks.execute }];
    });
    const calls = await f.invoke();
    expect(calls[0]?.[2]).toEqual(errorShape(ErrorCodes.UNAVAILABLE, "Session access changed."));
    expect(mocks.execute).not.toHaveBeenCalled();

    // An interrupted start is not cached, so the same key can try again.
    f.setCurrent(true);
    expect((await f.invoke())[0]?.[0]).toBe(true);
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it("joins a concurrent duplicate and replays the cached result", async () => {
    const f = fixture();
    const spawn = createDeferred<ReturnType<typeof accepted>>();
    mocks.execute.mockReturnValue(spawn.promise);

    const first = f.invoke();
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
    const joined = f.invoke();
    const mismatch = await f.invoke({ task: "Something else" });
    spawn.resolve(accepted());
    const payload = { status: "accepted", runId: "run-1", childSessionKey: CHILD_KEY };

    expect((await first)[0]?.slice(0, 2)).toEqual([true, payload]);
    expect((await joined)[0]).toEqual([true, payload, undefined, { cached: true }]);
    expect(mismatch[0]?.[2]).toEqual(
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "This request key was already used for a different request.",
      ),
    );
    expect(await f.invoke()).toEqual([[true, payload, undefined, { cached: true }]]);
    expect(mocks.execute).toHaveBeenCalledOnce();
  });
});
