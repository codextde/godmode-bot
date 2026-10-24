/**
 * Automations pinned to one computer of a device group (owner: remote): `routines.run_on` is "primary" or a device's id
 * in the primary's runner list (`GroupDevice.id`), the same on every computer. The scheduler fires a pinned automation
 * only there (group.ts `runsRoutineHere`), and Run now elsewhere goes there over the link.
 */
import type { Run } from "@godmode/shared";
import { all, get } from "../db";
import { computerName } from "../mobile/devices";
import { HttpError, badRequest } from "../util";
import { groupRole, isPrimary, primaryRunnerId, selfDeviceId } from "./group";

const DEVICE_ID = /^[A-Za-z0-9_-]{1,100}$/;

function rowName(id: string | null): string | null {
  return id ? (get<{ name: string }>("SELECT name FROM runners WHERE id = ?", id)?.name ?? null) : null;
}

/**
 * A pin as given (by the app, an agent: "primary", a device id, a computer's name, or what a secondary calls its
 * primary's runner) as it is stored. undefined = unchanged, null = any computer.
 */
export function resolveRunOn(input: string | null | undefined): string | null | undefined {
  if (input === undefined) return undefined;
  const value = (input ?? "").trim();
  if (!value || value.toLowerCase() === "any") return null;
  const role = groupRole();
  if (!role) throw badRequest("This computer isn't part of a device group: its automations run here.");
  const same = (a: string | null | undefined) => !!a && a.toLowerCase() === value.toLowerCase();
  const primaryId = role === "secondary" ? primaryRunnerId() : null;
  if (same("primary") || same(primaryId) || same(role === "primary" ? computerName() : rowName(primaryId))) return "primary";
  if (role === "secondary" && (same(selfDeviceId()) || same(computerName()))) return selfDeviceId();
  const devices = all<{ id: string; name: string }>("SELECT id, name FROM runners WHERE kind = 'device'");
  const device = devices.find((d) => same(d.id)) ?? devices.find((d) => same(d.name));
  if (device) return device.id;
  // A secondary knows the other secondaries only through its primary: their ids stand as given.
  if (role === "secondary" && DEVICE_ID.test(value) && value.includes("_")) return value;
  throw badRequest(`Unknown computer “${value}”: give "primary", a computer of the device group (Settings → Devices) or null for any.`);
}

/** The computer an automation is pinned to, as this one calls it. */
export function runOnName(runOn: string): string {
  if (runOn === "primary") return isPrimary() ? computerName() : (rowName(primaryRunnerId()) ?? "the primary");
  if (runOn === selfDeviceId()) return computerName();
  return rowName(runOn) ?? "the computer it is pinned to";
}

/**
 * Run now for an automation pinned to another computer: the request goes there (a secondary sends it to its primary,
 * which passes it on unless it is the pinned one). Refused clearly while that computer can't be reached.
 */
export async function runPinnedElsewhere(routine: { id: string; name: string; runOn: string }, opts: { byHuman?: boolean }): Promise<Run> {
  const target = isPrimary() ? routine.runOn : primaryRunnerId();
  const where = runOnName(routine.runOn);
  const offline = () =>
    new HttpError(409, `“${routine.name}” runs on ${where} only, and ${where} can't be reached right now. It runs there once it's back, or set Run on to Any device.`, "device_offline");
  if (!target) throw offline();
  const { link } = await import("./runners");
  let l: ReturnType<typeof link>;
  try {
    l = link(target);
    l.assertOnline();
  } catch {
    throw offline();
  }
  const here = isPrimary() || routine.runOn === "primary";
  return l.json<Run>("POST", `/api/routines/${encodeURIComponent(routine.id)}/run`, { here, byHuman: opts.byHuman === true }, { timeoutMs: 120_000 });
}
