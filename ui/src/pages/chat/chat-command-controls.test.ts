import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { AgentsListResult } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import type { ClawTaskDialogOptions } from "../../components/claw-task-dialog.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import {
  gatewayHelloForMethods,
  SESSION_MUTATION_TEST_METHODS,
} from "../../test-helpers/gateway-methods.ts";
import { createChatCommandControls, type ChatControlCommand } from "./chat-command-controls.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

const { dispatch, showClawTaskDialog, showInputDialog, showToast } = vi.hoisted(() => ({
  dispatch: vi.fn(),
  showClawTaskDialog: vi.fn<(options: ClawTaskDialogOptions) => Promise<boolean>>(),
  showInputDialog: vi.fn(),
  showToast: vi.fn(),
}));
vi.mock("./chat-commands.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chat-commands.ts")>()),
  dispatchChatSlashCommand: dispatch,
}));
vi.mock("../../components/input-dialog.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../components/input-dialog.ts")>()),
  showInputDialog,
}));
vi.mock("../../components/claw-task-dialog.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../components/claw-task-dialog.ts")>()),
  showClawTaskDialog,
}));
vi.mock("../../lib/toast.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/toast.ts")>()),
  showToast,
}));

const COMMANDS: ChatControlCommand[] = ["goal", "compact", "learn", "loop", "export", "claw"];
const CLAW_METHODS = [...SESSION_MUTATION_TEST_METHODS, "sessions.delegate"];
const AGENTS: AgentsListResult = {
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: [
    { id: "main" },
    { id: "sorter", name: "Inbox Sorter", claw: { requesterAgentIds: ["main"] } },
    { id: "brief", claw: { requesterAgentIds: ["forge"] } },
  ],
};
const GOAL = {
  schemaVersion: 1 as const,
  id: "goal-1",
  objective: "Ship it",
  status: "active" as const,
  createdAt: 1,
  updatedAt: 1,
  tokenStart: 0,
  tokensUsed: 0,
  continuationTurns: 0,
};

type Setup = {
  hello?: ReturnType<typeof gatewayHelloForMethods>;
  connected?: boolean;
  gate?: Partial<Parameters<typeof createChatCommandControls>[2]>;
  host?: Record<string, unknown>;
  agents?: AgentsListResult;
  request?: (params: unknown) => unknown;
};

function setup(options: Setup = {}) {
  const connected = options.connected ?? true;
  const base = makeChatHost({
    requestHandlers: { "sessions.delegate": options.request ?? (() => ({})) },
    connected,
    hello: options.hello ?? gatewayHelloForMethods(CLAW_METHODS),
    sessionKey: "agent:main:main",
  });
  const host = Object.assign(
    base,
    {
      compactionStatus: null,
      currentSessionId: "session-1",
      handleSendChat: vi.fn(async () => true),
      handleChatDraftChange: vi.fn(),
      requestUpdate: vi.fn(),
    },
    options.host,
  ) as unknown as ChatPageHost;
  const snapshot = {
    client: host.client,
    hello: host.hello,
    phase: connected ? "connected" : "offline",
  } as ApplicationGatewaySnapshot;
  const focus = vi.fn();
  const pane = {
    updateComplete: Promise.resolve(true),
    querySelector: vi.fn(() => ({ focus })),
  } as unknown as Parameters<typeof createChatCommandControls>[3];
  const controls = createChatCommandControls(
    host,
    { gateway: { snapshot }, agents: { state: { agentsList: options.agents ?? AGENTS } } },
    { canSend: true, ...options.gate },
    pane,
  );
  const states = () =>
    Object.fromEntries(COMMANDS.map((command) => [command, controls.read(command)]));
  return { host, request: base.request, controls, states, focus };
}

const shown = (disabledReason: string | null = null) => ({ disabledReason });

afterEach(() => {
  dispatch.mockReset();
  showClawTaskDialog.mockReset();
  showInputDialog.mockReset();
  showToast.mockReset();
});

