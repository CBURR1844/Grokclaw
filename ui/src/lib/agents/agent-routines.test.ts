/* @vitest-environment jsdom */
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { CronCompactJob, CronJobsListResult, CronRunsResult } from "../../api/types.ts";
import { disposeSidebarContextLifecycles } from "../../test-helpers/app-sidebar-context-lifecycle.ts";
import { createContext, createGatewayHarness } from "../../test-helpers/app-sidebar.ts";
import {
  createGatewayRequestMock,
  type GatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createTestSessionCapability } from "../sessions/session-capability.test-support.ts";
import { AgentRoutines } from "./agent-routines.ts";

function job(id: string, agentId = "main", extra: Partial<CronCompactJob> = {}): CronCompactJob {
  return {
    id,
    name: id,
    agentId,
    enabled: true,
    updatedAtMs: 1,
    nextRunAt: null,
    nextRunAtMs: null,
    scheduleKind: "every",
    schedule: { kind: "every", everyMs: 60_000 },
    lastRunAt: null,
    lastRunAtMs: null,
    lastRunStatus: null,
    ...extra,
  } as CronCompactJob;
}

function runs(summary: string, ts = 1): CronRunsResult {
  return { entries: [{ ts, jobId: "brief", action: "finished", status: "ok", summary }] };
}

function page(jobs: CronCompactJob[]): CronJobsListResult<CronCompactJob> {
  return {
    jobs,
    snapshotRevision: "rev",
    total: jobs.length,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  } as CronJobsListResult<CronCompactJob>;
}

function fixture(
  read: (method: string, params: Record<string, unknown>) => unknown,
  scopes: string[] = ["operator.admin"],
  options: { latestRun?: boolean } = {},
) {
  const request = createGatewayRequestMock((method, params) =>
    read(method, (params ?? {}) as Record<string, unknown>),
  );
  const client = createTestGatewayClient(request);
  const connection = createGatewayHarness(client);
  // The sidebar harness answers cron.list for its attention store; these cases own it.
  client.request = async <T>(...args: Parameters<typeof client.request>) =>
    (await request(...args)) as T;
  connection.publish({
    hello: gatewayHelloForMethods(["cron.list", "cron.run", "cron.runs", "cron.update"], scopes),
  });
  const sessions = createTestSessionCapability(connection.gateway);
  const waiters = new Set<() => void>();
  const changed = vi.fn(() => waiters.forEach((wake) => wake()));
  const routines = new AgentRoutines(createContext(connection.gateway, sessions), changed, options);
  // Resolves on the change that makes the condition true; no polling.
  const until = (condition: () => boolean) =>
    new Promise<void>((resolve) => {
      const wake = () => {
        if (condition()) {
          waiters.delete(wake);
          resolve();
        }
      };
      waiters.add(wake);
      wake();
    });
  onTestFinished(() => {
    routines.dispose();
    sessions.dispose();
    disposeSidebarContextLifecycles();
  });
  return { routines, request, connection, changed, until };
}

const calls = (request: GatewayRequestMock, name: string) =>
  request.mock.calls.filter(([method]) => method === name);
const listCalls = (request: GatewayRequestMock) => calls(request, "cron.list");

