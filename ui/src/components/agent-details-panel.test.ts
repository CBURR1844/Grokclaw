/* @vitest-environment jsdom */
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { AgentsListResult, CronCompactJob } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import { i18n } from "../i18n/index.ts";
import { createRuntimeConfigCapability } from "../lib/config/runtime-config-capability.ts";
import { createTestSessionCapability } from "../lib/sessions/session-capability.test-support.ts";
import { disposeSidebarContextLifecycles } from "../test-helpers/app-sidebar-context-lifecycle.ts";
import { createContext, createGatewayHarness } from "../test-helpers/app-sidebar.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
  type GatewayRequestMock,
} from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import "./agent-details-panel.ts";

const METHODS = [
  "config.get",
  "config.patch",
  "cron.list",
  "cron.run",
  "cron.runs",
  "cron.update",
  "sessions.list",
  "sessions.subscribe",
];

function job(id: string, agentId: string, extra: Partial<CronCompactJob>): CronCompactJob {
  return {
    id,
    name: id,
    agentId,
    enabled: true,
    updatedAtMs: 1,
    nextRunAt: null,
    nextRunAtMs: null,
    scheduleKind: "cron",
    lastRunAt: null,
    lastRunAtMs: null,
    lastRunStatus: null,
    ...extra,
  } as CronCompactJob;
}

const sorterJobs = [
  job("sort-often", "sorter", {
    schedule: { kind: "cron", expr: "*/15 * * * *" },
    lastRunAtMs: 1_700_000_000_000,
    lastRunStatus: "ok",
  }),
  job("sort-weekdays", "sorter", {
    enabled: false,
    schedule: { kind: "cron", expr: "0 8 * * 1-5" },
  }),
];

function roster(extraClaws = 0): AgentsListResult {
  const claw = { requesterAgentIds: ["forge"] };
  return {
    defaultId: "main",
    mainKey: "main",
    scope: "per-sender",
    agents: [
      { id: "main", name: "Main" },
      { id: "forge", name: "Forge" },
      { id: "sorter", name: "Inbox Sorter", claw },
      { id: "brief", name: "Morning Brief", claw },
      ...Array.from({ length: extraClaws }, (_, index) => ({ id: `extra-${index}`, claw })),
      { id: "scout", name: "Scout" },
    ],
  };
}

