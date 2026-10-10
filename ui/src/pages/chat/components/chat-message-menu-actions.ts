import { t } from "../../../i18n/index.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import type { ChatSelectionSource } from "../../../lib/chat/chat-types.ts";
import { isReadingAloud } from "../../../lib/chat/read-aloud.ts";
import type { ChatCommandControls } from "../chat-command-controls.ts";
import { chatBubbleRangeSource } from "./chat-selection-popup.ts";

registerChatMessageMetadataEnglish();

type MessageMenuAction = { label: string; disabled: boolean; tooltip: string; run: () => void };

// The side chat pins its comment to DOM text offsets, so it asks about the rendered body.
function renderedBodySource(bubble: HTMLElement, body: HTMLElement) {
  const range = bubble.ownerDocument.createRange();
  range.selectNodeContents(body);
  // The model reads this text, so it needs the rendered line breaks a selection's text has;
  // textContent runs paragraphs together. jsdom lacks innerText.
  // oxlint-disable-next-line unicorn/prefer-dom-node-text-content
  return chatBubbleRangeSource(bubble, range, body.innerText || range.toString());
}

/**
 * The message menu's actions on a whole message, in menu order: ask about it in a side
 * chat, save its workflow as a skill, and read it aloud. Only messages with a text body get
 * them; tool output and attachment-only rows have nothing to ask about, learn or read.
 */
export function wholeMessageActions(
  props: {
    onCompanionSelection?: (selection: ChatSelectionSource, anchorRect: DOMRect) => void;
    commands?: ChatCommandControls;
    onReadAloud?: (text: string) => void;
  },
  message: { text?: string; bubble?: HTMLElement | null },
): MessageMenuAction[] {
  const { text, bubble } = message;
  const body = bubble?.querySelector<HTMLElement>(".chat-text");
  if (!text || !bubble || !body) {
    return [];
  }
  const actions: MessageMenuAction[] = [];
  const add = (label: string, run: () => void, disabledReason: string | null = null) =>
    actions.push({
      label,
      disabled: disabledReason !== null,
      tooltip: disabledReason ?? label,
      run,
    });
  const { onCompanionSelection, onReadAloud, commands } = props;
  const selection = onCompanionSelection ? renderedBodySource(bubble, body) : null;
  if (onCompanionSelection && selection) {
    add(t("chat.messages.askInSideChat"), () =>
      onCompanionSelection(selection, bubble.getBoundingClientRect()),
    );
  }
  const learn = commands?.read("learn");
  if (learn) {
    add(
      t("chat.messages.saveAsSkill"),
      () => commands?.run("learn", { message: text }),
      learn.disabledReason,
    );
  }
  if (onReadAloud) {
    const reading = isReadingAloud(text);
    add(t(reading ? "chat.messages.stopReadingAloud" : "chat.messages.readAloud"), () =>
      onReadAloud(text),
    );
  }
  return actions;
}
