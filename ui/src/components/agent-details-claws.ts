import "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { AgentsListResult, CronCompactJob } from "../api/types.ts";
import { pathForAgentPanel, pathForRoute } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { registerAgentDetailsClawsEnglish } from "../i18n/locales/en-agent-details-claws.ts";
import { AgentRoutines } from "../lib/agents/agent-routines.ts";
import {
  attachClaw,
  clawCandidates,
  clawRemovalBlocked,
  detachClaw,
  type ClawMembershipResult,
} from "../lib/agents/claw-membership.ts";
import { clawsOf } from "../lib/agents/display.ts";
import type { AgentsPanel } from "../lib/agents/panels.ts";
import { AgentRosterElement } from "../lib/agents/roster-element.ts";
import { resolveEditableSnapshotConfig } from "../lib/config/config-state-model.ts";
import { describeCronSchedule } from "../lib/cron/schedule-phrase.ts";
import { formatRelativeTimestamp, formatTimeMs } from "../lib/format.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { icons } from "./icons.ts";
import { renderAgentIdentityAvatar } from "./identity-avatar-view.ts";
import { renderSettingsToggle } from "./settings-ui.ts";

registerAgentDetailsClawsEnglish();

/** Each shown Claw reads its own schedules, so the section stays bounded. */
const MAX_CLAWS = 12;

const CLAW_LINKS = [
  ["skills", "agentDetails.skills", icons.zap],
  ["tools", "agentDetails.tools", icons.wrench],
  ["files", "agentDetails.instructions", icons.fileText],
] as const satisfies ReadonlyArray<readonly [AgentsPanel, string, unknown]>;

type SelectEvent = Event & { detail: { item: Element } };
type ClawCard = Parameters<typeof renderAgentIdentityAvatar>[0] &
  Pick<AgentsListResult["agents"][number], "claw"> & { name: string };

function isToday(ms: number) {
  return new Date(ms).toDateString() === new Date().toDateString();
}

/**
 * A Bot's Claws in its details panel: who they are, when each last ran and
 * what it did, one switch and Run per schedule, and linking Claws in or out.
 * Membership comes from the Gateway's `agents.list` projection; every change
 * goes through the runtime config, so the list here never decides it.
 */
class AgentDetailsClaws extends AgentRosterElement {
  @property({ attribute: false }) botId = "";
  @property({ type: Boolean }) presented = true;
  @state() private pending: string | null = null;
  @state() private notice: string | null = null;
  private readonly routines = new Map<string, AgentRoutines>();
  private routinesContext: ApplicationContext | null = null;

  constructor() {
    super();
    // Removal availability reads the loaded configuration.
    new SubscriptionsController(this).watchStore(() =>
      this.active && this.context ? this.context.runtimeConfig : undefined,
    );
  }

  override disconnectedCallback(): void {
    this.disposeRoutines();
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (this.routinesContext !== this.context) {
      this.disposeRoutines();
      this.routinesContext = this.context ?? null;
      this.notice = null;
    } else if (changed.has("botId")) {
      this.notice = null;
    }
    const context = this.context;
    const shown = context ? clawsOf(this.roster.cards, this.botId).slice(0, MAX_CLAWS) : [];
    const ids = new Set(shown.map((claw) => claw.id));
    for (const [id, routines] of this.routines) {
      if (!ids.has(id)) {
        routines.dispose();
        this.routines.delete(id);
      }
    }
    for (const claw of shown) {
      let routines = this.routines.get(claw.id);
      if (!routines) {
        routines = new AgentRoutines(context, () => this.requestUpdate(), { latestRun: true });
        this.routines.set(claw.id, routines);
      }
      routines.sync({ agentId: claw.id, presented: this.presented && this.active });
    }
  }

  private disposeRoutines() {
    for (const routines of this.routines.values()) {
      routines.dispose();
    }
    this.routines.clear();
  }

  private navigate(routeId: "agents", pathname: string, event?: MouseEvent) {
    if (!event || shouldHandleNavigationClick(event)) {
      event?.preventDefault();
      this.context.navigate(routeId, { pathname });
    }
  }

  private async change(clawId: string, run: () => Promise<ClawMembershipResult>) {
    if (this.pending) {
      return;
    }
    const { context, botId } = this;
    this.pending = clawId;
    this.notice = null;
    try {
      const result = await run();
      if (!result.ok && this.context === context && this.botId === botId) {
        this.notice = result.error;
      }
    } finally {
      this.pending = null;
    }
  }

