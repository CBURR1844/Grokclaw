import { resolveExactDurationParts } from "../../../src/infra/format-time/format-duration-exact.ts";
import type { CronJob, GatewaySessionRow } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { resolveCronJobLastRunStatus } from "../lib/cron-status.ts";
import {
  formatDateMs,
  formatRelativeTimestamp,
  formatTimeMs,
  formatUnit,
  formatMs,
  formatUnknownText,
} from "../lib/format.ts";
import { resolveSessionContextLimit } from "./sessions/context-budget.ts";

export function formatNextRun(ms?: number | null) {
  if (!ms) {
    return t("common.na");
  }
  const weekday = formatDateMs(ms, { weekday: "short" });
  if (weekday === t("common.na")) {
    return weekday;
  }
  return `${weekday}, ${formatMs(ms)} (${formatRelativeTimestamp(ms)})`;
}

export function formatSessionTokens(row: GatewaySessionRow) {
  if (row.totalTokens == null) {
    return t("common.na");
  }
  const total = row.totalTokens ?? 0;
  const ctx = resolveSessionContextLimit(row).tokens;
  return ctx ? `${total} / ${ctx}` : String(total);
}

export function formatEventPayload(payload: unknown): string {
  if (payload == null) {
    return "";
  }
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return formatUnknownText(payload);
  }
}

export function formatCronState(job: CronJob) {
  const state = job.state ?? {};
  const next = state.nextRunAtMs ? formatMs(state.nextRunAtMs) : t("common.na");
  const last = state.lastRunAtMs ? formatMs(state.lastRunAtMs) : t("common.na");
  const status = resolveCronJobLastRunStatus(job);
  return `${status} · next ${next} · last ${last}`;
}

export function formatCronSchedule(job: Pick<CronJob, "schedule">) {
  const s = job.schedule;
  if (s.kind === "at") {
    const atMs = Date.parse(s.at);
    return Number.isFinite(atMs) ? `At ${formatMs(atMs)}` : `At ${s.at}`;
  }
  if (s.kind === "every") {
    const duration = resolveExactDurationParts(s.everyMs)?.map(formatUnit).join(" ");
    return `Every ${duration ?? t("common.na")}`;
  }
  if (s.kind === "on-exit") {
    // on-exit jobs carry a watched command (+ optional cwd), not a cron expr;
    // without this branch they fall through and render "Cron undefined".
    return `On exit: ${s.command}${s.cwd ? ` (cwd: ${s.cwd})` : ""}`;
  }
  if (s.kind === "stream") {
    return `Stream: ${s.command.join(" ")}${s.cwd ? ` (cwd: ${s.cwd})` : ""}`;
  }
  return `Cron ${s.expr}${s.tz ? ` (${s.tz})` : ""}`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function countPhrase(count: number, one: string, many: string): string {
  return count === 1 ? t(one) : t(many, { count: String(count) });
}

function describeInterval(everyMs: number): string | null {
  if (everyMs % DAY_MS === 0) {
    return countPhrase(
      everyMs / DAY_MS,
      "agentDetails.schedule.everyDay",
      "agentDetails.schedule.everyDays",
    );
  }
  if (everyMs % HOUR_MS === 0) {
    return countPhrase(
      everyMs / HOUR_MS,
      "agentDetails.schedule.everyHour",
      "agentDetails.schedule.everyHours",
    );
  }
  if (everyMs % MINUTE_MS === 0) {
    return countPhrase(
      everyMs / MINUTE_MS,
      "agentDetails.schedule.everyMinute",
      "agentDetails.schedule.everyMinutes",
    );
  }
  return null;
}

function cronNumber(field: string, max: number): number | null {
  const value = /^\d{1,2}$/.test(field) ? Number(field) : Number.NaN;
  return value <= max ? value : null;
}

function describeCronExpr(expr: string): string | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5 || fields[2] !== "*" || fields[3] !== "*") {
    return null;
  }
  const [minute = "", hour = ""] = fields;
  const weekday = fields[4] ?? "";
  const step = /^\*\/(\d{1,2})$/.exec(minute);
  if (step && hour === "*") {
    // `*/N` restarts every hour, so only steps that divide an hour are even intervals.
    const every = Number(step[1]);
    if (every === 0 || 60 % every !== 0) {
      return null;
    }
    const interval = countPhrase(
      every,
      "agentDetails.schedule.everyMinute",
      "agentDetails.schedule.everyMinutes",
    );
    return weekday === "*"
      ? interval
      : weekday === "1-5"
        ? t("agentDetails.schedule.onWeekdays", { schedule: interval })
        : null;
  }
  const m = cronNumber(minute, 59);
  const h = cronNumber(hour, 23);
  if (m === null || h === null) {
    return null;
  }
  // Cron fields are wall-clock values in the job's zone; format them without a shift.
  const time = formatTimeMs(Date.UTC(2000, 0, 1, h, m), {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
  if (weekday === "*") {
    return t("agentDetails.schedule.dailyAt", { time });
  }
  if (weekday === "1-5") {
    return t("agentDetails.schedule.weekdaysAt", { time });
  }
  const day = cronNumber(weekday, 7);
  if (day === null) {
    return null;
  }
  // 2 January 2000 was a Sunday, cron day 0 (and 7).
  const name = formatDateMs(Date.UTC(2000, 0, 2 + (day % 7)), { weekday: "long", timeZone: "UTC" });
  return t("agentDetails.schedule.weeklyAt", { day: name, time });
}

/** Plain-language schedule for common shapes; anything else keeps formatCronSchedule's text. */
export function describeCronSchedule(schedule: CronJob["schedule"]): string {
  const phrase =
    schedule.kind === "every"
      ? describeInterval(schedule.everyMs)
      : schedule.kind === "cron"
        ? describeCronExpr(schedule.expr)
        : null;
  if (!phrase) {
    return formatCronSchedule({ schedule });
  }
  const zone = schedule.kind === "cron" ? schedule.tz?.trim() : undefined;
  return zone && zone !== Intl.DateTimeFormat().resolvedOptions().timeZone
    ? t("agentDetails.schedule.inZone", { schedule: phrase, zone })
    : phrase;
}

export function formatCronPayload(job: CronJob) {
  const p = job.payload;
  if (p.kind === "systemEvent") {
    return `System: ${p.text}`;
  }
  if (p.kind === "command") {
    return `Command: ${p.argv.join(" ")}`;
  }
  if (p.kind === "script") {
    return `Script: ${p.script}`;
  }
  if (p.kind === "heartbeat") {
    return "Heartbeat monitor";
  }
  const base = `Agent: ${p.message}`;
  const delivery = job.delivery;
  if (delivery && delivery.mode !== "none") {
    const target =
      delivery.mode === "webhook"
        ? delivery.to
          ? ` (${delivery.to})`
          : ""
        : delivery.channel || delivery.to
          ? ` (${delivery.channel ?? "last"}${delivery.to ? ` -> ${delivery.to}` : ""})`
          : "";
    return `${base} · ${delivery.mode}${target}`;
  }
  return base;
}
