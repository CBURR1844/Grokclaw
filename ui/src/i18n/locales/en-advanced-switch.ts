import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// The Advanced switch and its notices load with the sidebar menus, not at startup.
const enAdvancedSwitch = {
  nav: {
    advanced: "Advanced",
    advancedDetails: "Show all pages and controls",
    advancedOn:
      "Advanced is on. All pages are in the sidebar and more controls are by the message box.",
    advancedOff: "Advanced is off. Back to the simple screen.",
  },
} satisfies TranslationMap;

export const registerAdvancedSwitchEnglish = Object.assign(
  () => Object.assign(en.nav, enAdvancedSwitch.nav),
  { catalog: enAdvancedSwitch },
);
