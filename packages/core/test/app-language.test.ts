import { describe, expect, test } from "bun:test";
import { cronToHuman, presenceLabel, scheduleToHuman, validateCron } from "@godmode/shared";
import { DEFAULT_SETTINGS } from "../src/services/settings";
import { checkSettingsPatch } from "../src/services/settingsPatch";
import { settingInRange } from "../src/services/settingShape";

describe("app language", () => {
  test("follows the device by default", () => {
    expect(DEFAULT_SETTINGS.general.language).toBe("system");
  });

  test("only system, en and de are accepted", () => {
    for (const language of ["system", "en", "de"]) expect(() => checkSettingsPatch({ general: { language } }, () => {})).not.toThrow();
    expect(() => checkSettingsPatch({ general: { language: "fr" } }, () => {})).toThrow("general.language");
    expect(settingInRange("general.language", "de")).toBe(true);
    expect(settingInRange("general.language", "klingon")).toBe(false);
  });

  test("schedules read in German and stay English by default", () => {
    expect(cronToHuman("30 8 * * 1-5")).toStartWith("Weekdays at");
    expect(cronToHuman("30 8 * * 1-5", "de")).toBe("Werktags um 08:30");
    expect(cronToHuman("0 8-20/2 * * *", "de")).toBe("Alle 2 Stunden von 08:00 bis 20:00");
    expect(scheduleToHuman("0 8 * * 1-5", 90, 1, "de")).toBe("Werktags zwischen 08:00 und 09:30");
    expect(validateCron("61 * * * *", "de")).toBe("Minute muss zwischen 0 und 59 liegen");
    expect(validateCron("61 * * * *")).toBe("Minute must be between 0 and 59");
  });

  test("presence reads in German", () => {
    expect(presenceLabel({ state: "idle" } as never, "de")).toBe("Bereit");
    expect(presenceLabel({ state: "idle" } as never)).toBe("Idle");
  });
});
