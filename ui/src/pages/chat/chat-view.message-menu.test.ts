/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetChatViewState } from "./chat-view-state.ts";
import {
  dispatchContextMenu,
  getContextMenuAction,
  renderChatBubble,
} from "./chat-view.test-helpers.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);

afterEach(() => {
  resetChatViewState();
  resetTranscriptTestDom();
});

describe("right-click whole-message actions", () => {
  it("adds whole-message actions after the message's own actions", () => {
    const run = vi.fn();
    const read = vi.fn((command: string) =>
      command === "learn" ? { disabledReason: null } : null,
    );
    const onReadAloud = vi.fn();
    const { bubble } = renderChatBubble(
      {
        commands: { read, claws: () => [], run },
        onReadAloud,
        onCompanionStageAttachment: vi.fn(() => true),
        onSetReply: vi.fn(),
      },
      { messageId: "message-1", text: "deploy the site" },
    );
    bubble.append(
      Object.assign(document.createElement("div"), {
        className: "chat-text",
        textContent: "deploy the site",
      }),
    );

    dispatchContextMenu(bubble);
    expect(
      [...document.querySelectorAll(".chat-reply-context-menu button")].map((button) =>
        button.textContent?.trim(),
      ),
    ).toEqual(["Reply", "Copy as markdown", "Ask in side chat", "Save as a skill", "Read aloud"]);
    getContextMenuAction("Save as a skill").click();
    expect(run).toHaveBeenCalledWith("learn", { message: "deploy the site" });
    expect(document.querySelector(".chat-reply-context-menu")).toBeNull();

    dispatchContextMenu(bubble);
    getContextMenuAction("Read aloud").click();
    expect(onReadAloud).toHaveBeenCalledWith("deploy the site");
  });

  it("disables Save as a skill with the command's reason and omits absent actions", () => {
    const { bubble } = renderChatBubble(
      {
        commands: {
          read: () => ({ disabledReason: "Reconnect first" }),
          claws: () => [],
          run: vi.fn(),
        },
        onSetReply: vi.fn(),
      },
      { messageId: "message-1", text: "deploy the site" },
    );
    bubble.append(
      Object.assign(document.createElement("div"), {
        className: "chat-text",
        textContent: "deploy the site",
      }),
    );

    dispatchContextMenu(bubble);

    const learn = getContextMenuAction("Save as a skill");
    expect(learn.disabled).toBe(true);
    expect(learn.closest("openclaw-tooltip")?.content).toBe("Reconnect first");
    expect(
      [...document.querySelectorAll(".chat-reply-context-menu button")].map((button) =>
        button.textContent?.trim(),
      ),
    ).toEqual(["Reply", "Copy as markdown", "Save as a skill"]);
  });
});
