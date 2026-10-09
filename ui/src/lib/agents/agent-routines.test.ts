/* @vitest-environment jsdom */
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { CronCompactJob, CronJobsListResult } from "../../api/types.ts";
import { disposeSidebarContextLifecycles } from "../../test-helpers/app-sidebar-context-lifecycle.ts";
import { createContext, createGatewayHarness } from "../../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createTestSessionCapability } from "../sessions/session-capability.test-support.ts";
import { AgentRoutines } from "./agent-routines.ts";

function job(id: string, agentId = "main"): CronCompactJob {
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
  } as CronCompactJob;
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
) {
  const request = vi.fn(read);
  const client = createTestGatewayClient(request);
  const connection = createGatewayHarness(client);
  // The sidebar harness answers cron.list for its attention store; these cases own it.
  client.request = async <T>(...args: Parameters<typeof client.request>) =>
    (await request(...(args as [string, Record<string, unknown>]))) as T;
  connection.publish({ hello: gatewayHelloForMethods(["cron.list", "cron.run"], scopes) });
  const sessions = createTestSessionCapability(connection.gateway);
  const changed = vi.fn();
  const routines = new AgentRoutines(createContext(connection.gateway, sessions), changed);
  onTestFinished(() => {
    routines.dispose();
    sessions.dispose();
    disposeSidebarContextLifecycles();
  });
  return { routines, request, connection, changed };
}

const listCalls = (request: ReturnType<typeof vi.fn>) =>
  request.mock.calls.filter(([method]) => method === "cron.list");

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
    expect(f.routines.runFeedback).toBeNull();

    declined = true;
    await f.routines.run("brief");
    await f.routines.refresh();
    expect(f.routines.runFeedback).toBeTruthy();
    expect(f.routines.error).toBeNull();
    expect(f.routines.starting.size).toBe(0);
  });

  it("does not start routines without admin access", async () => {
    const f = fixture(() => page([job("brief")]), ["operator.read"]);
    f.routines.sync({ agentId: "main", presented: true });
    await f.routines.refresh();
    expect(f.routines.canRun).toBe(false);
    await f.routines.run("brief");
    expect(f.request.mock.calls.some(([method]) => method === "cron.run")).toBe(false);
  });
});
