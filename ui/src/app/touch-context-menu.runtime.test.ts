/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectTouchContextMenu } from "./touch-context-menu.runtime.ts";

let connection: AbortController;
let region: HTMLElement;
let word: HTMLElement;
let field: HTMLInputElement;
let outside: HTMLElement;
let menus: MouseEvent[];
let lifted: number;
let clicked: number;

function pointer(
  type: string,
  target: Element,
  options: { x?: number; y?: number; id?: number; primary?: boolean; kind?: string } = {},
) {
  const event = new Event(type, { bubbles: true, cancelable: true, composed: true });
  Object.defineProperties(event, {
    pointerType: { value: options.kind ?? "touch" },
    pointerId: { value: options.id ?? 1 },
    isPrimary: { value: options.primary ?? true },
    button: { value: 0 },
    clientX: { value: options.x ?? 20 },
    clientY: { value: options.y ?? 30 },
    screenX: { value: options.x ?? 20 },
    screenY: { value: options.y ?? 30 },
  });
  target.dispatchEvent(event);
}

function tap(target: Element) {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function hold(target: Element, ms = 500) {
  pointer("pointerdown", target);
  vi.advanceTimersByTime(ms);
}

describe("touch long press", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    region = document.createElement("div");
    region.setAttribute("data-touch-contextmenu", "");
    word = Object.assign(document.createElement("span"), { textContent: "Hello" });
    field = document.createElement("input");
    outside = document.createElement("p");
    region.append(word, field);
    document.body.append(region, outside);
    menus = [];
    lifted = 0;
    clicked = 0;
    region.addEventListener("contextmenu", (event) => {
      if (!(event.target instanceof Element && event.target.closest(".open-native"))) {
        event.preventDefault();
      }
    });
    region.addEventListener("pointerup", () => (lifted += 1));
    region.addEventListener("click", () => (clicked += 1));
    connection = new AbortController();
    // Counted page-wide, so a menu sent outside the region would show up too.
    document.addEventListener("contextmenu", (event) => menus.push(event), {
      signal: connection.signal,
    });
    connectTouchContextMenu(connection.signal);
  });

  afterEach(() => {
    connection.abort();
    region.remove();
    outside.remove();
    window.getSelection()?.removeAllRanges();
    vi.useRealTimers();
  });

  it("opens the menu at the held spot and keeps the lift and next click from the page", () => {
    hold(word);
    expect(menus).toHaveLength(1);
    expect(menus[0]).toMatchObject({ target: word, clientX: 20, clientY: 30, button: 2 });
    pointer("pointerup", word);
    expect(tap(word).defaultPrevented).toBe(true);
    expect([lifted, clicked]).toEqual([0, 0]);
    // The next press is a fresh one: a tap on a menu item goes through.
    pointer("pointerdown", word);
    pointer("pointerup", word);
    tap(word);
    expect([lifted, clicked]).toEqual([1, 1]);
  });

  it("lets the click through when nothing opened a menu", () => {
    word.classList.add("open-native");
    hold(word);
    pointer("pointerup", word);
    expect(tap(word).defaultPrevented).toBe(false);
    expect([menus.length, lifted, clicked]).toEqual([1, 1, 1]);
  });

  it.each([
    [
      "an early release",
      () => {
        vi.advanceTimersByTime(499);
        pointer("pointerup", word);
      },
    ],
    ["a drag", () => pointer("pointermove", word, { x: 27 })],
    ["a cancel", () => pointer("pointercancel", word)],
    ["a second finger", () => pointer("pointerdown", word, { id: 2, primary: false })],
    ["the window losing focus", () => window.dispatchEvent(new Event("blur"))],
  ])("does not open after %s", (_name, interrupt) => {
    pointer("pointerdown", word);
    interrupt();
    vi.advanceTimersByTime(1_000);
    expect(menus).toHaveLength(0);
  });

  it("keeps holding while the page scrolls itself or another element loses focus", () => {
    pointer("pointerdown", word);
    // A transcript following a streaming reply scrolls without the finger moving.
    region.dispatchEvent(new Event("scroll"));
    document.dispatchEvent(new Event("scroll", { bubbles: true }));
    field.dispatchEvent(new FocusEvent("blur"));
    vi.advanceTimersByTime(500);
    expect(menus).toHaveLength(1);
  });

  it.each([
    ["a mouse press", () => pointer("pointerdown", word, { kind: "mouse" })],
    ["an unmarked spot", () => pointer("pointerdown", outside)],
    ["a field", () => pointer("pointerdown", field)],
    [
      "a press over a selection",
      () => {
        window.getSelection()?.selectAllChildren(word);
        pointer("pointerdown", word);
      },
    ],
  ])("ignores %s", (_name, press) => {
    press();
    vi.advanceTimersByTime(1_000);
    expect([menus.length, region.style.userSelect]).toEqual([0, ""]);
  });

  it("clears a selection the hold started and blocks selection only while pressed", () => {
    pointer("pointerdown", word);
    expect(region.style.userSelect).toBe("none");
    window.getSelection()?.selectAllChildren(word);
    vi.advanceTimersByTime(500);
    expect(window.getSelection()?.isCollapsed).toBe(true);
    pointer("pointerup", word);
    expect(region.style.userSelect).toBe("");
  });

  it("lets Android's own contextmenu win and drops a late duplicate", () => {
    pointer("pointerdown", word);
    word.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    vi.advanceTimersByTime(1_000);
    expect(menus).toHaveLength(1);
    pointer("pointerup", word);
    expect([lifted, clicked, tap(word).defaultPrevented]).toEqual([0, 0, true]);
    // From now on the browser opens menus itself; the hold only dedupes.
    hold(word, 1_000);
    expect(menus).toHaveLength(1);
  });

  it("cancels a native contextmenu that follows its own", () => {
    hold(word);
    const late = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    word.dispatchEvent(late);
    expect([menus.length, late.defaultPrevented]).toEqual([1, true]);
  });

  it("leaves the browser's own menu to a spot that declined its menu", () => {
    word.classList.add("open-native");
    hold(word);
    const late = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    word.dispatchEvent(late);
    expect([menus.length, late.defaultPrevented]).toEqual([2, false]);
  });

  it("keeps swallowing the lift when a second finger taps while the menu is open", () => {
    hold(word);
    pointer("pointerdown", word, { id: 2, primary: false });
    pointer("pointerup", word, { id: 2, primary: false });
    pointer("pointerup", word);
    // Only the second finger's lift reaches the page.
    expect([menus.length, lifted, tap(word).defaultPrevented]).toEqual([1, 1, true]);
  });

  it("stops after disconnect", () => {
    pointer("pointerdown", word);
    connection.abort();
    vi.advanceTimersByTime(1_000);
    expect([menus.length, region.style.userSelect]).toEqual([0, ""]);
  });
});
