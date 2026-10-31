import type { CaptchaSolver, Effort, InterfaceMode, Theme } from "@godmode/shared";
import { CAPTCHA_SOLVERS, EFFORT_OPTIONS, INTERFACE_MODES, THEMES, MAX_INSTRUCTIONS_LENGTH, MAX_MEMORY_CHARS, MIN_MEMORY_CHARS, POWER_MIN_BATTERY_OPTIONS, isClockTime, isModelId, isValidBranch, modelProvider, parseGitUrl, toE164 } from "@godmode/shared";
import { isAbsolute } from "node:path";
import { isPremiumNumber } from "../calls/numbers";
import { get } from "../db";
import { badRequest } from "../util";
import { isValidDreamSchedule } from "../memory/dreaming";
import { DEFAULT_SETTINGS, getSettings } from "./settings";

const CLOUD_SWITCHES = ["enabled", "browserAccess", "phoneAccess", "allowSecrets"];

/**
 * Checks a settings patch before it is saved and throws a 400 for what can't be right. `needsGrant` is called for the
 * changes that need the vault passphrase; it throws when the caller has none.
 */
export function checkSettingsPatch(patch: Record<string, unknown>, needsGrant: () => void): void {
  // server.hasDashboardPassword is derived; never trust client value
  if (patch.server && typeof patch.server === "object") delete (patch.server as Record<string, unknown>).hasDashboardPassword;
  // Making "reveal" the default secret access for new agents needs a fresh passphrase confirmation.
  const security = patch.security as { defaultSecretAccess?: unknown } | undefined;
  if (security?.defaultSecretAccess === "reveal" && getSettings().security.defaultSecretAccess !== "reveal") needsGrant();
  const { mode, theme } = (patch.general ?? {}) as { mode?: unknown; theme?: unknown };
  if (mode !== undefined && !INTERFACE_MODES.includes(mode as InterfaceMode)) throw badRequest(`general.mode must be one of ${INTERFACE_MODES.join(", ")}`);
  if (theme !== undefined && !THEMES.includes(theme as Theme)) throw badRequest(`general.theme must be one of ${THEMES.join(", ")}`);
  const runner = patch.runner as { appendSystemPrompt?: unknown; ultracode?: unknown; spendTracking?: unknown } | undefined;
  const instructions = runner?.appendSystemPrompt;
  if (typeof instructions === "string" && instructions.length > MAX_INSTRUCTIONS_LENGTH) {
    throw badRequest(`Instructions for every agent can be at most ${MAX_INSTRUCTIONS_LENGTH.toLocaleString("en-US")} characters`);
  }
  if (runner?.ultracode !== undefined && typeof runner.ultracode !== "boolean") throw badRequest("runner.ultracode must be true or false");
  if (runner?.spendTracking !== undefined && typeof runner.spendTracking !== "boolean") throw badRequest("runner.spendTracking must be true or false");
  const { effort, model, fallbackModel } = (runner ?? {}) as { effort?: unknown; model?: unknown; fallbackModel?: unknown };
  if (effort !== undefined && !EFFORT_OPTIONS.includes(effort as Effort)) throw badRequest(`runner.effort must be one of ${EFFORT_OPTIONS.join(", ")}`);
  for (const [key, value] of [["model", model], ["fallbackModel", fallbackModel]] as const) {
    if (value !== undefined && (typeof value !== "string" || (value.trim() !== "" && !isModelId(value.trim())))) throw badRequest(`Invalid model id for runner.${key}`);
    // Claude stays every agent's default: GLM is picked per agent, chat or delegated task.
    if (typeof value === "string" && modelProvider(value) !== "anthropic") throw badRequest(`runner.${key} must be a Claude model; pick GLM per agent or chat`);
  }
  const compactAt = (runner as { autoCompactPercent?: unknown } | undefined)?.autoCompactPercent;
  if (compactAt !== undefined && compactAt !== null && !(typeof compactAt === "number" && Number.isInteger(compactAt) && compactAt >= 0 && compactAt <= 95)) {
    throw badRequest("Auto-compress must be a whole percent between 0 (off) and 95, or empty for Claude Code's own threshold");
  }
  const budget = (runner as { monthlyBudgetUsd?: unknown } | undefined)?.monthlyBudgetUsd;
  if (budget !== undefined && budget !== null && !(typeof budget === "number" && Number.isFinite(budget) && budget > 0 && budget <= 1_000_000)) {
    throw badRequest("The monthly budget must be an amount above 0, or empty for no budget");
  }
  const memory = patch.memory as { dreaming?: unknown } | undefined;
  if (memory !== undefined && (typeof memory !== "object" || memory === null || Array.isArray(memory))) throw badRequest("Invalid memory settings");
  if (memory?.dreaming !== undefined && (typeof memory.dreaming !== "object" || memory.dreaming === null || Array.isArray(memory.dreaming))) {
    throw badRequest("Invalid dreaming settings");
  }
  const dreaming = memory?.dreaming as
    | { cron?: unknown; minNewExchanges?: unknown; refreshDays?: unknown; model?: unknown; enabled?: unknown; tidyWorkspace?: unknown; offers?: unknown; maxMemoryChars?: unknown }
    | undefined;
  if (dreaming) {
    if (dreaming.enabled !== undefined && typeof dreaming.enabled !== "boolean") throw badRequest("dreaming.enabled must be true or false");
    if (dreaming.tidyWorkspace !== undefined && typeof dreaming.tidyWorkspace !== "boolean") throw badRequest("dreaming.tidyWorkspace must be true or false");
    if (dreaming.offers !== undefined && typeof dreaming.offers !== "boolean") throw badRequest("dreaming.offers must be true or false");
    if (dreaming.cron !== undefined && (typeof dreaming.cron !== "string" || !isValidDreamSchedule(dreaming.cron))) {
      throw badRequest("The dreaming schedule must be a cron expression with 5 fields (minute hour day month weekday)");
    }
    const count = (v: unknown, max: number) => v === undefined || (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max);
    if (!count(dreaming.minNewExchanges, 1000)) throw badRequest("Minimum new exchanges must be a whole number between 0 and 1000");
    if (!count(dreaming.refreshDays, 365)) throw badRequest("Refresh days must be a whole number between 0 and 365");
    const size = dreaming.maxMemoryChars;
    if (size !== undefined && !(typeof size === "number" && Number.isInteger(size) && size >= MIN_MEMORY_CHARS && size <= MAX_MEMORY_CHARS)) {
      throw badRequest(`The memory size must be a whole number of characters between ${MIN_MEMORY_CHARS.toLocaleString("en-US")} and ${MAX_MEMORY_CHARS.toLocaleString("en-US")}`);
    }
    if (dreaming.model !== undefined && (typeof dreaming.model !== "string" || (dreaming.model.trim() !== "" && !isModelId(dreaming.model.trim())))) {
      throw badRequest("Invalid model id for dreaming");
    }
    // Dreams read every chat of an agent: they stay on Claude.
    if (typeof dreaming.model === "string" && modelProvider(dreaming.model) !== "anthropic") {
      throw badRequest("The dreaming model must be a Claude model");
    }
  }
  const diagnostics = patch.diagnostics as { verbose?: unknown } | undefined;
  if (diagnostics !== undefined && (typeof diagnostics !== "object" || diagnostics === null || Array.isArray(diagnostics))) throw badRequest("Invalid log settings");
  if (diagnostics?.verbose !== undefined && typeof diagnostics.verbose !== "boolean") throw badRequest("diagnostics.verbose must be true or false");
  const browser = patch.browser as { captchaSolver?: unknown; captchaDailyLimit?: unknown } | undefined;
  if (browser?.captchaSolver !== undefined && !CAPTCHA_SOLVERS.includes(browser.captchaSolver as CaptchaSolver)) {
    throw badRequest(`browser.captchaSolver must be one of ${CAPTCHA_SOLVERS.join(", ")}`);
  }
  const captchaLimit = browser?.captchaDailyLimit;
  if (captchaLimit !== undefined && !(typeof captchaLimit === "number" && Number.isInteger(captchaLimit) && captchaLimit >= 0 && captchaLimit <= 10_000)) {
    throw badRequest("The daily CAPTCHA limit must be a whole number between 0 and 10000");
  }
  const vm = patch.vm as Record<string, unknown> | undefined;
  if (vm !== undefined) {
    if (typeof vm !== "object" || vm === null || Array.isArray(vm)) throw badRequest("Invalid virtual machine settings");
    for (const key of ["enabled", "isolateHostShell", "vaultFill"] as const) {
      if (vm[key] !== undefined && typeof vm[key] !== "boolean") throw badRequest(`vm.${key} must be true or false`);
    }
    // Fills in a VM can't be bound to the login's website, so allowing them needs the vault passphrase.
    if (vm.vaultFill === true && !getSettings().vm.vaultFill) needsGrant();
    if (vm.onQuit !== undefined && !["suspend", "stop", "keep"].includes(vm.onQuit as string)) throw badRequest('vm.onQuit must be "suspend", "stop" or "keep"');
    const idle = vm.idleStopMinutes;
    if (idle !== undefined && !(typeof idle === "number" && Number.isInteger(idle) && idle >= 0 && idle <= 24 * 60)) {
      throw badRequest("Stopping idle VMs takes a whole number of minutes between 0 and 1440");
    }
    if (vm.tartPath !== undefined && (typeof vm.tartPath !== "string" || vm.tartPath.length > 4096 || (vm.tartPath.trim() !== "" && !vm.tartPath.trim().startsWith("/")))) {
      throw badRequest("The tart binary must be an absolute path (or empty)");
    }
  }
  const android = patch.android as Record<string, unknown> | undefined;
  if (android !== undefined) {
    if (typeof android !== "object" || android === null || Array.isArray(android)) throw badRequest("Invalid Android settings");
    for (const key of ["enabled", "vaultFill"] as const) {
      if (android[key] !== undefined && typeof android[key] !== "boolean") throw badRequest(`android.${key} must be true or false`);
    }
    // Like in a VM, a fill on a phone can't be bound to the login's app or website.
    if (android.vaultFill === true && !getSettings().android.vaultFill) needsGrant();
    const path = android.adbPath;
    if (path !== undefined && (typeof path !== "string" || path.length > 4096 || (path.trim() !== "" && !isAbsolute(path.trim())))) {
      throw badRequest("The adb binary must be an absolute path (or empty)");
    }
  }
  for (const feature of ["artifacts", "integrations", "messaging", "activity", "plugins", "cards", "ssh"] as const) {
    const value = patch[feature] as Record<string, unknown> | undefined;
    if (isObject(value) && value.enabled !== undefined && typeof value.enabled !== "boolean") throw badRequest(`${feature}.enabled must be true or false`);
  }
  const maintenance = patch.maintenance as Record<string, unknown> | undefined;
  if (maintenance !== undefined) {
    if (typeof maintenance !== "object" || maintenance === null || Array.isArray(maintenance)) throw badRequest("Invalid upkeep settings");
    for (const key of ["autoFix", "autoUpdate", "autoCleanup"] as const) {
      if (maintenance[key] !== undefined && typeof maintenance[key] !== "boolean") throw badRequest(`maintenance.${key} must be true or false`);
    }
  }
  const repair = patch.selfRepair as Record<string, unknown> | undefined;
  if (repair !== undefined) {
    if (typeof repair !== "object" || repair === null || Array.isArray(repair)) throw badRequest("Invalid self-repair settings");
    if (repair.autoMerge !== undefined && typeof repair.autoMerge !== "boolean") throw badRequest("selfRepair.autoMerge must be true or false");
    if (repair.repoUrl !== undefined) {
      if (typeof repair.repoUrl !== "string") throw badRequest("Enter the git URL of Godmode's source repository");
      const parsed = repair.repoUrl.trim() ? parseGitUrl(repair.repoUrl) : { url: "" };
      if ("error" in parsed) throw badRequest(parsed.error);
      repair.repoUrl = parsed.url;
    }
    if (repair.baseBranch !== undefined && (typeof repair.baseBranch !== "string" || !isValidBranch(repair.baseBranch.trim()))) throw badRequest("Enter a valid branch name");
    if (typeof repair.baseBranch === "string") repair.baseBranch = repair.baseBranch.trim();
    if (repair.agentId !== undefined && repair.agentId !== null && (typeof repair.agentId !== "string" || !get("SELECT 1 FROM agents WHERE id = ? AND enabled = 1", repair.agentId))) {
      throw badRequest("Pick an agent that exists and is turned on");
    }
  }
  const mobile = patch.mobile as Record<string, unknown> | undefined;
  if (mobile !== undefined) {
    if (typeof mobile !== "object" || mobile === null || Array.isArray(mobile)) throw badRequest("Invalid phone settings");
    if (mobile.enabled !== undefined && typeof mobile.enabled !== "boolean") throw badRequest("mobile.enabled must be true or false");
    const port = mobile.port;
    if (port !== undefined && !(typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535)) {
      throw badRequest("The phone port must be a whole number between 1024 and 65535");
    }
  }
  checkPhonePatch(patch.phone);
  const power = patch.power as Record<string, unknown> | undefined;
  if (power !== undefined) {
    if (typeof power !== "object" || power === null || Array.isArray(power)) throw badRequest("Invalid power settings");
    // Needs macOS's password dialog the first time: POST /api/power/lid switches it.
    if (power.lidClosedAwake !== undefined) throw badRequest("Turn lid-closed mode on or off with POST /api/power/lid");
    if (power.onlyWhileWorking !== undefined && typeof power.onlyWhileWorking !== "boolean") throw badRequest("power.onlyWhileWorking must be true or false");
    if (power.minBattery !== undefined && !POWER_MIN_BATTERY_OPTIONS.includes(power.minBattery as never)) {
      throw badRequest(`power.minBattery must be one of ${POWER_MIN_BATTERY_OPTIONS.join(", ")}`);
    }
  }
  const cloud = patch.cloud as Record<string, unknown> | undefined;
  if (cloud !== undefined) {
    if (typeof cloud !== "object" || cloud === null || Array.isArray(cloud)) throw badRequest("Invalid cloud settings");
    for (const [key, value] of Object.entries(cloud)) {
      if (!CLOUD_SWITCHES.includes(key)) throw badRequest(`Unknown cloud setting: ${key.slice(0, 50)}`);
      if (typeof value !== "boolean") throw badRequest(`cloud.${key} must be true or false`);
    }
  }
  // A section saved as anything but an object replaces it whole: every later read and save would break on it.
  for (const [section, value] of Object.entries(patch)) {
    const base = (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[section];
    if (isObject(base) && value !== undefined && !isObject(value)) throw badRequest(`${section} takes an object of settings`);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function checkPhonePatch(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw badRequest("Invalid phone call settings");
  const phone = value as Record<string, unknown>;
  for (const key of ["enabled", "callOwner", "answerInbound"] as const) {
    if (phone[key] !== undefined && typeof phone[key] !== "boolean") throw badRequest(`phone.${key} must be true or false`);
  }
  const text = (key: string, max: number) => {
    const v = phone[key];
    if (v !== undefined && (typeof v !== "string" || v.length > max)) throw badRequest(`phone.${key} must be text of at most ${max} characters`);
  };
  for (const key of ["numberId", "voiceId", "llm", "inboundAgentId"]) text(key, 200);
  text("inboundGreeting", 500);
  text("inboundInstructions", 6000);
  if (typeof phone.ownerNumber === "string" && phone.ownerNumber.trim()) {
    const number = toE164(phone.ownerNumber);
    if (!number) throw badRequest("Enter your phone number with the country code, e.g. +49 151 12345678");
    if (isPremiumNumber(number)) throw badRequest("A premium-rate or service number can't be your phone number");
    phone.ownerNumber = number;
  } else if (phone.ownerNumber !== undefined && phone.ownerNumber !== "") throw badRequest("Invalid phone number");
  for (const key of ["quietFrom", "quietTo"]) {
    const v = phone[key];
    if (v !== undefined && (typeof v !== "string" || (v !== "" && !isClockTime(v)))) throw badRequest("Quiet hours are times like 22:00");
  }
  const lang = phone.language;
  if (lang !== undefined && (typeof lang !== "string" || !/^[a-z]{2,3}$/.test(lang))) throw badRequest("phone.language must be a language code like en or de");
  const max = phone.maxMinutes;
  if (max !== undefined && !(typeof max === "number" && Number.isInteger(max) && max >= 1 && max <= 60)) throw badRequest("The longest call must be 1 to 60 minutes");
  const agentId = phone.inboundAgentId;
  if (typeof agentId === "string" && agentId && !get("SELECT 1 FROM agents WHERE id = ?", agentId)) throw badRequest("Pick an agent that exists");
}
