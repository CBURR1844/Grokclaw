import { describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import type { ChatCommandControls, ChatControlCommand } from "./chat-command-controls.ts";
import { ChatPaneHeaderSessionActions } from "./chat-pane-header-session-actions.ts";

const context = { gateway: { snapshot: { phase: "connected" } } } as unknown as ApplicationContext;

function controls(
  states: Partial<Record<ChatControlCommand, { disabledReason: string | null }>>,
): ChatCommandControls {
  return { read: (command) => states[command] ?? null, run: vi.fn() };
}

describe("chat menu session actions", () => {
  it("lists the offered commands with their reasons", () => {
    const actions = new ChatPaneHeaderSessionActions().read(
      context,
      undefined,
      undefined,
      vi.fn(),
      controls({
        compact: { disabledReason: null },
        goal: { disabledReason: "Available when the current reply finishes" },
        export: { disabledReason: null },
      }),
    );

    expect(
      actions.map((action) => ({
        id: action.id,
        label: action.label,
        disabled: "disabled" in action && action.disabled,
        description: action.description,
      })),
    ).toEqual([
      {
        id: "free-space",
        label: "Free up space",
        disabled: false,
        description: "Summarize older messages to make room",
      },
      {
        id: "set-goal",
        label: "Set a goal…",
        disabled: true,
        description: "Available when the current reply finishes",
      },
      { id: "export-chat", label: "Export chat", disabled: false, description: undefined },
    ]);
  });

  it("keeps the cached list but runs the latest controls", () => {
    const sessionActions = new ChatPaneHeaderSessionActions();
    const onAction = vi.fn();
    const first = controls({ compact: { disabledReason: null } });
    const second = controls({ compact: { disabledReason: null } });

    const cached = sessionActions.read(context, undefined, undefined, onAction, first);
    const next = sessionActions.read(context, undefined, undefined, onAction, second);
    const freeSpace = next.find((action) => action.id === "free-space");
    if (!freeSpace || freeSpace.kind === "status") {
      throw new Error("expected Free up space");
    }
    freeSpace.onActivate();

    expect(next).toBe(cached);
    expect(first.run).not.toHaveBeenCalled();
    expect(second.run).toHaveBeenCalledWith("compact");
  });

  it("offers no commands where the pane has none", () => {
    expect(
      new ChatPaneHeaderSessionActions().read(context, undefined, undefined, vi.fn(), undefined),
    ).toEqual([]);
  });
});
