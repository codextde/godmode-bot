import type { Effort } from "@godmode/shared";
import { EFFORT_OPTIONS, MAX_INSTRUCTIONS_LENGTH, isModelId, isValidBranch, parseGitUrl } from "@godmode/shared";
import { get } from "../db";
import { badRequest } from "../util";
import { isValidDreamSchedule } from "../memory/dreaming";
import { getSettings } from "./settings";

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
  const runner = patch.runner as { appendSystemPrompt?: unknown; ultracode?: unknown } | undefined;
  const instructions = runner?.appendSystemPrompt;
  if (typeof instructions === "string" && instructions.length > MAX_INSTRUCTIONS_LENGTH) {
    throw badRequest(`Instructions for every agent can be at most ${MAX_INSTRUCTIONS_LENGTH.toLocaleString("en-US")} characters`);
  }
  if (runner?.ultracode !== undefined && typeof runner.ultracode !== "boolean") throw badRequest("runner.ultracode must be true or false");
  const { effort, model, fallbackModel } = (runner ?? {}) as { effort?: unknown; model?: unknown; fallbackModel?: unknown };
  if (effort !== undefined && !EFFORT_OPTIONS.includes(effort as Effort)) throw badRequest(`runner.effort must be one of ${EFFORT_OPTIONS.join(", ")}`);
  for (const [key, value] of [["model", model], ["fallbackModel", fallbackModel]] as const) {
    if (value !== undefined && (typeof value !== "string" || (value.trim() !== "" && !isModelId(value.trim())))) throw badRequest(`Invalid model id for runner.${key}`);
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
  const dreaming = memory?.dreaming as { cron?: unknown; minNewExchanges?: unknown; refreshDays?: unknown; model?: unknown; enabled?: unknown } | undefined;
  if (dreaming) {
    if (dreaming.enabled !== undefined && typeof dreaming.enabled !== "boolean") throw badRequest("dreaming.enabled must be true or false");
    if (dreaming.cron !== undefined && (typeof dreaming.cron !== "string" || !isValidDreamSchedule(dreaming.cron))) {
      throw badRequest("The dreaming schedule must be a cron expression with 5 fields (minute hour day month weekday)");
    }
    const count = (v: unknown, max: number) => v === undefined || (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max);
    if (!count(dreaming.minNewExchanges, 1000)) throw badRequest("Minimum new exchanges must be a whole number between 0 and 1000");
    if (!count(dreaming.refreshDays, 365)) throw badRequest("Refresh days must be a whole number between 0 and 365");
    if (dreaming.model !== undefined && (typeof dreaming.model !== "string" || (dreaming.model.trim() !== "" && !isModelId(dreaming.model.trim())))) {
      throw badRequest("Invalid model id for dreaming");
    }
  }
  const diagnostics = patch.diagnostics as { verbose?: unknown } | undefined;
  if (diagnostics !== undefined && (typeof diagnostics !== "object" || diagnostics === null || Array.isArray(diagnostics))) throw badRequest("Invalid log settings");
  if (diagnostics?.verbose !== undefined && typeof diagnostics.verbose !== "boolean") throw badRequest("diagnostics.verbose must be true or false");
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
  const cloud = patch.cloud as Record<string, unknown> | undefined;
  if (cloud !== undefined) {
    if (typeof cloud !== "object" || cloud === null || Array.isArray(cloud)) throw badRequest("Invalid cloud settings");
    for (const [key, value] of Object.entries(cloud)) {
      if (!CLOUD_SWITCHES.includes(key)) throw badRequest(`Unknown cloud setting: ${key.slice(0, 50)}`);
      if (typeof value !== "boolean") throw badRequest(`cloud.${key} must be true or false`);
    }
  }
}
