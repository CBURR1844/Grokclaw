import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// A bot's Claws and their schedules register their copy without taxing UI startup.
const enAgentDetailsClaws = {
  agentDetails: {
    claws: {
      title: "Claws",
      empty: "No Claws yet. A Claw does one repeating job for {bot}.",
      add: "Add a Claw",
      addNamed: "Add {name} as a Claw",
      more: "{count} more Claws",
      options: "{name} options",
      remove: "Remove from {bot}",
      removeBlocked:
        "This Bot can start any agent, so it can't drop just one. Change that in its settings.",
      notConfigured: "This agent isn't in the configuration file, so it can't be linked here.",
      changeFailed: "Couldn't update the Claws. Try again.",
      noAccess: "Changing Claws needs admin access.",
      worksFor: "Works for {names}",
      lastRun: "{time} · {summary}",
      lastRunStatus: {
        ok: "Done",
        error: "Failed",
        skipped: "Skipped",
      },
      neverRun: "Hasn't run yet",
      noSchedule: "No schedule yet",
      scheduleSwitch: "{name}: {schedule}",
      pickTitle: "Send to a Claw",
      pickHint: "The Claw works on this message. Its result appears in this chat.",
      send: "Send",
      run: "Run…",
      runWithTask: "Run with a task…",
      runTitle: "Run {name}",
      runLabel: "What should {name} do?",
      runPlaceholder: "Describe the task",
      runHint: "{name} works on its own. The result appears in this chat.",
      runSubmit: "Run",
    },
    schedule: {
      everyMinute: "Every minute",
      everyMinutes: "Every {count} minutes",
      everyHour: "Every hour",
      everyHours: "Every {count} hours",
      everyDay: "Every day",
      everyDays: "Every {count} days",
      onWeekdays: "{schedule} on weekdays",
      dailyAt: "Every day at {time}",
      weekdaysAt: "Weekdays at {time}",
      weeklyAt: "Every {day} at {time}",
      inZone: "{schedule} ({zone})",
    },
  },
} satisfies TranslationMap;

export const registerAgentDetailsClawsEnglish = Object.assign(
  () => {
    const { claws, schedule } = enAgentDetailsClaws.agentDetails;
    // Fill en.ts's anchors so the shared objects and their source order survive.
    Object.assign(en.agentDetails.claws, claws);
    Object.assign(en.agentDetails.schedule, schedule);
  },
  { catalog: enAgentDetailsClaws },
);
