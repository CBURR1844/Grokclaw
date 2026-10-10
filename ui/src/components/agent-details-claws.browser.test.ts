import { expectDefined } from "@openclaw/normalization-core";
import { html, render } from "lit";
import { afterEach, expect, it } from "vitest";
import "../test-helpers/load-styles.ts";
import "../styles/agent-details-panel.css";

afterEach(() => {
  document.body.replaceChildren();
});

it("keeps each Claw's last-run line one small, muted line under its name", () => {
  const summary = "Sorted 46 emails into Receipts, Travel, Newsletters and Follow-ups. ".repeat(4);
  render(
    html`<ul class="agent-details__claws" style="width: 280px">
      <li class="agent-details__claw">
        <div class="agent-details__claw-head">
          <span class="agent-details__claw-avatar"></span>
          <span class="agent-details__claw-copy">
            <strong>Inbox Sorter</strong>
            <span class="agent-details__claw-last">Last ran 9:14 · ${summary}</span>
          </span>
        </div>
        <div class="agent-details__claw-idle">
          <p class="agent-details__claw-none">No schedule yet</p>
        </div>
      </li>
      <span class="probe" style="color: var(--muted)"></span>
    </ul>`,
    document.body,
  );
  const style = (selector: string) =>
    getComputedStyle(expectDefined(document.body.querySelector(selector), selector));
  const last = expectDefined(
    document.body.querySelector<HTMLElement>(".agent-details__claw-last"),
    "last-run line",
  );

  // A long summary is cut off with an ellipsis instead of wrapping the card taller.
  expect(last.scrollWidth).toBeGreaterThan(last.clientWidth);
  expect(last.getBoundingClientRect().height).toBeLessThan(
    2 * Number.parseFloat(style(".agent-details__claw-last").fontSize),
  );
  expect(Number.parseFloat(style(".agent-details__claw-last").fontSize)).toBeLessThan(
    Number.parseFloat(style(".agent-details__claw-copy strong").fontSize),
  );
  for (const line of [".agent-details__claw-last", ".agent-details__claw-none"]) {
    expect(style(line).color).toBe(style(".probe").color);
  }
});
