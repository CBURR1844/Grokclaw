import { t } from "../../../i18n/index.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import type { ChatSelectionSource } from "../../../lib/chat/chat-types.ts";
import { isReadingAloud } from "../../../lib/chat/read-aloud.ts";
import type { ChatCommandControls } from "../chat-command-controls.ts";

registerChatMessageMetadataEnglish();

type MessageMenuAction = { label: string; disabled: boolean; tooltip: string; run: () => void };

/**
 * The message menu's actions on a whole message, in menu order: ask about it in a side
 * chat, save its workflow as a skill, and read it aloud. Each uses the message's copy
 * text, so attachment-only replies get them too.
 */
export function wholeMessageActions(
  props: {
    onCompanionSelection?: (selection: ChatSelectionSource, anchorRect: DOMRect) => void;
    commands?: ChatCommandControls;
    onReadAloud?: (text: string) => void;
  },
  message: { text?: string; bubble?: HTMLElement | null; messageId: string; entryId: string },
): MessageMenuAction[] {
  const { text, bubble } = message;
  if (!text || !bubble) {
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
  if (onCompanionSelection) {
    add(t("chat.messages.askInSideChat"), () =>
      onCompanionSelection(
        {
          text,
          start: 0,
          end: text.length,
          messageId: message.messageId || undefined,
          entryId: message.entryId || undefined,
        },
        bubble.getBoundingClientRect(),
      ),
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