function mount(agentId: string, options: { allowAgents?: string[]; extraClaws?: number } = {}) {
  const config = {
    agents: {
      entries: {
        main: { default: true },
        forge: { subagents: { allowAgents: options.allowAgents ?? ["sorter", "brief"] } },
        sorter: { kind: "claw" },
        brief: { kind: "claw" },
        scout: {},
      },
    },
  };
  const patches: Array<{ raw: unknown; replacePaths?: string[] }> = [];
  const waiters = new Set<() => void>();
  const wake = () => waiters.forEach((check) => check());
  const request: GatewayRequestMock = createGatewayRequestMock(async (method, params) => {
    queueMicrotask(wake);
    const input = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "cron.list": {
        const jobs = input.agentId === "sorter" ? sorterJobs : [];
        return {
          jobs,
          snapshotRevision: "rev",
          total: jobs.length,
          offset: 0,
          limit: 50,
          hasMore: false,
          nextOffset: null,
        };
      }
      case "cron.runs":
        return {
          entries: [
            {
              ts: 1,
              jobId: input.id,
              action: "finished",
              status: "ok",
              summary: "46 emails sorted",
            },
          ],
        };
      case "cron.run":
        return { ok: true, ran: true };
      case "cron.update":
        return { ok: true };
      case "config.get":
        return { config, sourceConfig: config, raw: JSON.stringify(config), hash: "base" };
      case "config.patch": {
        const patch = input as { raw: string; replacePaths?: string[] };
        patches.push({ raw: JSON.parse(patch.raw), replacePaths: patch.replacePaths });
        return { ok: true, config, hash: "next" };
      }
      case "sessions.subscribe":
        return { subscribed: true };
      case "sessions.list":
        return { ts: 1, path: "", count: 0, sessions: [], defaults: {} };
      default:
        throw new Error(`Unexpected request ${method}`);
    }
  });
  const client = createTestGatewayClient(request);
  const connection = createGatewayHarness(client);
  // The sidebar harness answers cron.list for its attention store; these cases own it.
  client.request = async <T>(...args: Parameters<typeof client.request>) =>
    (await request(...args)) as T;
  connection.publish({ hello: gatewayHelloForMethods(METHODS) });
  const sessions = createTestSessionCapability(connection.gateway);
  const runtimeConfig = createRuntimeConfigCapability(connection.gateway);
  const navigate = vi.fn<ApplicationContext["navigate"]>();
  const context = {
    ...createContext(connection.gateway, sessions, roster(options.extraClaws)),
    basePath: "",
    runtimeConfig,
    navigate,
  } as ApplicationContext;
  const provider = createApplicationContextProvider(context);
  const panel = document.createElement("openclaw-agent-details-panel") as HTMLElement & {
    agentId: string;
  };
  panel.agentId = agentId;
  provider.append(panel);
  document.body.append(provider);
  const observer = new MutationObserver(wake);
  observer.observe(provider, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
  onTestFinished(() => {
    observer.disconnect();
    document.body.replaceChildren();
    runtimeConfig.dispose();
    sessions.dispose();
    disposeSidebarContextLifecycles();
  });
  // Resolves on the DOM change or request that makes the condition true; no polling.
  const until = (condition: () => boolean) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (condition()) {
          waiters.delete(check);
          resolve();
        }
      };
      waiters.add(check);
      check();
    });
  return { panel, request, patches, navigate, until };
}

const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? "";
const claw = (panel: Element, id: string) => panel.querySelector(`[data-claw-id="${id}"]`);
const calls = (request: GatewayRequestMock, method: string) =>
  request.mock.calls.filter(([name]) => name === method).map(([, params]) => params);
function select(dropdown: Element | null | undefined, value: string) {
  const item = dropdown?.querySelector(`wa-dropdown-item[value="${value}"]`);
  dropdown?.dispatchEvent(new CustomEvent("wa-select", { detail: { item } }));
}

beforeEach(async () => {
  await i18n.setLocale("en");
});