describe("chat command controls", () => {
  it.each<[string, Setup, Record<ChatControlCommand, ReturnType<typeof shown> | null>]>([
    [
      "offers every command to an idle admin",
      {},
      {
        goal: shown(),
        compact: shown(),
        learn: shown(),
        loop: shown(),
        export: shown(),
        claw: shown(),
      },
    ],
    [
      "hides admin-only commands from a writer",
      { hello: gatewayHelloForMethods(CLAW_METHODS, ["operator.write"]) },
      { goal: shown(), compact: null, learn: shown(), loop: null, export: shown(), claw: shown() },
    ],
    [
      "hides compaction when the Gateway lacks it",
      {
        hello: gatewayHelloForMethods(
          CLAW_METHODS.filter((method) => method !== "sessions.compact"),
        ),
      },
      {
        goal: shown(),
        compact: null,
        learn: shown(),
        loop: shown(),
        export: shown(),
        claw: shown(),
      },
    ],
    [
      "explains a lost connection but keeps export",
      { connected: false },
      {
        goal: shown("Connect to the Gateway to change sessions."),
        compact: shown("Connect to the Gateway to change sessions."),
        learn: shown("Connect to the Gateway to change sessions."),
        loop: shown("Connect to the Gateway to change sessions."),
        export: shown(),
        claw: shown("Connect to the Gateway to change sessions."),
      },
    ],
    [
      "uses the composer's reason when it cannot send",
      { gate: { canSend: false, disabledReason: "View only" } },
      {
        goal: shown("View only"),
        compact: shown("View only"),
        learn: shown("View only"),
        loop: shown("View only"),
        export: shown(),
        claw: shown("View only"),
      },
    ],
    [
      "waits for a missing model",
      { gate: { modelRequiredReason: "Choose a model" } },
      {
        goal: shown("Choose a model"),
        compact: shown("Choose a model"),
        learn: shown("Choose a model"),
        loop: shown("Choose a model"),
        export: shown(),
        // A Claw runs on its own model, so the bot's missing model doesn't block it.
        claw: shown(),
      },
    ],
    [
      "waits while the bot is working",
      { host: { chatSending: true } },
      {
        goal: shown("Available when the current reply finishes"),
        compact: shown("Available when the current reply finishes"),
        learn: shown("Available when the current reply finishes"),
        loop: shown("Available when the current reply finishes"),
        export: shown(),
        claw: shown(),
      },
    ],
    [
      "blocks a second compaction",
      {
        host: {
          compactionStatus: { phase: "active", runId: null, startedAt: 1, completedAt: null },
        },
      },
      {
        goal: shown(),
        compact: shown("Already freeing up space"),
        learn: shown(),
        loop: shown(),
        export: shown(),
        claw: shown(),
      },
    ],
    [
      "leaves goals to the goal card once one exists",
      {
        host: {
          sessionsResult: (() => {
            const result = createSessionsListResult();
            result.sessions[0] = { ...result.sessions[0]!, key: "agent:main:main", goal: GOAL };
            return result;
          })(),
        },
      },
      {
        goal: null,
        compact: shown(),
        learn: shown(),
        loop: shown(),
        export: shown(),
        claw: shown(),
      },
    ],
    [
      "hides Set a goal while one is being drafted",
      { host: { chatGoalDraftMode: { action: "start" } } },
      {
        goal: null,
        compact: shown(),
        learn: shown(),
        loop: shown(),
        export: shown(),
        claw: shown(),
      },
    ],
  ])("%s", (_name, options, expected) => {
    expect(setup(options).states()).toEqual(expected);
  });

  it("compacts once even when clicked twice", async () => {
    const compaction = createDeferred<"completed">();
    dispatch.mockReturnValue(compaction.promise);
    const { host, controls } = setup();

    controls.run("compact");
    controls.run("compact");

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(host, "compact", "");
    expect(showToast).toHaveBeenCalledWith({ message: "Already freeing up space" });
    compaction.resolve("completed");
    await vi.waitFor(() => expect(controls.read("compact")).toEqual(shown()));
  });

  it("saves a message's workflow through chat.send without the composer's reply", () => {
    const { host, controls } = setup();

    controls.run("learn", { message: "  Deploy\n\nthe   site  " });

    expect(host.handleSendChat).toHaveBeenCalledWith(
      "/learn Save the reusable workflow in this message as a skill: “Deploy the site”",
      { replyTargetOverride: null, followUpMode: "queue" },
    );
  });

  it.each([
    ["sends bare /learn for an empty request", "", "/learn"],
    ["sends the request", "  summarize PRs  ", "/learn summarize PRs"],
    ["sends nothing when cancelled", null, null],
  ])("teach a new skill %s", async (_name, answer, sent) => {
    showInputDialog.mockResolvedValue(answer);
    const { host, controls } = setup();

    controls.run("learn");

    await vi.waitFor(() => expect(showInputDialog).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(host.handleSendChat).toHaveBeenCalledTimes(sent === null ? 0 : 1);
    if (sent !== null) {
      expect(host.handleSendChat).toHaveBeenCalledWith(sent, expect.any(Object));
    }
  });

  it("schedules the last request on a loop", async () => {
    showInputDialog.mockResolvedValue("1h check the build");
    const { host, controls } = setup({
      host: {
        chatMessages: [
          { role: "user", content: "check the   build" },
          { role: "user", content: "/status" },
          { role: "assistant", content: "Done." },
        ],
      },
    });

    controls.run("loop");

    await vi.waitFor(() =>
      expect(host.handleSendChat).toHaveBeenCalledWith("/loop 1h check the build", {
        replyTargetOverride: null,
        followUpMode: "queue",
      }),
    );
    expect(showInputDialog).toHaveBeenCalledWith(
      expect.objectContaining({ defaultValue: "30m check the build", requireValue: true }),
    );
  });

  it("starts a goal draft, stops offering another and focuses the composer", async () => {
    const { host, controls, focus } = setup();

    controls.run("goal");

    expect(host.chatGoalDraftMode).toEqual({ sessionId: "session-1", action: "start" });
    // While the goal is being drafted, the menus stop offering a second one.
    expect(controls.read("goal")).toBeNull();
    await vi.waitFor(() => expect(focus).toHaveBeenCalledWith({ preventScroll: true }));
  });

  it("exports the loaded chat", async () => {
    const actual = await vi.importActual<typeof import("./chat-commands.ts")>("./chat-commands.ts");
    dispatch.mockImplementation(actual.dispatchChatSlashCommand);
    const exportCurrentChat = vi.fn(async () => "exported" as const);
    const { controls } = setup({ host: { exportCurrentChat } });

    controls.run("export");

    await vi.waitFor(() => expect(exportCurrentChat).toHaveBeenCalledOnce());
  });

  it("toasts when a command fails to start", async () => {
    dispatch.mockRejectedValue(new Error("chunk failed to load"));
    const { controls } = setup();

    controls.run("export");

    await vi.waitFor(() =>
      expect(showToast).toHaveBeenCalledWith({
        message: "Couldn't do that: chunk failed to load",
      }),
    );
  });

  it("re-checks a dialog's answer before sending it", async () => {
    const answer = createDeferred<string | null>();
    showInputDialog.mockReturnValue(answer.promise);
    const { host, controls } = setup();

    controls.run("loop");
    await vi.waitFor(() => expect(showInputDialog).toHaveBeenCalledOnce());
    host.chatSending = true;
    answer.resolve("30m check the build");

    await vi.waitFor(() =>
      expect(showToast).toHaveBeenCalledWith({
        message: "Available when the current reply finishes",
      }),
    );
    expect(host.handleSendChat).not.toHaveBeenCalled();
  });

  it("explains a click that arrives after the command became unavailable", () => {
    const { host, controls } = setup();
    host.chatSending = true;

    controls.run("learn", { message: "hello" });

    expect(host.handleSendChat).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith({
      message: "Available when the current reply finishes",
    });
  });
  it.each<[string, Setup]>([
    ["the bot has no Claws", { agents: { ...AGENTS, agents: [{ id: "main" }] } }],
    ["the chat is incognito", { host: { selectedChatSessionIncognito: true } }],
    ["the chat is a helper's", { host: { sessionKey: "agent:main:subagent:abc" } }],
    ["the chat is a routine's", { host: { sessionKey: "agent:main:cron:job-1" } }],
    ["the chat is global scope's, which names no bot", { host: { sessionKey: "global" } }],
    [
      "the Gateway lacks the method",
      { hello: gatewayHelloForMethods(SESSION_MUTATION_TEST_METHODS) },
    ],
    [
      "the caller can only write its own sessions",
      { hello: gatewayHelloForMethods(CLAW_METHODS, ["operator.read", "operator.sessions.write"]) },
    ],
  ])("hides Send to a Claw when %s", (_name, options) => {
    expect(setup(options).controls.read("claw")).toBeNull();
  });

  it("lists only this bot's Claws, by name", () => {
    expect(setup().controls.claws()).toEqual([{ id: "sorter", name: "Inbox Sorter" }]);
  });

  it("sends a message to a Claw with this chat's session and a fresh key", async () => {
    const { request, controls } = setup({
      request: () => ({ status: "accepted", runId: "run-1", childSessionKey: "child" }),
      host: { chatSending: true },
    });

    controls.run("claw", { message: "  Sort my inbox ", clawId: "sorter" });

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("sessions.delegate", {
        sessionKey: "agent:main:main",
        sessionId: "session-1",
        targetAgentId: "sorter",
        task: "Sort my inbox",
        idempotencyKey: expect.any(String),
      }),
    );
    await Promise.resolve();
    expect(showToast).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a refusal",
      new GatewayRequestError({
        code: "FORBIDDEN",
        message: "This bot's tool settings don't let it start helpers.",
      }),
      "Couldn't do that: This bot's tool settings don't let it start helpers.",
    ],
    [
      "a lost answer",
      new Error("gateway closed (1006)"),
      "Couldn't confirm Inbox Sorter started. Check this chat before sending again.",
    ],
  ])("explains %s", async (_name, error, message) => {
    const { request, controls } = setup({
      request: () => {
        throw error;
      },
    });

    controls.run("claw", { message: "Sort my inbox", clawId: "sorter" });

    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith({ message }));
    expect(request).toHaveBeenCalledOnce();
  });

  it("asks which Claw, then sends to the session the menu was opened in", async () => {
    const { host, request, controls } = setup();

    controls.run("claw", { message: "Sort my inbox" });

    await vi.waitFor(() => expect(showClawTaskDialog).toHaveBeenCalledOnce());
    const [dialog] = showClawTaskDialog.mock.calls[0]!;
    expect(dialog).toMatchObject({
      claws: [{ id: "sorter", name: "Inbox Sorter" }],
      task: "Sort my inbox",
    });
    host.sessionKey = "agent:main:other";
    await expect(
      dialog.submit({ clawId: "sorter", task: "Sort my inbox", idempotencyKey: "key-1" }),
    ).resolves.toBe("Not available in this chat");
    expect(request).not.toHaveBeenCalledWith("sessions.delegate", expect.anything());
  });
});
