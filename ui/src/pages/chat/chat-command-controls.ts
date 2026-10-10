import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ApplicationContext } from "../../app/context.ts";
import type { ClawChoice } from "../../components/claw-task-dialog.ts";
import { t } from "../../i18n/index.ts";
import {
  chatOffersClaws,
  delegateToClaw,
  readClawDelegationAccess,
} from "../../lib/agents/claw-delegation.ts";
import { clawsOf, normalizeAgentLabel } from "../../lib/agents/display.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { showToast } from "../../lib/toast.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { dispatchChatSlashCommand } from "./chat-commands.ts";
import { chatGoalRecovery, setChatGoalDraftMode } from "./chat-goals.ts";
import { CHAT_COMPOSER_TEXTAREA_SELECTOR } from "./chat-pane-shared.ts";
import { isChatPaneWorking } from "./chat-pane-state.ts";
import { readChatSessionActionAccess } from "./chat-session-action-access.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAgentId, selectedChatSessionRow } from "./chat-state-route.ts";

/** Session commands offered as buttons and menu items, so nobody has to type them. */
export type ChatControlCommand = "goal" | "compact" | "learn" | "loop" | "export" | "claw";

export type ChatCommandControls = {
  /** Null hides the item; a reason disables it. */
  read: (command: ChatControlCommand) => { disabledReason: string | null } | null;
  /** The chat bot's Claws in roster order: the ones a message can be sent to. */
  claws: () => ClawChoice[];
  /**
   * `message` turns learn into "save this message's workflow as a skill" and is the task a
   * Claw gets; without `clawId` the claw command asks which Claw first. Settles once the
   * command finished; a failure is toasted, never thrown.
   */
  run: (
    command: ChatControlCommand,
    options?: { message?: string; clawId?: string },
  ) => Promise<void>;
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
    const text =
      isRecord(message) && message.role === "user" ? extractText(message)?.trim() : undefined;
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
  context: {
    gateway: Pick<ApplicationContext["gateway"], "snapshot">;
    agents: { state: Pick<ApplicationContext["agents"]["state"], "agentsList"> };
  },
  gate: ComposerGate,
  pane: ComposerPane,
): ChatCommandControls {
  const { gateway } = context;
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
          : command === "claw"
            ? readClawDelegationAccess(gateway.snapshot)
            : null;
    return access?.allowed === false && access.cause !== "disconnected";
  };
  const claws = () =>
    clawsOf(context.agents.state.agentsList?.agents ?? [], resolveChatAgentId(state)).map(
      (agent) => ({ id: agent.id, name: normalizeAgentLabel(agent) }),
    );
  const clawsHidden = () =>
    !chatOffersClaws({
      sessionKey: state.sessionKey,
      incognito: state.selectedChatSessionIncognito,
    }) || claws().length === 0;
  const disabledReason = (command: ChatControlCommand) =>
    (!state.connected ? t("sessionsView.actionRequiresConnection") : null) ??
    (gate.canSend ? null : (gate.disabledReason ?? t("chat.commandControls.unavailable"))) ??
    // A Claw works beside the bot, so it waits for neither the bot's model nor its reply.
    (command === "claw"
      ? null
      : (gate.submitDisabledReason ??
        gate.modelRequiredReason ??
        (isChatPaneWorking(state) ? t("chat.commandControls.availableWhenIdle") : null) ??
        (command === "compact" &&
        (state.compactionStatus?.phase === "active" || compactRequests.has(state))
          ? t("chat.commandControls.compacting")
          : null) ??
        (command === "goal" && chatGoalRecovery(state) ? t("chat.goals.outcomeUnknown") : null)));
  const read: ChatCommandControls["read"] = (command) => {
    if (command === "export") {
      // Export reads the loaded transcript; it needs neither a connection nor a send slot.
      return { disabledReason: null };
    }
    if (
      hiddenByAccess(command) ||
      (command === "goal" && (selectedChatSessionRow(state)?.goal || state.chatGoalDraftMode)) ||
      (command === "claw" && clawsHidden())
    ) {
      return null;
    }
    return { disabledReason: disabledReason(command) };
  };
  // Toasts the reason when a command can no longer run, so no click ends silently.
  const blocked = (command: ChatControlCommand) => {
    const current = read(command);
    if (current && !current.disabledReason) {
      return false;
    }
    showToast({ message: current?.disabledReason ?? t("chat.commandControls.unavailable") });
    return true;
  };
  // A dialog can outlive the state it opened in: re-check before sending what it returns.
  const sendIfStillAvailable = (command: ChatControlCommand, sessionKey: string, text: string) => {
    if (state.sessionKey !== sessionKey) {
      showToast({ message: t("chat.commandControls.unavailable") });
    } else if (!blocked(command)) {
      void state.handleSendChat(text, { replyTargetOverride: null, followUpMode: "queue" });
    }
  };
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
  // `target` is the session captured at click time, so a chat that moved on refuses the task.
  const sendToClaw = async (
    target: { sessionKey: string; sessionId?: string },
    request: { clawId: string; task: string; idempotencyKey: string },
  ) => {
    const client = state.sessionKey === target.sessionKey ? state.client : null;
    const current = read("claw");
    if (!client || !current || current.disabledReason) {
      return current?.disabledReason ?? t("chat.commandControls.unavailable");
    }
    const { clawId, ...rest } = request;
    const name = claws().find((claw) => claw.id === clawId)?.name ?? clawId;
    return delegateToClaw(client, { ...target, targetAgentId: clawId, ...rest }, name);
  };
  const runNow = async (
    command: ChatControlCommand,
    { message, clawId }: { message?: string; clawId?: string } = {},
  ) => {
    const sessionKey = state.sessionKey;
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
          sendIfStillAvailable(command, sessionKey, `/learn ${request.trim()}`.trim());
        }
        break;
      }
      case "loop": {
        const task = lastUserTask(state);
        const schedule = await ask("repeat", task ? `30m ${task}` : "30m ");
        if (schedule) {
          sendIfStillAvailable(command, sessionKey, `/loop ${schedule}`);
        }
        break;
      }
      case "claw": {
        const task = message?.trim();
        if (!task) {
          break;
        }
        const target = {
          sessionKey,
          ...(state.currentSessionId ? { sessionId: state.currentSessionId } : {}),
        };
        if (clawId) {
          const error = await sendToClaw(target, { clawId, task, idempotencyKey: generateUUID() });
          if (error) {
            showToast({ message: error });
          }
          break;
        }
        const { showClawTaskDialog } = await import("../../components/claw-task-dialog.ts");
        await showClawTaskDialog({
          claws: claws(),
          task,
          submit: (request) => sendToClaw(target, request),
        });
        break;
      }
    }
  };
  return {
    read,
    claws,
    async run(command, options) {
      // Menus can outlive the render that built them; check again at click time.
      if (blocked(command)) {
        return;
      }
      try {
        await runNow(command, options);
      } catch (error) {
        showToast({ message: t("chat.commandControls.failed", { error: formatUiError(error) }) });
      }
    },
  };
}