  private lastRunLine(routines: AgentRoutines | undefined) {
    if (!routines) {
      return nothing;
    }
    if (routines.jobs.some((job) => routines.isRunning(job))) {
      return t("agentDetails.routineRunning");
    }
    const latest = routines.latestRun;
    if (!latest) {
      // A failed read says nothing about the history; the error callout explains it.
      return routines.loading || routines.error ? nothing : t("agentDetails.claws.neverRun");
    }
    const time = isToday(latest.atMs)
      ? formatTimeMs(latest.atMs)
      : formatRelativeTimestamp(latest.atMs);
    const summary =
      latest.summary ??
      (latest.status ? t(`agentDetails.claws.lastRunStatus.${latest.status}`) : null);
    return summary ? t("agentDetails.claws.lastRun", { time, summary }) : time;
  }

  private renderSchedule(job: CronCompactJob, routines: AgentRoutines) {
    const name = job.displayName ?? job.name;
    const schedule = job.schedule ? describeCronSchedule(job.schedule, job.nextRunAtMs) : name;
    const running = routines.isRunning(job);
    return html`<li
      class="agent-details__schedule ${routines.isEnabled(job) ? "" : "agent-details__schedule--off"}"
      data-routine-id=${job.id}
      title=${name}
    >
      <span class="agent-details__schedule-text">${schedule}</span>
      ${
        routines.canToggle
          ? renderSettingsToggle({
              checked: routines.isEnabled(job),
              disabled: routines.toggling.has(job.id),
              ariaLabel: t("agentDetails.claws.scheduleSwitch", { name, schedule }),
              onChange: (enabled) => void routines.setEnabled(job.id, enabled),
            })
          : nothing
      }
      ${
        routines.canRun
          ? html`<button
              type="button"
              class="btn btn--sm agent-details__run"
              ?disabled=${running}
              aria-label=${t("agentDetails.runNowNamed", { name })}
              @click=${() => void routines.run(job.id)}
            >
              ${icons.play}<span>${t("agentDetails.runNow")}</span>
            </button>`
          : nothing
      }
    </li>`;
  }

  private renderMenu(claw: ClawCard, botName: string, canChange: boolean) {
    const config = resolveEditableSnapshotConfig(this.context.runtimeConfig.state.configSnapshot);
    const blocked = canChange && clawRemovalBlocked(config, this.botId);
    return html`<wa-dropdown
      class="agent-details__claw-menu"
      placement="bottom-end"
      @wa-show=${() => {
        if (canChange) {
          void this.context.runtimeConfig.ensureLoaded();
        }
      }}
      @wa-select=${(event: SelectEvent) => {
        const value = event.detail.item.getAttribute("value");
        const panel = CLAW_LINKS.find(([candidate]) => candidate === value)?.[0];
        if (value === "remove") {
          void this.change(claw.id, () => detachClaw(this.context.runtimeConfig, this.botId, claw));
        } else if (panel) {
          this.navigate("agents", pathForAgentPanel(claw.id, panel, this.context.basePath));
        }
      }}
    >
      <button
        slot="trigger"
        type="button"
        class="btn btn--sm btn--icon agent-details__claw-more"
        aria-label=${t("agentDetails.claws.options", { name: claw.name })}
      >
        ${icons.moreHorizontal}
      </button>
      ${CLAW_LINKS.map(
        ([panel, label, icon]) =>
          html`<wa-dropdown-item value=${panel}
            ><span slot="icon" class="agent-details__menu-icon" aria-hidden="true">${icon}</span
            >${t(label)}</wa-dropdown-item
          >`,
      )}
      ${
        canChange
          ? html`<div class="agent-details__menu-separator" role="separator"></div>
              <wa-dropdown-item
                value="remove"
                ?disabled=${blocked || this.pending !== null}
                title=${blocked ? t("agentDetails.claws.removeBlocked") : nothing}
                ><span slot="icon" class="agent-details__menu-icon" aria-hidden="true"
                  >${icons.x}</span
                >${t("agentDetails.claws.remove", { bot: botName })}</wa-dropdown-item
              >`
          : nothing
      }
    </wa-dropdown>`;
  }

