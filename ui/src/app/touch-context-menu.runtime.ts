/**
 * Touch screens open context menus with a long press. iOS Safari never fires
 * `contextmenu`, so a hold inside a `[data-touch-contextmenu]` region sends the
 * same event a right-click would; each region's own handler still decides
 * whether that spot gets a menu. Android fires `contextmenu` itself, and that
 * native event then wins over the timer.
 */
const HOLD_MS = 500;
// Below the nav drawer swipe's 7px lock, so a drag cancels the hold before the drawer moves.
const MOVE_TOLERANCE_PX = 6;
// How long after the finger lifts a stray click is still swallowed.
const CLICK_SWALLOW_MS = 800;
const SKIP_TARGETS =
  "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='menu'], wa-dropdown";

type Press = {
  pointerId: number;
  target: Element;
  region: HTMLElement;
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  userSelect: string;
  webkitUserSelect: string;
  opened: boolean;
};

function hasSelection(): boolean {
  const selection = globalThis.getSelection?.();
  return Boolean(selection && !selection.isCollapsed);
}

function pressTarget(event: PointerEvent): { target: Element; region: HTMLElement } | undefined {
  const path = event.composedPath();
  const target = path[0];
  if (!(target instanceof Element)) {
    return undefined;
  }
  for (const item of path) {
    if (item instanceof HTMLElement && item.hasAttribute("data-touch-contextmenu")) {
      return { target, region: item };
    }
    if (item instanceof Element && item.matches(SKIP_TARGETS)) {
      return undefined;
    }
  }
  return undefined;
}

export function connectTouchContextMenu(signal: AbortSignal): void {
  let press: Press | undefined;
  let synthetic: MouseEvent | undefined;
  let swallowPointerId: number | undefined;
  let swallowClick = false;
  let swallowTimer: ReturnType<typeof setTimeout> | undefined;
  // Once a touch has produced a native contextmenu, the browser opens menus by itself.
  let nativeTouchMenus = false;

  const stopSwallowing = () => {
    clearTimeout(swallowTimer);
    swallowPointerId = undefined;
    swallowClick = false;
  };

  const release = () => {
    if (!press) {
      return;
    }
    clearTimeout(press.timer);
    press.region.style.userSelect = press.userSelect;
    press.region.style.webkitUserSelect = press.webkitUserSelect;
    press = undefined;
  };

  // The menu is open under the finger: its lift and the click that follows must not reach the page.
  const swallowRelease = (pointerId: number) => {
    swallowPointerId = pointerId;
    swallowClick = true;
  };

  const open = () => {
    const current = press;
    if (!current) {
      return;
    }
    current.timer = undefined;
    if (!current.target.isConnected) {
      release();
      return;
    }
    // A press never starts with a selection, so any selection now came from the hold.
    if (hasSelection()) {
      globalThis.getSelection?.()?.removeAllRanges();
    }
    current.opened = true;
    synthetic = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 2,
      clientX: current.clientX,
      clientY: current.clientY,
      screenX: current.screenX,
      screenY: current.screenY,
    });
    const handled = !current.target.dispatchEvent(synthetic);
    if (handled) {
      swallowRelease(current.pointerId);
    }
  };

  const handleDown = (event: PointerEvent) => {
    stopSwallowing();
    if (press) {
      // A second finger is a pinch or a scroll, not a hold.
      release();
      return;
    }
    if (event.pointerType !== "touch" || !event.isPrimary || event.button !== 0 || hasSelection()) {
      return;
    }
    const found = pressTarget(event);
    if (!found) {
      return;
    }
    press = {
      pointerId: event.pointerId,
      ...found,
      clientX: event.clientX,
      clientY: event.clientY,
      screenX: event.screenX,
      screenY: event.screenY,
      timer: nativeTouchMenus ? undefined : setTimeout(open, HOLD_MS),
      userSelect: found.region.style.userSelect,
      webkitUserSelect: found.region.style.webkitUserSelect,
      opened: false,
    };
    // iOS would otherwise start selecting a word at the same moment the menu opens.
    found.region.style.userSelect = "none";
    found.region.style.webkitUserSelect = "none";
  };

  const handleMove = (event: PointerEvent) => {
    if (!press || event.pointerId !== press.pointerId || press.opened) {
      return;
    }
    const moved = Math.hypot(event.clientX - press.clientX, event.clientY - press.clientY);
    if (moved > MOVE_TOLERANCE_PX) {
      release();
    }
  };

  const handleUp = (event: PointerEvent) => {
    if (event.pointerId === swallowPointerId) {
      event.stopImmediatePropagation();
      swallowPointerId = undefined;
      clearTimeout(swallowTimer);
      swallowTimer = setTimeout(stopSwallowing, CLICK_SWALLOW_MS);
    }
    if (press?.pointerId === event.pointerId) {
      release();
    }
  };

  const handleClick = (event: MouseEvent) => {
    if (swallowClick) {
      event.preventDefault();
      event.stopImmediatePropagation();
      stopSwallowing();
    }
  };

  const handleContextMenu = (event: MouseEvent) => {
    if (event === synthetic || !press) {
      return;
    }
    if (press.opened) {
      // Android's own event after ours would close and reopen the menu.
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    nativeTouchMenus = true;
    clearTimeout(press.timer);
    press.opened = true;
    swallowRelease(press.pointerId);
  };

  const cancel = () => release();
  const capture = { capture: true, signal };
  const passive = { ...capture, passive: true };
  window.addEventListener("pointerdown", handleDown, passive);
  window.addEventListener("pointermove", handleMove, passive);
  window.addEventListener("pointerup", handleUp, capture);
  window.addEventListener("pointercancel", handleUp, capture);
  window.addEventListener("click", handleClick, capture);
  window.addEventListener("contextmenu", handleContextMenu, capture);
  window.addEventListener("scroll", cancel, passive);
  window.addEventListener("blur", cancel, passive);
  document.addEventListener("visibilitychange", cancel, passive);
  signal.addEventListener(
    "abort",
    () => {
      release();
      stopSwallowing();
    },
    { once: true },
  );
}
