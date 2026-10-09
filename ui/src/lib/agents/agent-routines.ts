import type { CronCompactJob, CronRunResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createInitialCronState } from "../cron/index.ts";
import { loadCompactCronJobsPage } from "../cron/jobs.ts";
import { cronRunNotStartedMessage } from "../cron/run-feedback.ts";
import { formatUiError } from "../format-error.ts";
import { canCallGatewayMethod } from "../gateway-methods.ts";
import type { SessionConnectionScope } from "../sessions/session-capability.ts";

export type AgentRoutinesInput = { agentId: string; presented: boolean };

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
  /** Why the last Run now did not start, until the next one. */
  runFeedback: string | null = null;
  readonly starting = new Set<string>();
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
  ) {
    this.unsubscribe = context.gateway.subscribe(() => this.reconcile());
    this.unsubscribeEvents = context.gateway.subscribeEvents((event) => {
      if (event.event === "cron" && this.scope) {
        void this.refresh();
      }
    });
  }

  /** Whether this operator may start a routine now. */
  get canRun(): boolean {
    return canCallGatewayMethod(this.context.gateway.snapshot, "cron.run", "operator.admin");
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
    this.runFeedback = null;
    this.changed();
    try {
      const result = await scope.client.request<CronRunResult>("cron.run", {
        id: jobId,
        mode: "force",
      });
      if (this.current(generation) && (!result.ok || ("ran" in result && !result.ran))) {
        this.runFeedback = cronRunNotStartedMessage(result);
      }
    } catch (error) {
      if (this.current(generation)) {
        this.runFeedback = formatUiError(error);
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

  dispose(): void {
    this.disposed = true;
    this.retire();
    this.unsubscribe();
    this.unsubscribeEvents();
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
    this.runFeedback = null;
    this.starting.clear();
  }
}
