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
    const commands = { read: () => ({ disabledReason: null }), claws: () => [], run: vi.fn() };

    const actions = wholeMessageActions(
      { onCompanionSelection: vi.fn(), onReadAloud: vi.fn(), commands },
      { text: "exit 0", bubble },
    );

    expect(actions).toEqual([]);
  });

  it.each([
    ["names each of up to three Claws", 3, ["Send to Claw 1", "Send to Claw 2", "Send to Claw 3"]],
    ["asks which of more than three Claws", 4, ["Send to a Claw…"]],
  ])("%s", (_name, count, labels) => {
    const { bubble } = renderBubble('<div class="chat-text">Sort my inbox</div>');
    const claws = Array.from({ length: count }, (_, index) => ({
      id: `claw-${index + 1}`,
      name: `Claw ${index + 1}`,
    }));
    const commands = {
      read: (command: string) => (command === "claw" ? { disabledReason: null } : null),
      claws: () => claws,
      run: vi.fn(),
    };

    const actions = wholeMessageActions({ commands }, { text: "Sort my inbox", bubble });
    actions[0]?.run();

    expect(actions.map((action) => action.label)).toEqual(labels);
    expect(commands.run).toHaveBeenCalledWith(
      "claw",
      count > 3 ? { message: "Sort my inbox" } : { message: "Sort my inbox", clawId: "claw-1" },
    );
  });

  it.each([
    ["Send to Claw 1", 1],
    ["Send to a Claw…", 4],
  ])("disables %s for a message longer than a Claw's task, saying why", (label, count) => {
    const { bubble } = renderBubble('<div class="chat-text">Build log</div>');
    const commands = {
      read: (command: string) => (command === "claw" ? { disabledReason: null } : null),
      claws: () =>
        Array.from({ length: count }, (_, index) => ({
          id: `claw-${index + 1}`,
          name: `Claw ${index + 1}`,
        })),
      run: vi.fn(),
    };
    const claw = (text: string) => wholeMessageActions({ commands }, { text, bubble })[0];

    // Surrounding space is trimmed from the task, so it doesn't count.
    expect(claw(` ${"x".repeat(16_000)}\n`)).toMatchObject({ label, disabled: false });
    expect(claw("x".repeat(16_001))).toMatchObject({
      label,
      disabled: true,
      tooltip: "Too long for a Claw: a task can be up to 16,000 characters.",
    });
  });
});
