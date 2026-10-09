import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { showToast } from "../../lib/toast.ts";
import { dispatchChatSlashCommand } from "./chat-commands.ts";
import { chatGoalRecovery, setChatGoalDraftMode } from "./chat-goals.ts";
import { CHAT_COMPOSER_TEXTAREA_SELECTOR } from "./chat-pane-shared.ts";
import { isChatPaneWorking } from "./chat-pane-state.ts";
import { readChatSessionActionAccess } from "./chat-session-action-access.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";

/** Session commands offered as buttons and menu items, so nobody has to type them. */
export type ChatControlCommand = "goal" | "compact" | "learn" | "loop" | "export";

export type ChatCommandControls = {
  /** Null hides the item; a reason disables it. */
  read(command: ChatControlCommand): { disabledReason: string | null } | null;
  /** `message` turns learn into "save this message's workflow as a skill". */
  run(command: ChatControlCommand, options?: { message?: string }): void;
};

type ComposerGate = {
  canSend: boolean;
  disabledReason?: string | null;
  submitDisabledReason?: string | null;
  modelRequiredReason?: string | null;
};

type ComposerPane = { readonly updateComplete: Promise<unknown> } & Pick<Element, "querySelector">;

const LEARN_EXCERPT_CHARS = 300;
const LOOP_TASK_CHARS = 200;
// The session.operation start event arrives after sessions.compact is accepted;
// this covers the gap so a second click cannot queue another compaction.
const compactRequests = new WeakSet<ChatPageHost>();

function excerpt(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}

function lastUserTask(state: ChatPageHost): string {
  for (const message of state.chatMessages.toReversed()) {
    const record = message as { role?: unknown };
    const text = record.role === "user" ? extractText(message)?.trim() : undefined;
    if (text && !text.startsWith("/")) {
      return excerpt(text, LOOP_TASK_CHARS);
    }
  }
  return "";
}

/**
 * The one owner of when each command is offered, why it is unavailable, and how it runs.
 * Commands become slash text only here, right before chat.send, and go through the same
 * Gateway permission checks as typing them.
 */
export function createChatCommandControls(
  state: ChatPageHost,
  gateway: Pick<ApplicationContext["gateway"], "snapshot">,
  gate: ComposerGate,
  pane: ComposerPane,
): ChatCommandControls {
  const hiddenByAccess = (command: ChatControlCommand) => {
    const access =
      command === "compact"
        ? readChatSessionActionAccess(gateway.snapshot, Boolean(state.chatRunId)).compact
        : command === "loop"
          ? // The Gateway runs /loop for owners only; operator.admin is how the UI sees that.
            readSessionMethodAccess(gateway.snapshot, {
              method: "chat.send",
              requiredScope: "operator.admin",
            })
          : null;
    return access?.allowed === false && access.cause !== "disconnected";
  };
  const disabledReason = (command: ChatControlCommand) =>
    (!state.connected ? t("sessionsView.actionRequiresConnection") : null) ??
    (gate.canSend ? null : (gate.disabledReason ?? t("chat.commandControls.unavailable"))) ??
    gate.submitDisabledReason ??
    gate.modelRequiredReason ??
    (isChatPaneWorking(state) ? t("chat.commandControls.availableWhenIdle") : null) ??
    (command === "compact" &&
    (state.compactionStatus?.phase === "active" || compactRequests.has(state))
      ? t("chat.commandControls.compacting")
      : null) ??
    (command === "goal" && chatGoalRecovery(state) ? t("chat.goals.outcomeUnknown") : null);
  const read: ChatCommandControls["read"] = (command) => {
    if (command === "export") {
      // Export reads the loaded transcript; it needs neither a connection nor a send slot.
      return { disabledReason: null };
    }
    if (
      hiddenByAccess(command) ||
      (command === "goal" && (selectedChatSessionRow(state)?.goal || state.chatGoalDraftMode))
    ) {
      return null;
    }
    return { disabledReason: disabledReason(command) };
  };
  const send = (text: string) =>
    void state.handleSendChat(text, { replyTargetOverride: null, followUpMode: "queue" });
  const focusComposer = () =>
    void pane.updateComplete.then(() =>
      pane
        .querySelector<HTMLTextAreaElement>(CHAT_COMPOSER_TEXTAREA_SELECTOR)
        ?.focus({ preventScroll: true }),
    );
  const ask = async (dialog: "repeat" | "teachSkill", defaultValue = "") => {
    const { showInputDialog } = await import("../../components/input-dialog.ts");
    return showInputDialog({
      title: t(`chat.commandControls.${dialog}DialogTitle`),
      label: t(`chat.commandControls.${dialog}DialogLabel`),
      submitLabel: t(`chat.commandControls.${dialog}DialogSubmit`),
      defaultValue,
      requireValue: dialog === "repeat",
    });
  };
  const runNow = async (command: ChatControlCommand, message?: string) => {
    switch (command) {
      case "export":
        await dispatchChatSlashCommand(state, "export-session", "");
        break;
      case "goal":
        setChatGoalDraftMode(state, {
          ...(state.currentSessionId ? { sessionId: state.currentSessionId } : {}),
          action: "start",
        });
        state.requestUpdate?.();
        focusComposer();
        break;
      case "compact":
        compactRequests.add(state);
        state.requestUpdate?.();
        try {
          await dispatchChatSlashCommand(state, "compact", "");
        } finally {
          compactRequests.delete(state);
          state.requestUpdate?.();
        }
        break;
      case "learn": {
        const request = message
          ? t("chat.commandControls.learnFromMessage", {
              excerpt: excerpt(message, LEARN_EXCERPT_CHARS),
            })
          : await ask("teachSkill");
        // An empty request lets the Gateway learn from the conversation so far.
        if (request !== null) {
          send(`/learn ${request.trim()}`.trim());
        }
        break;
      }
      case "loop": {
        const task = lastUserTask(state);
        const schedule = await ask("repeat", task ? `30m ${task}` : "30m ");
        if (schedule) {
          send(`/loop ${schedule}`);
        }
        break;
      }
    }
  };
  return {
    read,
    run(command, options) {
      // Menus can outlive the render that built them; check again at click time.
      const current = read(command);
      if (!current || current.disabledReason) {
        showToast({ message: current?.disabledReason ?? t("chat.commandControls.unavailable") });
        return;
      }
      void runNow(command, options?.message);
    },
  };
}