describe("agent details Claws", () => {
  it("shows each Claw's latest result and plain schedules between Model and Routines", async () => {
    const { panel, request, until } = mount("forge");
    await until(() => text(claw(panel, "sorter")).includes("46 emails sorted"));
    await until(() => text(claw(panel, "brief")).includes("No schedule yet"));

    expect([...panel.querySelectorAll("section h3")].map((head) => head.id)).toEqual([
      "agent-details-model",
      "agent-details-claws",
      "agent-details-routines",
    ]);
    expect([...panel.querySelectorAll(".agent-details__claw strong")].map(text)).toEqual([
      "Inbox Sorter",
      "Morning Brief",
    ]);
    expect(text(claw(panel, "sorter")?.querySelector(".agent-details__claw-last"))).toMatch(
      / · 46 emails sorted$/,
    );
    expect(text(claw(panel, "brief")?.querySelector(".agent-details__claw-last"))).toBe(
      "Hasn't run yet",
    );
    const rows = [...(claw(panel, "sorter")?.querySelectorAll(".agent-details__schedule") ?? [])];
    expect(rows.map((row) => text(row.querySelector(".agent-details__schedule-text")))).toEqual([
      "Every 15 minutes",
      expect.stringMatching(/^Weekdays at 8:00\sAM$/),
    ]);
    expect(rows.map((row) => row.classList.contains("agent-details__schedule--off"))).toEqual([
      false,
      true,
    ]);
    expect(calls(request, "cron.runs")).toEqual([{ id: "sort-often", limit: 1, sortDir: "desc" }]);
  });

  it("switches or runs one schedule of a Claw", async () => {
    const { panel, request, until } = mount("forge");
    await until(() => panel.querySelectorAll(".agent-details__schedule wa-switch").length === 2);
    const [, weekdays] = panel.querySelectorAll<HTMLElement & { checked: boolean }>(
      "[data-claw-id='sorter'] wa-switch",
    );
    if (!weekdays) {
      throw new Error("Missing weekday switch");
    }
    weekdays.checked = true;
    weekdays.dispatchEvent(new Event("change"));
    await until(() => calls(request, "cron.update").length === 1);
    expect(calls(request, "cron.update")).toEqual([
      { id: "sort-weekdays", patch: { enabled: true } },
    ]);

    panel.querySelector<HTMLButtonElement>("[data-routine-id='sort-often'] button")?.click();
    await until(() => calls(request, "cron.run").length === 1);
    expect(calls(request, "cron.run")).toEqual([{ id: "sort-often", mode: "force" }]);
  });

  it("adds and removes a Claw through one config patch each", async () => {
    const { panel, patches, until } = mount("forge");
    await until(() => panel.querySelector("wa-dropdown-item[value='scout']") !== null);
    expect(
      [...panel.querySelectorAll(".agent-details__claw-add wa-dropdown-item")].map((item) =>
        item.getAttribute("value"),
      ),
    ).toEqual(["scout"]);

    select(panel.querySelector(".agent-details__claw-add"), "scout");
    await until(
      () => patches.length === 1 && !panel.querySelector(".agent-details__add[disabled]"),
    );
    expect(patches[0]).toEqual({
      raw: {
        agents: {
          entries: {
            forge: { subagents: { allowAgents: ["sorter", "brief", "scout"] } },
            scout: { kind: "claw" },
          },
        },
      },
      replacePaths: ["agents.entries.forge.subagents.allowAgents"],
    });

    select(claw(panel, "sorter")?.querySelector(".agent-details__claw-menu"), "remove");
    await until(() => patches.length === 2);
    expect(patches[1]).toEqual({
      raw: {
        agents: {
          entries: {
            forge: { subagents: { allowAgents: ["brief"] } },
            sorter: { kind: null },
          },
        },
      },
      replacePaths: ["agents.entries.forge.subagents.allowAgents"],
    });
  });

  it("keeps Remove off for a Bot that can start any agent", async () => {
    const { panel, patches, until } = mount("forge", { allowAgents: ["*"] });
    await until(() => claw(panel, "sorter") !== null);
    const menu = claw(panel, "sorter")?.querySelector(".agent-details__claw-menu");
    menu?.dispatchEvent(new CustomEvent("wa-show"));
    const remove = () => menu?.querySelector("wa-dropdown-item[value='remove']");
    await until(() => remove()?.hasAttribute("disabled") === true);
    expect(remove()?.getAttribute("title")).toContain("can start any agent");
    // A selection that still gets through is refused with the same reason, without a write.
    select(menu, "remove");
    const notice = () => panel.querySelector("[aria-labelledby='agent-details-claws'] > .callout");
    await until(() => text(notice()).includes("can start any agent"));
    expect(patches).toEqual([]);
  });

  it("caps the list at twelve Claws and links to the rest", async () => {
    const { panel, navigate, until } = mount("forge", { extraClaws: 12 });
    await until(() => panel.querySelector(".agent-details__claws + a") !== null);
    expect(panel.querySelectorAll(".agent-details__claw")).toHaveLength(12);
    const more = panel.querySelector<HTMLAnchorElement>(".agent-details__claws + a");
    expect(text(more)).toBe("2 more Claws");
    more?.click();
    expect(navigate).toHaveBeenCalledWith("agents", { pathname: "/settings/agents" });
  });

  it("names a Claw's Bots on its own panel instead of listing Claws", async () => {
    const { panel, until } = mount("sorter");
    await until(() => panel.querySelector(".agent-details__works-for") !== null);
    expect(text(panel.querySelector(".agent-details__works-for"))).toBe("Works for Forge");
    expect(panel.querySelector("openclaw-agent-details-claws")).toBeNull();
  });
});
