"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { runAction, type ActionResult } from "@/lib/action";
import { checkPermission } from "@/lib/session";
import { removeDevice, setDeviceStatus } from "@/server/devices";

const id = z.string().min(1).max(64);

/**
 * Turns any computer off (the cloud refuses its link) or on again. The admin area always needs `devices.manage`,
 * also for the admin's own computers; those are managed on the Computers page.
 */
export async function setDeviceStatusAction(deviceId: string, status: "active" | "disabled"): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await checkPermission("devices.manage");
    await setDeviceStatus(id.parse(deviceId), z.enum(["active", "disabled"]).parse(status), ctx);
    revalidatePath("/admin/devices");
  });
}

/** Unlinks a computer from its account for good. */
export async function removeDeviceAction(deviceId: string): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await checkPermission("devices.manage");
    await removeDevice(id.parse(deviceId), ctx);
    revalidatePath("/admin/devices");
  });
}
