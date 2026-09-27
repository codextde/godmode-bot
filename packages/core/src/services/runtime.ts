import type { Settings } from "@godmode/shared";
import * as vault from "../vault/vault";
import { pruneAudit } from "./audit";

/** Apply settings that affect running subsystems (called at startup and after every settings update). */
export function applyRuntimeSettings(settings: Settings) {
  vault.setAutoLock(settings.security.autoLockMinutes);
  pruneAudit(settings.security.auditRetentionDays);
  for (const hook of hooks) {
    try {
      hook(settings);
    } catch {
      /* ignore */
    }
  }
}

const hooks: ((s: Settings) => void)[] = [];

/** Subsystems (runner, scheduler, browser) register to react to settings changes. */
export function onSettingsApplied(hook: (s: Settings) => void) {
  hooks.push(hook);
}
