import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { CronCompactJob } from "../api/types.ts";
import { pathForAgentPanel, pathForRoute } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { registerAgentDetailsClawsEnglish } from "../i18n/locales/en-agent-details-claws.ts";
import { registerAgentsHomeEnglish } from "../i18n/locales/en-agents-home.ts";
import { AgentRoutines } from "../lib/agents/agent-routines.ts";
import type { AgentsPanel } from "../lib/agents/panels.ts";
import { AgentRosterElement } from "../lib/agents/roster-element.ts";
import { formatList, formatRelativeTimestamp } from "../lib/format.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { formatCronSchedule } from "../lib/presenter.ts";
import { icons } from "./icons.ts";
import { renderAgentIdentityAvatar } from "./identity-avatar-view.ts";
import "./agent-details-claws.ts";
import "../styles/agent-details-panel.css";

registerAgentsHomeEnglish();
registerAgentDetailsClawsEnglish();

const AGENT_LINKS = [
  ["skills", "agentDetails.skills", icons.zap],
  ["tools", "agentDetails.tools", icons.wrench],
  ["memory", "agentDetails.memory", icons.brain],
  ["files", "agentDetails.instructions", icons.fileText],
] as const satisfies ReadonlyArray<readonly [AgentsPanel, string, unknown]>;

function renderAgentStatus(card: { activeNow: boolean; lastActiveAt?: number | null }) {
  return card.activeNow
    ? html`<span class="agent-details__working">${t("agentsHome.working")}</span>`
    : card.lastActiveAt
      ? t("agentsHome.lastActive", { time: formatRelativeTimestamp(card.lastActiveAt) })
      : t("agentsHome.neverActive");
}

/**
 * Everything about one agent beside its conversation: who it is, what it is
 * doing, the model it runs and its routines. Editing stays on the agent's
 * settings pages; this panel links to them.
 */
class AgentDetailsPanel extends AgentRosterElement {
  @property({ attribute: false }) agentId = "";
  @property({ type: Boolean }) presented = true;
  private routines: AgentRoutines | null = null;
  private routinesContext: ApplicationContext | null = null;

  override disconnectedCallback(): void {
    this.routines?.dispose();
    this.routines = null;
    this.routinesContext = null;
    super.disconnectedCallback();
  }

  protected override willUpdate(): void {
    if (this.context && this.routinesContext !== this.context) {
      this.routines?.dispose();
      this.routines = new AgentRoutines(this.context, () => this.requestUpdate());
      this.routinesContext = this.context;
    }
    // Idempotent: reads start, stop or move with the agent and presentation.
    this.routines?.sync({ agentId: this.agentId, presented: this.presented });
  }

  private navigate(event: MouseEvent, pathname: string, routeId: "agents" | "cron") {
    if (shouldHandleNavigationClick(event)) {
      event.preventDefault();
      this.context.navigate(routeId, { pathname });
    }
  }

  private agentLink(panel: AgentsPanel | null, label: string, icon: unknown, className: string) {
    const pathname = pathForAgentPanel(this.agentId, panel, this.context.basePath);
    return html`<a
      class=${className}
      href=${pathname}
      @click=${(event: MouseEvent) => this.navigate(event, pathname, "agents")}
      >${icon}<span>${label}</span></a
    >`;
  }

  private renderRoutine(job: CronCompactJob, routines: AgentRoutines) {
    const running = routines.isRunning(job);
    const when = running
      ? t("agentDetails.routineRunning")
      : !job.enabled
        ? t("agentDetails.routinePaused")
        : !job.nextRunAtMs
          ? t("agentDetails.routineNoNext")
          : job.nextRunAtMs <= Date.now()
            ? t("agentDetails.routineDue")
            : t("agentDetails.routineNext", { time: formatRelativeTimestamp(job.nextRunAtMs) });
    const last =
      job.lastRunAtMs && job.lastRunStatus
        ? t(`agentDetails.routineLast.${job.lastRunStatus}`, {
            time: formatRelativeTimestamp(job.lastRunAtMs),
          })
        : null;
    return html`<li
      class="agent-details__routine ${job.enabled ? "" : "agent-details__routine--paused"}"
      data-routine-id=${job.id}
    >
      <span
        class="agent-details__routine-dot agent-details__routine-dot--${
          running ? "running" : (job.lastRunStatus ?? "none")
        }"
        aria-hidden="true"
      ></span>
      <span class="agent-details__routine-copy">
        <strong>${job.displayName ?? job.name}</strong>
        <span>${job.schedule ? formatCronSchedule({ schedule: job.schedule }) : when}</span>
        <span>${job.schedule ? when : nothing}${last ? html` · ${last}` : nothing}</span>
      </span>
      ${
        routines.canRun
          ? html`<button
              type="button"
              class="btn btn--sm agent-details__run"
              ?disabled=${running}
              aria-label=${t("agentDetails.runNowNamed", { name: job.displayName ?? job.name })}
              @click=${() => void routines.run(job.id)}
            >
              ${icons.play}<span>${t("agentDetails.runNow")}</span>
            </button>`
          : nothing
      }
    </li>`;
  }

