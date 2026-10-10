import type { CronJob } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { registerAgentDetailsClawsEnglish } from "../../i18n/locales/en-agent-details-claws.ts";
import { formatDateMs, formatTimeMs } from "../format.ts";
import { formatCronSchedule } from "../presenter.ts";

registerAgentDetailsClawsEnglish();

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

function describeCronExpr(
  expr: string,
  clockHolds: (hour: number, minute: number) => boolean,
): string | null {
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
  if (m === null || h === null || !clockHolds(h, m)) {
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

/**
 * Plain-language schedule for common shapes; anything else keeps formatCronSchedule's text.
 * A cron job without its own zone runs on the Gateway host's clock, which the browser
 * cannot see, so a time of day is named only when the next run lands on that local time.
 */
export function describeCronSchedule(
  schedule: CronJob["schedule"],
  nextRunAtMs?: number | null,
): string {
  const zone = schedule.kind === "cron" ? schedule.tz?.trim() : undefined;
  const clockHolds = (hour: number, minute: number) => {
    const next = zone || nextRunAtMs == null ? null : new Date(nextRunAtMs);
    return Boolean(zone) || (next?.getHours() === hour && next.getMinutes() === minute);
  };
  const phrase =
    schedule.kind === "every"
      ? describeInterval(schedule.everyMs)
      : schedule.kind === "cron"
        ? describeCronExpr(schedule.expr, clockHolds)
        : null;
  if (!phrase) {
    return formatCronSchedule({ schedule });
  }
  return zone && zone !== Intl.DateTimeFormat().resolvedOptions().timeZone
    ? t("agentDetails.schedule.inZone", { schedule: phrase, zone })
    : phrase;
}