  private renderClaw(claw: ClawCard, botName: string, canChange: boolean) {
    const routines = this.routines.get(claw.id);
    const jobs = routines?.jobs ?? [];
    return html`<li class="agent-details__claw" data-claw-id=${claw.id}>
      <div class="agent-details__claw-head">
        <span class="agent-details__claw-avatar" aria-hidden="true"
          >${renderAgentIdentityAvatar(claw)}</span
        >
        <span class="agent-details__claw-copy">
          <strong>${claw.name}</strong>
          <span class="agent-details__claw-last">${this.lastRunLine(routines)}</span>
        </span>
        ${this.renderMenu(claw, botName, canChange)}
      </div>
      ${
        routines?.error
          ? html`<div class="callout danger agent-details__error" role="alert">
              <span>${routines.error}</span>
              <button class="btn btn--sm" @click=${() => void routines.refresh()}>
                ${t("common.retry")}
              </button>
            </div>`
          : nothing
      }
      ${
        routines?.feedback
          ? html`<div class="callout warn agent-details__error" role="status">
              ${routines.feedback}
            </div>`
          : nothing
      }
      ${
        !routines || (routines.loading && jobs.length === 0)
          ? html`<span
              role="status"
              aria-label=${t("common.loading")}
              class="skeleton skeleton-line"
            ></span>`
          : jobs.length === 0
            ? routines.error
              ? nothing
              : html`<p class="agent-details__claw-none">${t("agentDetails.claws.noSchedule")}</p>`
            : html`<ul class="agent-details__schedules">
                ${repeat(
                  jobs,
                  (job) => job.id,
                  (job) => this.renderSchedule(job, routines),
                )}
              </ul>`
      }
    </li>`;
  }

  private renderAdd(cards: readonly ClawCard[]) {
    const list = this.context.agents.state.agentsList;
    const candidates = list ? clawCandidates(list, this.botId) : [];
    if (candidates.length === 0) {
      return nothing;
    }
    return html`<wa-dropdown
      class="agent-details__claw-add"
      placement="bottom-end"
      @wa-select=${(event: SelectEvent) => {
        const clawId = event.detail.item.getAttribute("value");
        if (clawId) {
          void this.change(clawId, () =>
            attachClaw(this.context.runtimeConfig, this.botId, clawId),
          );
        }
      }}
    >
      <button
        slot="trigger"
        type="button"
        class="btn btn--sm agent-details__add"
        ?disabled=${this.pending !== null}
      >
        ${icons.plus}<span>${t("agentDetails.claws.add")}</span>
      </button>
      ${candidates.map((candidate) => {
        const card = cards.find((entry) => entry.id === candidate.id);
        const name = card?.name ?? candidate.name ?? candidate.id;
        return html`<wa-dropdown-item
          value=${candidate.id}
          aria-label=${t("agentDetails.claws.addNamed", { name })}
          ><span slot="icon" class="agent-details__claw-avatar" aria-hidden="true"
            >${renderAgentIdentityAvatar(card ?? { id: candidate.id, name })}</span
          >${name}</wa-dropdown-item
        >`;
      })}
    </wa-dropdown>`;
  }

  override render() {
    if (!this.context || !this.botId) {
      return nothing;
    }
    return this.avatars.withActiveRoutes(() => {
      const cards = this.cards();
      const claws = clawsOf(cards, this.botId);
      const shown = claws.slice(0, MAX_CLAWS);
      const botName = cards.find((card) => card.id === this.botId)?.name ?? this.botId;
      const canChange = this.context.runtimeConfig.canPatch === true;
      const agentsPath = pathForRoute("agents", this.context.basePath);
      return html`<section class="agent-details__section" aria-labelledby="agent-details-claws">
        <header class="agent-details__section-head">
          <h3 id="agent-details-claws">${t("agentDetails.claws.title")}</h3>
          ${canChange ? this.renderAdd(cards) : nothing}
        </header>
        ${
          this.notice
            ? html`<div class="callout warn agent-details__error" role="status">
                ${this.notice}
              </div>`
            : nothing
        }
        ${
          claws.length === 0
            ? html`<p class="agent-details__empty">
                ${t("agentDetails.claws.empty", { bot: botName })}
              </p>`
            : html`<ul class="agent-details__claws">
                ${repeat(
                  shown,
                  (claw) => claw.id,
                  (claw) => this.renderClaw(claw, botName, canChange),
                )}
              </ul>`
        }
        ${
          claws.length > shown.length
            ? html`<a
                class="agent-details__section-link"
                href=${agentsPath}
                @click=${(event: MouseEvent) => this.navigate("agents", agentsPath, event)}
                >${t("agentDetails.claws.more", { count: String(claws.length - shown.length) })}</a
              >`
            : nothing
        }
      </section>`;
    });
  }
}

if (!customElements.get("openclaw-agent-details-claws")) {
  customElements.define("openclaw-agent-details-claws", AgentDetailsClaws);
}
