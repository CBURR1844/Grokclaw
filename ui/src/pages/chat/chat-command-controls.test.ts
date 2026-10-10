import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import {
  gatewayHelloForMethods,
  SESSION_MUTATION_TEST_METHODS,
  sessionMutationGatewayHello,
} from "../../test-helpers/gateway-methods.ts";
import { createChatCommandControls, type ChatControlCommand } from "./chat-command-controls.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

const { dispatch, showInputDialog, showToast } = vi.hoisted(() => ({
  dispatch: vi.fn(),
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
vi.mock("../../lib/toast.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/toast.ts")>()),
  showToast,
}));

const COMMANDS: ChatControlCommand[] = ["goal", "compact", "learn", "loop", "export"];
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
  hello?: ReturnType<typeof sessionMutationGatewayHello>;
  connected?: boolean;
  gate?: Partial<Parameters<typeof createChatCommandControls>[2]>;
  host?: Record<string, unknown>;
};

function setup(options: Setup = {}) {
  const connected = options.connected ?? true;
  const host = Object.assign(
    makeChatHost({
      requestHandlers: {},
      connected,
      hello: options.hello ?? sessionMutationGatewayHello(),
      sessionKey: "main",
    }),
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
    { snapshot },
    { canSend: true, ...options.gate },
    pane,
  );
  const states = () =>
    Object.fromEntries(COMMANDS.map((command) => [command, controls.read(command)]));
  return { host, controls, states, focus };
}

const shown = (disabledReason: string | null = null) => ({ disabledReason });

afterEach(() => {
  dispatch.mockReset();
  showInputDialog.mockReset();
  showToast.mockReset();
});

describe("chat command controls", () => {
  it.each<[string, Setup, Record<ChatControlCommand, ReturnType<typeof shown> | null>]>([
    [
      "offers every command to an idle admin",
      {},
      { goal: shown(), compact: shown(), learn: shown(), loop: shown(), export: shown() },
    ],
    [
      "hides admin-only commands from a writer",
      { hello: sessionMutationGatewayHello(["operator.write"]) },
      { goal: shown(), compact: null, learn: shown(), loop: null, export: shown() },
    ],
    [
      "hides compaction when the Gateway lacks it",
      {
        hello: gatewayHelloForMethods(
          SESSION_MUTATION_TEST_METHODS.filter((method) => method !== "sessions.compact"),
        ),
      },
      { goal: shown(), compact: null, learn: shown(), loop: shown(), export: shown() },
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
      },
    ],
    [
      "leaves goals to the goal card once one exists",
      {
        host: {
          sessionsResult: (() => {
            const result = createSessionsListResult();
            result.sessions[0] = { ...result.sessions[0]!, goal: GOAL };
            return result;
          })(),
        },
      },
      { goal: null, compact: shown(), learn: shown(), loop: shown(), export: shown() },
    ],
    [
      "hides Set a goal while one is being drafted",
      { host: { chatGoalDraftMode: { action: "start" } } },
      { goal: null, compact: shown(), learn: shown(), loop: shown(), export: shown() },
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
});
