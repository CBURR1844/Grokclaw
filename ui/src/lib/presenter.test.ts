import { afterEach, describe, expect, it } from "vitest";
// Control UI tests cover cron schedule presentation.
import { contextBudgetStatusFixture } from "../../../src/config/sessions/context-budget.test-support.js";
import type { CronJob } from "../api/types.ts";
import { i18n } from "../i18n/index.ts";
import {
  describeCronSchedule,
  formatCronPayload,
  formatCronSchedule,
  formatSessionTokens,
} from "./presenter.ts";

function job(schedule: CronJob["schedule"]): CronJob {
  return {
    id: "job",
    name: "Job",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule,
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "test" },
    state: {},
  };
}

describe("formatCronSchedule", () => {
  afterEach(async () => {
    await i18n.setLocale("en");
  });

  it.each([
    { everyMs: 60_000, expected: "Every 1m" },
    { everyMs: 450, expected: "Every 450ms" },
    { everyMs: 90_000, expected: "Every 1m 30s" },
    { everyMs: 3_661_001, expected: "Every 1h 1m 1s 1ms" },
    { everyMs: 604_800_000, expected: "Every 7d" },
  ])("preserves configured duration precision for every $everyMs ms", ({ everyMs, expected }) => {
    expect(formatCronSchedule(job({ kind: "every", everyMs }))).toBe(expected);
  });

  it("localizes configured duration precision", async () => {
    await i18n.setLocale("fr");
    const expected = [
      { value: 1, unit: "minute" },
      { value: 30, unit: "second" },
      { value: 1, unit: "millisecond" },
    ]
      .map(({ value, unit }) =>
        new Intl.NumberFormat("fr", {
          style: "unit",
          unit,
          unitDisplay: "narrow",
          maximumFractionDigits: 0,
        }).format(value),
      )
      .join(" ");
    expect(formatCronSchedule(job({ kind: "every", everyMs: 90_001 }))).toBe(`Every ${expected}`);
  });

  it("formats cron schedules", () => {
    expect(formatCronSchedule(job({ kind: "cron", expr: "0 * * * *" }))).toBe("Cron 0 * * * *");
  });

  it("formats on-exit schedules with the watched command instead of falling through to cron", () => {
    expect(formatCronSchedule(job({ kind: "on-exit", command: "make build" }))).toBe(
      "On exit: make build",
    );
  });

  it("includes the working directory for on-exit schedules when set", () => {
    expect(formatCronSchedule(job({ kind: "on-exit", command: "./watch.sh", cwd: "/repo" }))).toBe(
      "On exit: ./watch.sh (cwd: /repo)",
    );
  });
});

describe("describeCronSchedule", () => {
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  it.each([
    { expr: "*/15 * * * *", expected: /^Every 15 minutes$/u },
    { expr: "*/1 * * * *", expected: /^Every minute$/u },
    { expr: "*/30 * * * 1-5", expected: /^Every 30 minutes on weekdays$/u },
    { expr: "0 7 * * *", expected: /^Every day at 7:00\sAM$/u },
    { expr: "30 9 * * 1-5", expected: /^Weekdays at 9:30\sAM$/u },
    { expr: "5 18 * * 1", expected: /^Every Monday at 6:05\sPM$/u },
    { expr: "0 8 * * 0", expected: /^Every Sunday at 8:00\sAM$/u },
    { expr: "0 8 * * 7", expected: /^Every Sunday at 8:00\sAM$/u },
  ])("says $expr in plain words", ({ expr, expected }) => {
    expect(describeCronSchedule({ kind: "cron", expr, tz: localZone })).toMatch(expected);
  });

  it.each([
    { everyMs: 60_000, expected: "Every minute" },
    { everyMs: 15 * 60_000, expected: "Every 15 minutes" },
    { everyMs: 3_600_000, expected: "Every hour" },
    { everyMs: 2 * 3_600_000, expected: "Every 2 hours" },
    { everyMs: 86_400_000, expected: "Every day" },
    { everyMs: 3 * 86_400_000, expected: "Every 3 days" },
    { everyMs: 90_000, expected: "Every 1m 30s" },
  ])("says every $everyMs ms in plain words", ({ everyMs, expected }) => {
    expect(describeCronSchedule({ kind: "every", everyMs })).toBe(expected);
  });

  it.each(["*/45 * * * *", "0 */2 * * *", "0 9 1 * *", "0 9 * * 1,3", "0 0 9 * * *", "61 9 * * *"])(
    "keeps the exact cron text for %s",
    (expr) => {
      expect(describeCronSchedule({ kind: "cron", expr })).toBe(`Cron ${expr}`);
    },
  );

  it("names a zone other than the viewer's", () => {
    const zone = localZone === "Pacific/Kiritimati" ? "Pacific/Niue" : "Pacific/Kiritimati";
    expect(describeCronSchedule({ kind: "cron", expr: "*/5 * * * *", tz: zone })).toBe(
      `Every 5 minutes (${zone})`,
    );
  });
});

describe("formatCronPayload", () => {
  it("formats a Workshop review as an agent turn", () => {
    expect(
      formatCronPayload({
        ...job({ kind: "every", everyMs: 60_000 }),
        payload: { kind: "agentTurn", message: "Review the Workshop collection." },
      }),
    ).toBe("Agent: Review the Workshop collection.");
  });
});

it("formats session detail against its last-run prompt budget", () => {
  expect(
    formatSessionTokens({
      key: "main",
      kind: "direct",
      updatedAt: 2,
      totalTokens: 160_000,
      contextTokens: 200_000,
      contextBudgetStatus: contextBudgetStatusFixture(),
    }),
  ).toBe("160000 / 180000");
});
