import { describe, expect, it } from "vitest";
import { describeCronSchedule } from "./schedule-phrase.ts";

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

  it("names a time of day without a zone only when the next run lands on it", () => {
    const schedule = { kind: "cron" as const, expr: "0 7 * * *" };
    const at = (hour: number) => new Date(2030, 0, 2, hour, 0).getTime();

    // Without a zone the job runs on the Gateway host's clock, which may not be the viewer's.
    expect(describeCronSchedule(schedule, at(7))).toMatch(/^Every day at 7:00\sAM$/u);
    expect(describeCronSchedule(schedule, at(23))).toBe("Cron 0 7 * * *");
    expect(describeCronSchedule(schedule)).toBe("Cron 0 7 * * *");
    expect(describeCronSchedule({ kind: "cron", expr: "*/5 * * * *" })).toBe("Every 5 minutes");
  });

  it("names a zone other than the viewer's", () => {
    const zone = localZone === "Pacific/Kiritimati" ? "Pacific/Niue" : "Pacific/Kiritimati";
    expect(describeCronSchedule({ kind: "cron", expr: "*/5 * * * *", tz: zone })).toBe(
      `Every 5 minutes (${zone})`,
    );
  });
});
