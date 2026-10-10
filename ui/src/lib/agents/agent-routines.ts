import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { CronCompactJob, CronRunResult, CronRunsResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createInitialCronState } from "../cron/index.ts";
import { loadCompactCronJobsPage } from "../cron/jobs.ts";
import { cronRunNotStartedMessage } from "../cron/run-feedback.ts";
import { formatUiError } from "../format-error.ts";
import { canCallGatewayMethod } from "../gateway-methods.ts";
import type { SessionConnectionScope } from "../sessions/session-capability.ts";

export type AgentRoutinesInput = { agentId: string; presented: boolean };

/** The newest finished run across one agent's routines. */
export type AgentLatestRun = {
  jobId: string;
  atMs: number;
  status: CronCompactJob["lastRunStatus"];
  /** The run's own summary, once `cron.runs` has answered. */
  summary?: string;
};

/**
 * One agent's scheduled routines while a view presents them. Reads follow the
 * live connection and the Gateway's cron events; a result from an earlier
 * agent, connection or presentation never reaches the current view.
 */
export class AgentRoutines {
  jobs: readonly CronCompactJob[] = [];
  total = 0;
  loading = false;
  error: string | null = null;
  /** Why the last Run now or switch did not take effect, until the next one. */
  feedback: string | null = null;
  readonly starting = new Set<string>();
  /** Routines whose switch waits for the Gateway, with the position asked for. */
  readonly toggling = new Map<string, boolean>();
  /** Read only for owners constructed with `latestRun: true`. */
  latestRun: AgentLatestRun | null = null;
  private latestRunKey: string | null = null;
  private input: AgentRoutinesInput | null = null;
  private scope: SessionConnectionScope | null = null;
  private generation = 0;
  private disposed = false;
  private pending: Promise<void> | null = null;
  private stale = false;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeEvents: () => void;

  constructor(
    private readonly context: ApplicationContext,
    private readonly changed: () => void,
    private readonly options: { latestRun?: boolean } = {},
  ) {
    this.unsubscribe = context.gateway.subscribe(() => this.reconcile());
    this.unsubscribeEvents = context.gateway.subscribeEvents((event) => {
      if (event.event === "cron" && this.scope && this.concerns(event.payload)) {
        void this.refresh();
      }
    });
  }

  /** Whether this operator may start a routine now. */
  get canRun(): boolean {
    return canCallGatewayMethod(this.context.gateway.snapshot, "cron.run", "operator.admin");
  }

  /** Whether this operator may turn a routine on or off. */
  get canToggle(): boolean {
    return canCallGatewayMethod(this.context.gateway.snapshot, "cron.update", "operator.admin");
  }

  /** A routine runs now, or a Run now from this view still waits to start. */
  isRunning(job: CronCompactJob): boolean {
    return job.runningAtMs !== undefined || this.starting.has(job.id);
  }

  /** A routine's switch position: the one asked for until the Gateway settles it. */
  isEnabled(job: CronCompactJob): boolean {
    return this.toggling.get(job.id) ?? job.enabled;
  }

  sync(input: AgentRoutinesInput): void {
    if (input.agentId !== this.input?.agentId) {
      this.retire();
    }
    this.input = input;
    this.reconcile();
  }

  /** Reads the first page again; overlapping calls share one trailing read. */
  refresh(): Promise<void> {
    if (this.pending) {
      this.stale = true;
      return this.pending;
    }
    const scope = this.scope;
    const agentId = this.input?.agentId;
    if (!scope || !agentId || !this.current(this.generation)) {
      return Promise.resolve();
    }
    const generation = this.generation;
    this.stale = false;
    this.loading = true;
    this.changed();
    const cron = createInitialCronState<CronCompactJob>({ client: scope.client, connected: true });
    cron.cronAgentId = agentId;
    cron.cronJobsSortBy = "name";
    cron.canRefresh = () => this.current(generation);
    const pending = loadCompactCronJobsPage(cron).finally(() => {
      if (this.pending === pending) {
        this.pending = null;
      }
      if (!this.current(generation)) {
        return;
      }
      this.loading = false;
      this.error = cron.cronJobsError;
      if (!cron.cronJobsError) {
        this.jobs = cron.cronJobs;
        this.total = cron.cronJobsTotal;
        if (this.options.latestRun) {
          this.readLatestRun(scope, generation);
        }
      }
      this.changed();
      if (this.stale) {
        void this.refresh();
      }
    });
    this.pending = pending;
    return pending;
  }