  private renderRoutines() {
    const routines = this.routines;
    if (!routines) {
      return nothing;
    }
    const cronPath = pathForAgentPanel(this.agentId, "cron", this.context.basePath);
    const hidden = Math.max(0, routines.total - routines.jobs.length);
    return html`<section class="agent-details__section" aria-labelledby="agent-details-routines">
      <header class="agent-details__section-head">
        <h3 id="agent-details-routines">${t("agentDetails.routines")}</h3>
        <a
          class="agent-details__section-link"
          href=${cronPath}
          @click=${(event: MouseEvent) => this.navigate(event, cronPath, "agents")}
          >${t("agentDetails.manage")}</a
        >
      </header>
      ${
        routines.error
          ? html`<div class="callout danger agent-details__error" role="alert">
              <span>${routines.error}</span>
              <button class="btn btn--sm" @click=${() => void routines.refresh()}>
                ${t("common.retry")}
              </button>
            </div>`
          : nothing
      }
      ${
        routines.feedback
          ? html`<div class="callout warn agent-details__error" role="status">
              ${routines.feedback}
            </div>`
          : nothing
      }
      ${
        routines.loading && routines.jobs.length === 0
          ? html`<span
              role="status"
              aria-label=${t("common.loading")}
              class="skeleton skeleton-line"
            ></span>`
          : routines.jobs.length === 0 && !routines.error
            ? html`<p class="agent-details__empty">
                ${t("agentDetails.noRoutines")}
                <a
                  href=${pathForRoute("cron", this.context.basePath)}
                  @click=${(event: MouseEvent) =>
                    this.navigate(event, pathForRoute("cron", this.context.basePath), "cron")}
                  >${t("agentDetails.addRoutine")}</a
                >
              </p>`
            : html`<ul class="agent-details__routines">
                ${repeat(
                  routines.jobs,
                  (job) => job.id,
                  (job) => this.renderRoutine(job, routines),
                )}
              </ul>`
      }
      ${
        hidden > 0
          ? html`<a
              class="agent-details__section-link"
              href=${cronPath}
              @click=${(event: MouseEvent) => this.navigate(event, cronPath, "agents")}
              >${t("agentDetails.moreRoutines", { count: String(hidden) })}</a
            >`
          : nothing
      }
    </section>`;
  }

  override render() {
    if (!this.context || !this.agentId) {
      return nothing;
    }
    return this.avatars.withActiveRoutes(() => {
      const cards = this.cards();
      const card = cards.find((candidate) => candidate.id === this.agentId);
      if (!card) {
        return this.roster.loading
          ? html`<span
              role="status"
              aria-label=${t("common.loading")}
              class="skeleton skeleton-line"
            ></span>`
          : html`<p class="agent-details__empty">${t("agentDetails.unavailable")}</p>`;
      }
      const status = renderAgentStatus(card);
      const bots = card.claw?.requesterAgentIds.map(
        (id) => cards.find((candidate) => candidate.id === id)?.name ?? id,
      );
      return html`<div class="agent-details" data-agent-id=${card.id}>
        <header class="agent-details__profile">
          <span class="agent-details__avatar" aria-hidden="true"
            >${renderAgentIdentityAvatar(card)}</span
          >
          <span class="agent-details__identity">
            <strong class="agent-details__name">${card.name}</strong>
            ${card.role ? html`<span class="agent-details__role">${card.role}</span>` : nothing}
            <span class="agent-details__status">${status}</span>
            ${
              bots?.length
                ? html`<span class="agent-details__works-for"
                    >${t("agentDetails.claws.worksFor", { names: formatList(bots) })}</span
                  >`
                : nothing
            }
          </span>
          ${this.agentLink(null, t("agentDetails.editProfile"), icons.pencil, "btn btn--sm agent-details__edit")}
        </header>
        <section class="agent-details__section" aria-labelledby="agent-details-model">
          <header class="agent-details__section-head">
            <h3 id="agent-details-model">${t("agentDetails.model")}</h3>
          </header>
          <span class="agent-details__model"
            >${icons.cpu}<span>${card.model ?? t("agentDetails.defaultModel")}</span></span
          >
        </section>
        ${
          card.claw
            ? nothing
            : html`<openclaw-agent-details-claws
                .botId=${card.id}
                .active=${this.active}
                .presented=${this.presented}
              ></openclaw-agent-details-claws>`
        }
        ${this.renderRoutines()}
        <nav
          class="agent-details__section agent-details__links"
          aria-label=${t("agentDetails.more")}
        >
          ${AGENT_LINKS.map(([panel, label, icon]) =>
            this.agentLink(panel, t(label), icon, "agent-details__link"),
          )}
        </nav>
      </div>`;
    });
  }
}

/** The bot a chat is with, for BotClaw's simple chat header: avatar, name and what it is doing. */
class AgentIdentity extends AgentRosterElement {
  @property({ attribute: false }) agentId = "";

  override render() {
    if (!this.context || !this.agentId) {
      return nothing;
    }
    return this.avatars.withActiveRoutes(() => {
      const card = this.cards().find((candidate) => candidate.id === this.agentId);
      if (!card) {
        return this.roster.loading
          ? html`<span
              role="status"
              aria-label=${t("common.loading")}
              class="skeleton skeleton-line agent-identity__loading"
            ></span>`
          : nothing;
      }
      return html`<span class="agent-identity" data-agent-id=${card.id}>
        <span class="agent-identity__avatar" aria-hidden="true"
          >${renderAgentIdentityAvatar(card)}</span
        >
        <span class="agent-identity__text">
          <strong class="agent-identity__name">${card.name}</strong>
          <span class="agent-identity__status">
            <span
              class=${`agent-identity__dot${card.activeNow ? " agent-identity__dot--active" : ""}`}
              aria-hidden="true"
            ></span>
            ${renderAgentStatus(card)}
          </span>
        </span>
      </span>`;
    });
  }
}

if (!customElements.get("openclaw-agent-details-panel")) {
  customElements.define("openclaw-agent-details-panel", AgentDetailsPanel);
}
if (!customElements.get("openclaw-agent-identity")) {
  customElements.define("openclaw-agent-identity", AgentIdentity);
}
