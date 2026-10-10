import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { getRenderedModalDialog } from "../test-helpers/modal-dialog.ts";
import "../test-helpers/load-styles.ts";
import { showClawTaskDialog, type ClawTaskRequest } from "./claw-task-dialog.ts";

const CLAWS = [
  { id: "sorter", name: "Inbox Sorter" },
  { id: "brief", name: "Morning Brief" },
  { id: "scout", name: "Scout" },
  { id: "ledger", name: "Expense Ledger" },
];

const form = () => document.body.querySelector<HTMLFormElement>("openclaw-modal-dialog form");
const button = (label: string) =>
  [...(form()?.querySelectorAll("button") ?? [])].find(
    (candidate) => candidate.textContent?.trim() === label,
  );

beforeEach(async () => {
  await i18n.setLocale("en");
});

afterEach(async () => {
  const { page } = await import("vitest/browser");
  document.body.replaceChildren();
  await page.viewport(1280, 900);
});

describe("Claw task dialog", () => {
  it("picks a Claw from the keyboard and sends the message to it", async () => {
    const { userEvent } = await import("vitest/browser");
    const submit = vi.fn(async (_request: ClawTaskRequest) => null);
    const result = showClawTaskDialog({ task: "Sort my inbox", claws: CLAWS, submit });
    await getRenderedModalDialog(document.body);

    // Focus starts on the first Claw; arrows move the choice like any radio group.
    await vi.waitFor(() =>
      expect(document.activeElement?.closest("label")?.textContent?.trim()).toBe("Inbox Sorter"),
    );
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.keyboard("{Enter}");

    await expect(result).resolves.toBe(true);
    expect(submit).toHaveBeenCalledExactlyOnceWith({
      clawId: "brief",
      task: "Sort my inbox",
      idempotencyKey: expect.any(String),
    });
    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
  });

  it("keeps a refused task open and retries an unchanged one with the same key", async () => {
    const { userEvent } = await import("vitest/browser");
    const answers = [
      "Couldn't do that: This bot's tool settings don't let it start helpers.",
      null,
    ];
    const submit = vi.fn(async (_request: ClawTaskRequest) => answers.shift() ?? null);
    const result = showClawTaskDialog({ claw: CLAWS[1]!, submit });
    await getRenderedModalDialog(document.body);
    const task = () => form()?.querySelector("textarea");

    await vi.waitFor(() => expect(document.activeElement).toBe(task()));
    expect(button("Run")?.disabled).toBe(true);
    await userEvent.keyboard("Summarize the news");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");

    await vi.waitFor(() =>
      expect(form()?.querySelector("[role='alert']")?.textContent).toContain(
        "don't let it start helpers",
      ),
    );
    expect(document.activeElement).toBe(task());
    await userEvent.click(button("Run")!);

    await expect(result).resolves.toBe(true);
    const keys = submit.mock.calls.map(([request]) => request.idempotencyKey);
    expect(submit.mock.calls.map(([request]) => request.task)).toEqual([
      "Summarize the news",
      "Summarize the news",
    ]);
    expect(keys[1]).toBe(keys[0]);
  });

  it("counts a task the way the Gateway does and blocks one that is too long", async () => {
    const { userEvent } = await import("vitest/browser");
    const submit = vi.fn(async (_request: ClawTaskRequest) => null);
    const result = showClawTaskDialog({ claw: CLAWS[1]!, submit });
    await getRenderedModalDialog(document.body);
    const task = form()?.querySelector("textarea");
    const alert = () => form()?.querySelector("[role='alert']")?.textContent?.trim();

    // 16,000 emoji are 32,000 UTF-16 units but 16,000 characters, which the Gateway admits.
    await userEvent.fill(task!, "😊".repeat(16_001));
    await vi.waitFor(() =>
      expect(alert()).toBe("Too long for a Claw: a task can be up to 16,000 characters."),
    );
    expect(button("Run")?.disabled).toBe(true);
    expect(task?.getAttribute("aria-invalid")).toBe("true");

    await userEvent.fill(task!, "😊".repeat(16_000));
    await vi.waitFor(() => expect(alert()).toBeUndefined());
    await userEvent.click(button("Run")!);
    await expect(result).resolves.toBe(true);
    expect(submit.mock.calls[0]?.[0].task).toBe("😊".repeat(16_000));
  });

  it("starts a new key when the task changes after an unconfirmed attempt", async () => {
    const { userEvent } = await import("vitest/browser");
    const answers = ["Couldn't confirm Morning Brief started.", null];
    const submit = vi.fn(async (_request: ClawTaskRequest) => answers.shift() ?? null);
    const result = showClawTaskDialog({ claw: CLAWS[1]!, submit });
    await getRenderedModalDialog(document.body);

    await userEvent.keyboard("Summarize the news");
    await userEvent.click(button("Run")!);
    await vi.waitFor(() => expect(form()?.querySelector("[role='alert']")).not.toBeNull());
    await userEvent.keyboard(" today");
    await userEvent.click(button("Run")!);

    await expect(result).resolves.toBe(true);
    const [first, second] = submit.mock.calls.map(([request]) => request);
    expect(second?.task).toBe("Summarize the news today");
    expect(second?.idempotencyKey).not.toBe(first?.idempotencyKey);
  });

  it("fits a phone and closes on Escape without sending", async () => {
    const { page, userEvent } = await import("vitest/browser");
    await page.viewport(390, 844);
    const submit = vi.fn(async (_request: ClawTaskRequest) => null);
    const result = showClawTaskDialog({ task: "Sort my inbox", claws: CLAWS, submit });
    await getRenderedModalDialog(document.body);
    // Measure the settled layout, not the card's scale-in.
    await Promise.all(document.getAnimations().map((animation) => animation.finished));

    const card = form()!.getBoundingClientRect();
    expect(card.left).toBeGreaterThanOrEqual(0);
    expect(card.right).toBeLessThanOrEqual(window.innerWidth);
    expect(button("Send")!.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    for (const choice of form()!.querySelectorAll("label")) {
      expect(choice.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }

    await userEvent.keyboard("{Escape}");
    await expect(result).resolves.toBe(false);
    expect(submit).not.toHaveBeenCalled();
  });
});