  async run(jobId: string): Promise<void> {
    const scope = this.scope;
    const generation = this.generation;
    if (!scope || !this.current(generation) || !this.canRun || this.starting.has(jobId)) {
      return;
    }
    this.starting.add(jobId);
    this.feedback = null;
    this.changed();
    try {
      const result = await scope.client.request<CronRunResult>("cron.run", {
        id: jobId,
        mode: "force",
      });
      if (this.current(generation) && (!result.ok || ("ran" in result && !result.ran))) {
        this.feedback = cronRunNotStartedMessage(result);
      }
    } catch (error) {
      if (this.current(generation)) {
        this.feedback = formatUiError(error);
      }
    } finally {
      if (this.current(generation)) {
        this.starting.delete(jobId);
        this.changed();
        // The cron event that follows a start refreshes the list; this read covers
        // a start the Gateway declined without publishing one.
        void this.refresh();
      }
    }
  }

  /** Turns one routine on or off; the list read that follows is authoritative. */
  async setEnabled(jobId: string, enabled: boolean): Promise<void> {
    const scope = this.scope;
    const generation = this.generation;
    if (!scope || !this.current(generation) || !this.canToggle || this.toggling.has(jobId)) {
      return;
    }
    this.toggling.set(jobId, enabled);
    this.feedback = null;
    this.changed();
    try {
      // One field, last write wins: no configuration revision, so no extra cron.get.
      await scope.client.request("cron.update", { id: jobId, patch: { enabled } });
      if (this.current(generation)) {
        // The switch stays where it was put while the read below catches up.
        this.jobs = this.jobs.map((job) =>
          job.id === jobId ? Object.assign({}, job, { enabled }) : job,
        );
      }
    } catch (error) {
      if (this.current(generation)) {
        this.feedback = formatUiError(error);
      }
    } finally {
      if (this.current(generation)) {
        this.toggling.delete(jobId);
        this.changed();
        void this.refresh();
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.retire();
    this.unsubscribe();
    this.unsubscribeEvents();
  }

  /**
   * Events about another agent's routines are not this view's. A job-less event may be,
   * and so may a job without its own agent: the Gateway files it under its session's
   * agent or the default agent.
   */
  private concerns(payload: unknown): boolean {
    const job = isRecord(payload) && isRecord(payload.job) ? payload.job : null;
    const jobAgentId = job?.agentId;
    const owner = typeof jobAgentId === "string" ? jobAgentId.trim() : "";
    const agentId = this.input?.agentId;
    if (!owner || !agentId) {
      return true;
    }
    const jobId = isRecord(payload) ? payload.jobId : undefined;
    return (
      normalizeAgentId(owner) === normalizeAgentId(agentId) ||
      this.jobs.some((held) => held.id === jobId)
    );
  }

  /** One `cron.runs` read per finished run: the cache key is the job and its run time. */
  private readLatestRun(scope: SessionConnectionScope, generation: number): void {
    const newest = this.jobs.reduce<CronCompactJob | undefined>(
      (best, job) => ((job.lastRunAtMs ?? 0) > (best?.lastRunAtMs ?? 0) ? job : best),
      undefined,
    );
    if (!newest?.lastRunAtMs) {
      this.latestRun = null;
      this.latestRunKey = null;
      return;
    }
    const key = `${newest.id}:${newest.lastRunAtMs}`;
    if (key === this.latestRunKey) {
      return;
    }
    const base: AgentLatestRun = {
      jobId: newest.id,
      atMs: newest.lastRunAtMs,
      status: newest.lastRunStatus,
    };
    this.latestRunKey = key;
    this.latestRun = base;
    void scope.client
      .request<CronRunsResult>("cron.runs", { id: newest.id, limit: 1, sortDir: "desc" })
      .then(
        (result) => {
          const summary = result.entries?.[0]?.summary?.trim();
          if (summary && this.current(generation) && this.latestRunKey === key) {
            this.latestRun = { ...base, summary };
            this.changed();
          }
        },
        // The list's time and status stay; the next finished run reads again.
        () => undefined,
      );
  }

  private reconcile(): void {
    if (this.disposed) {
      return;
    }
    const scope = this.input?.presented ? this.context.sessions.captureConnectionScope() : null;
    if (!scope || !this.input?.agentId) {
      if (this.scope) {
        this.retire();
        this.changed();
      }
      return;
    }
    if (this.scope && !this.context.sessions.isConnectionScopeCurrent(this.scope)) {
      this.retire();
    }
    if (!this.scope) {
      this.scope = scope;
      void this.refresh();
    }
  }

  private current(generation: number): boolean {
    return (
      !this.disposed &&
      generation === this.generation &&
      Boolean(this.scope && this.context.sessions.isConnectionScopeCurrent(this.scope))
    );
  }

  private retire(): void {
    this.generation += 1;
    this.scope = null;
    this.pending = null;
    this.stale = false;
    this.jobs = [];
    this.total = 0;
    this.loading = false;
    this.error = null;
    this.feedback = null;
    this.latestRun = null;
    this.latestRunKey = null;
    this.starting.clear();
    this.toggling.clear();
  }
}
