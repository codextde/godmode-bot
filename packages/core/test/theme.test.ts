import { describe, expect, test } from "bun:test";
import { PALETTES } from "@godmode/shared";
import { DEFAULT_SETTINGS } from "../src/services/settings";
import { checkSettingsPatch } from "../src/services/settingsPatch";
import { settingInRange } from "../src/services/settingShape";

describe("theme", () => {
  test("light is the default", () => {
    expect(DEFAULT_SETTINGS.general.theme).toBe("light");
  });

  test("only light, dark and system are saved", () => {
    for (const theme of ["light", "dark", "system"]) expect(() => checkSettingsPatch({ general: { theme } }, () => {})).not.toThrow();
    expect(() => checkSettingsPatch({ general: { theme: "purple" } }, () => {})).toThrow("general.theme");
    expect(() => checkSettingsPatch({ general: { theme: 1 } }, () => {})).toThrow("general.theme");
  });

  test("paper is the default palette and only known palettes are saved", () => {
    expect(DEFAULT_SETTINGS.general.palette).toBe("paper");
    for (const palette of PALETTES) expect(() => checkSettingsPatch({ general: { palette } }, () => {})).not.toThrow();
    expect(() => checkSettingsPatch({ general: { palette: "neon" } }, () => {})).toThrow("general.palette");
    expect(settingInRange("general.palette", "nord")).toBe(true);
    expect(settingInRange("general.palette", "neon")).toBe(false);
  });

  test("phones and agents get the same choices", () => {
    expect(settingInRange("general.theme", "dark")).toBe(true);
    expect(settingInRange("general.theme", "purple")).toBe(false);
    expect(settingInRange("general.mode", "easy")).toBe(true);
    expect(settingInRange("general.mode", "simple")).toBe(false);
  });
});
