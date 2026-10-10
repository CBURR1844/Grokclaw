import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { resolveCloudWorkerStopAction } from "../../components/cloud-worker-stop.ts";
import { icons } from "../../components/icons.ts";
import { i18n, t } from "../../i18n/index.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { pluginSessionMenuActions } from "../../plugins/control-ui-actions.ts";
import type { ChatCommandControls, ChatControlCommand } from "./chat-command-controls.ts";
import { ChatPaneHeaderMemo } from "./chat-pane-header-memo.ts";
import type {
  HeaderMenuAction,
  HeaderMenuQuickAction,
} from "./components/chat-header-session-menu.ts";

// Ids are menu values: no ":" and none of the compact layout's `compact:*` values.
// Labels are thunks so the locale applies at render time and i18n verify sees literal keys.
const COMMAND_ITEMS = [
  ["free-space", "compact", () => t("chat.commandControls.freeUpSpace"), icons.layers],
  ["set-goal", "goal", () => t("chat.commandControls.setGoal"), icons.target],
  ["export-chat", "export", () => t("chat.runControls.exportChat"), icons.download],
] as const satisfies readonly (readonly [string, ChatControlCommand, () => string, unknown])[];

/** The chat menu's session group: typed-command replacements, plugin actions, then stop. */
export class ChatPaneHeaderSessionActions {
  private readonly memo = new ChatPaneHeaderMemo<HeaderMenuQuickAction[]>();
  // Memoized items call the latest controls, so a cached list never runs a stale render's gate.
  private commands: ChatCommandControls | undefined;

  read(
    context: ApplicationContext,
    row: GatewaySessionRow | undefined,
    stopDisabledReason: string | undefined,
    onAction: (action: HeaderMenuAction) => void,
    commands: ChatCommandControls | undefined,
  ): HeaderMenuQuickAction[] {
    this.commands = commands;
    const commandItems = COMMAND_ITEMS.flatMap(([id, command, label, icon]) => {
      const state = commands?.read(command);
      return state ? [{ id, command, label, icon, disabledReason: state.disabledReason }] : [];
    });
    const enabled = context.nativeConversation?.supportsSessionActions;
    const pluginActions = enabled && row ? pluginSessionMenuActions(context.plugins, row) : [];
    const canStop = Boolean(
      enabled &&
      resolveCloudWorkerStopAction(row?.placement) &&
      isGatewayMethodAdvertised(context.gateway.snapshot, "sessions.reclaim"),
    );
    return this.memo.read(
      [
        ...commandItems.flatMap(({ id, disabledReason }) => [id, disabledReason]),
        ...pluginActions.flatMap(({ id, label, disabled }) => [id, label, disabled]),
        canStop,
        stopDisabledReason,
        i18n.getLocale(),
        onAction,
      ],
      () => [
        ...commandItems.map(({ id, command, label, icon, disabledReason }) => ({
          id,
          label: label(),
          icon,
          disabled: disabledReason !== null,
          description:
            disabledReason ??
            (command === "compact" ? t("chat.commandControls.freeUpSpaceDescription") : undefined),
          onActivate: () => void this.commands?.run(command),
        })),
        ...pluginActions.map((action) => ({
          label: action.label,
          disabled: action.disabled,
          id: `plugin/${action.id}`,
          icon: icons.plug,
          onActivate: () => onAction({ kind: "plugin", id: action.id }),
        })),
        ...(canStop
          ? [
              {
                id: "stop-cloud-worker",
                label: t("sessionsView.stopCloudWorker"),
                icon: icons.stop,
                variant: "danger" as const,
                disabled: Boolean(stopDisabledReason),
                description: stopDisabledReason,
                onActivate: () => onAction({ kind: "stop-cloud-worker" }),
              },
            ]
          : []),
      ],
    );
  }
}