describe("agent routines", () => {
  it("reads the presented agent's compact inventory and nothing while hidden", async () => {
    const f = fixture(() => page([job("brief")]));
    f.routines.sync({ agentId: "main", presented: false });
    expect(listCalls(f.request)).toHaveLength(0);

    f.routines.sync({ agentId: "main", presented: true });
    await f.routines.refresh();
    expect(listCalls(f.request)[0]?.[1]).toMatchObject({
      agentId: "main",
      compact: true,
      sortBy: "name",
    });
    expect(f.routines.jobs.map((entry) => entry.id)).toEqual(["brief"]);
  });

  it("drops a late inventory from the previous agent", async () => {
    const old = createDeferred<CronJobsListResult<CronCompactJob>>();
    let reads = 0;
    const f = fixture(() => (++reads === 1 ? old.promise : page([job("triage", "forge")])));
    f.routines.sync({ agentId: "main", presented: true });
    f.routines.sync({ agentId: "forge", presented: true });
    await f.routines.refresh();
    old.resolve(page([job("brief")]));
    await old.promise;
    expect(f.routines.jobs.map((entry) => entry.id)).toEqual(["triage"]);
  });

  it("refreshes on cron events while presented", async () => {
    const f = fixture(() => page([job("brief")]));
    f.routines.sync({ agentId: "main", presented: true });
    await vi.waitFor(() => expect(f.routines.jobs).toHaveLength(1));
    const reads = listCalls(f.request).length;
    f.connection.publishEvent("cron", {});
    await vi.waitFor(() => expect(listCalls(f.request)).toHaveLength(reads + 1));

    f.routines.sync({ agentId: "main", presented: false });
    f.connection.publishEvent("cron", {});
    expect(listCalls(f.request)).toHaveLength(reads + 1);
  });

  it("starts a routine now and reports a start the Gateway declined", async () => {
    let declined = false;
    const f = fixture((method) =>
      method === "cron.run"
        ? declined
          ? { ok: true, ran: false, reason: "already-running" }
          : { ok: true, ran: true }
        : page([job("brief")]),
    );
    f.routines.sync({ agentId: "main", presented: true });
    await f.routines.refresh();

    await f.routines.run("brief");
    expect(f.request).toHaveBeenCalledWith("cron.run", { id: "brief", mode: "force" });
    expect(f.routines.feedback).toBeNull();

    declined = true;
    await f.routines.run("brief");
    await f.routines.refresh();
    expect(f.routines.feedback).toBeTruthy();
    expect(f.routines.error).toBeNull();
    expect(f.routines.starting.size).toBe(0);
  });

  it("does not start or switch routines without admin access", async () => {
    const f = fixture(() => page([job("brief")]), ["operator.read"]);
    f.routines.sync({ agentId: "main", presented: true });
    await f.routines.refresh();
    expect(f.routines.canRun).toBe(false);
    expect(f.routines.canToggle).toBe(false);
    await f.routines.run("brief");
    await f.routines.setEnabled("brief", false);
    expect(calls(f.request, "cron.run")).toHaveLength(0);
    expect(calls(f.request, "cron.update")).toHaveLength(0);
  });

  it("refreshes for its own agent's routines and job-less events, not another agent's", async () => {
    const f = fixture(() => page([job("triage", "sorter")]));
    f.routines.sync({ agentId: "sorter", presented: true });
    await f.until(() => f.routines.jobs.length === 1 && !f.routines.loading);
    const reads = listCalls(f.request).length;

    f.connection.publishEvent("cron", { jobId: "other", job: { id: "other", agentId: "forge" } });
    expect(listCalls(f.request)).toHaveLength(reads);

    // A held routine moved to another agent still concerns this view.
    f.connection.publishEvent("cron", { jobId: "triage", job: { id: "triage", agentId: "forge" } });
    expect(listCalls(f.request)).toHaveLength(reads + 1);
    await f.until(() => !f.routines.loading);

    f.connection.publishEvent("cron", { jobId: "new", job: { id: "new", agentId: "Sorter" } });
    expect(listCalls(f.request)).toHaveLength(reads + 2);
    await f.until(() => !f.routines.loading);

    f.connection.publishEvent("cron", { jobId: "gone", action: "removed" });
    expect(listCalls(f.request)).toHaveLength(reads + 3);
    await f.until(() => !f.routines.loading);

    // Without its own agent, the Gateway files a job under its session's agent or the default.
    f.connection.publishEvent("cron", {
      jobId: "added",
      action: "added",
      job: { id: "added", sessionKey: "agent:sorter:main" },
    });
    expect(listCalls(f.request)).toHaveLength(reads + 4);
  });

  it("switches one routine without a revision and locks it until the Gateway answers", async () => {
    const update = createDeferred<unknown>();
    const f = fixture((method) =>
      method === "cron.update" ? update.promise : page([job("triage", "sorter")]),
    );
    f.routines.sync({ agentId: "sorter", presented: true });
    await f.until(() => f.routines.jobs.length === 1 && !f.routines.loading);
    expect(f.routines.canToggle).toBe(true);

    const switching = f.routines.setEnabled("triage", false);
    await f.routines.setEnabled("triage", true);
    expect(f.routines.toggling.has("triage")).toBe(true);
    expect(calls(f.request, "cron.update")).toEqual([
      ["cron.update", { id: "triage", patch: { enabled: false } }],
    ]);
    const reads = listCalls(f.request).length;
    update.reject(new Error("Gateway rejected the change"));
    await switching;
    expect(f.routines.toggling.size).toBe(0);
    expect(f.routines.feedback).toContain("Gateway rejected the change");
    expect(listCalls(f.request)).toHaveLength(reads + 1);
  });

  it("reads the newest run's summary once per finished run", async () => {
    let lastRunAtMs = 1_000;
    const f = fixture(
      (method) =>
        method === "cron.runs"
          ? runs(lastRunAtMs === 1_000 ? "46 emails sorted" : "12 emails sorted", lastRunAtMs)
          : page([
              job("triage", "sorter", { lastRunAtMs: 500, lastRunStatus: "error" }),
              job("brief", "sorter", { lastRunAtMs, lastRunStatus: "ok" }),
            ]),
      ["operator.admin"],
      { latestRun: true },
    );
    f.routines.sync({ agentId: "sorter", presented: true });
    await f.until(() => f.routines.latestRun?.summary !== undefined);
    expect(f.routines.latestRun).toEqual({
      jobId: "brief",
      atMs: 1_000,
      status: "ok",
      summary: "46 emails sorted",
    });
    expect(calls(f.request, "cron.runs")).toEqual([
      ["cron.runs", { id: "brief", limit: 1, sortDir: "desc" }],
    ]);

    f.connection.publishEvent("cron", {});
    await f.until(() => !f.routines.loading);
    expect(calls(f.request, "cron.runs")).toHaveLength(1);

    lastRunAtMs = 2_000;
    f.connection.publishEvent("cron", {});
    await f.until(() => f.routines.latestRun?.summary === "12 emails sorted");
    expect(f.routines.latestRun?.atMs).toBe(2_000);
    expect(calls(f.request, "cron.runs")).toHaveLength(2);
  });

  it("drops a late run summary from the previous agent", async () => {
    const late = createDeferred<CronRunsResult>();
    const f = fixture(
      (method, params) =>
        method === "cron.runs"
          ? params.id === "triage"
            ? late.promise
            : runs("Brief sent")
          : page(
              params.agentId === "sorter"
                ? [job("triage", "sorter", { lastRunAtMs: 1, lastRunStatus: "ok" })]
                : [job("brief", "digest", { lastRunAtMs: 2, lastRunStatus: "ok" })],
            ),
      ["operator.admin"],
      { latestRun: true },
    );
    f.routines.sync({ agentId: "sorter", presented: true });
    await f.until(() => calls(f.request, "cron.runs").length === 1);
    f.routines.sync({ agentId: "digest", presented: true });
    await f.until(() => f.routines.latestRun?.summary === "Brief sent");

    late.resolve(runs("46 emails sorted"));
    // This later read keeps the cached run, so only a stale write could change it.
    f.connection.publishEvent("cron", {});
    await f.until(() => !f.routines.loading);
    expect(f.routines.latestRun).toEqual({
      jobId: "brief",
      atMs: 2,
      status: "ok",
      summary: "Brief sent",
    });
  });
});
