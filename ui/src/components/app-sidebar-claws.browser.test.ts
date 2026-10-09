import { expect, it } from "vitest";
import {
  agentIds,
  mountRoster,
  roster,
  settleRoster,
  toggleRoster,
} from "../test-helpers/app-sidebar-cases/roster.test-support.ts";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import "../test-helpers/load-styles.ts";
import "./app-sidebar.ts";

setupSidebarTest();

it("keeps a Claw out of the roster, its session sections and the new-chat menu", async () => {
  expect(roster.agents.find((agent) => agent.id === "sorter")?.claw).toBeDefined();
  const { sidebar, result } = await mountRoster();
  // The Claw has its own chats in the listing; only the chat-partner surfaces drop them.
  expect(result.sessions.filter((row) => row.agentId === "sorter").length).toBeGreaterThan(0);
  await toggleRoster(sidebar);
  await settleRoster(sidebar);

  expect(agentIds(sidebar)).toEqual(["main", "recent", "working"]);
  const keys = (prefix: string) =>
    sidebar.querySelectorAll(`[data-session-key^="${prefix}"]`).length;
  expect(keys("agent:working:")).toBeGreaterThan(0);
  expect(keys("agent:sorter:")).toBe(0);
  expect(sidebar.querySelector('[data-agent-id="sorter"]')).toBeNull();
  expect(sidebar.textContent).not.toContain("Inbox Sorter");

  const items = [...sidebar.querySelectorAll(".sidebar-new-session-menu wa-dropdown-item")];
  expect(items.map((item) => item.getAttribute("value"))).toEqual([
    "main",
    "recent",
    "working",
    "command:new-agent",
  ]);
});
