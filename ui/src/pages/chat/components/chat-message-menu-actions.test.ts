import { describe, expect, it, vi } from "vitest";
import type { ChatSelectionSource } from "../../../lib/chat/chat-types.ts";
import { resolveChatCommentAnchor } from "./chat-comment-anchor.ts";
import { wholeMessageActions } from "./chat-message-menu-actions.ts";

function renderBubble(body: string) {
  const root = document.createElement("div");
  root.innerHTML = `<div class="chat-bubble" data-message-id="m1"><span>Forge</span>${body}</div>`;
  return { root, bubble: root.querySelector<HTMLElement>(".chat-bubble")! };
}

describe("whole-message actions", () => {
  it("asks in a side chat with offsets the comment pin resolves, even for formatted text", () => {
    const { root, bubble } = renderBubble(
      '<div class="chat-text"><p><strong>Deploy</strong> the <a href="#">site</a></p><p>Then report.</p></div>',
    );
    const onCompanionSelection = vi.fn<(selection: ChatSelectionSource) => void>();

    const actions = wholeMessageActions(
      { onCompanionSelection },
      { text: "**Deploy** the [site](#)\n\nThen report.", bubble },
    );
    actions.find((action) => action.label === "Ask in side chat")?.run();

    const selection = onCompanionSelection.mock.calls[0]?.[0];
    expect(selection).toMatchObject({ messageId: "m1", start: "Forge".length });
    const anchor = selection ? resolveChatCommentAnchor(root, selection) : null;
    expect(anchor?.range.toString()).toBe("Deploy the siteThen report.");
  });

  it("offers nothing for a row without a text body, such as tool output", () => {
    const { bubble } = renderBubble('<pre class="chat-tool-output">exit 0</pre>');
    const commands = { read: () => ({ disabledReason: null }), run: vi.fn() };

    const actions = wholeMessageActions(
      { onCompanionSelection: vi.fn(), onReadAloud: vi.fn(), commands },
      { text: "exit 0", bubble },
    );

    expect(actions).toEqual([]);
  });
});
