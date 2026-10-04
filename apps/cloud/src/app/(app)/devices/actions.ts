"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { runAction, type ActionResult } from "@/lib/action";
import { checkUser } from "@/lib/session";
import { removeDevice, renameDevice, setDeviceStatus } from "@/server/devices";
import { shareDevice, unshareDevice } from "@/server/devices/access";

// The services decide who may do what (owner, or `devices.manage` for turning off and removing); the actions only
// make sure someone is signed in and that the input has the right shape.
const id = z.string("This computer does not exist any more.").min(1, "This computer does not exist any more.").max(64, "This computer does not exist any more.");

function refresh(): void {
  // Computer names also appear in the shell's command palette.
  revalidatePath("/", "layout");
}

export async function renameDeviceAction(deviceId: string, name: string): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await checkUser();
    const clean = z.string("Give the computer a name.").max(200, "Keep the name under 80 characters.").parse(name);
    await renameDevice(id.parse(deviceId), clean, ctx);
    refresh();
  });
}

export async function setDeviceStatusAction(deviceId: string, status: "active" | "disabled"): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await checkUser();
    const value = z.enum(["active", "disabled"], "Choose on or off.").parse(status);
    await setDeviceStatus(id.parse(deviceId), value, ctx);
    refresh();
  });
}

export async function removeDeviceAction(deviceId: string): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await checkUser();
    await removeDevice(id.parse(deviceId), ctx);
    refresh();
  });
}

export async function shareDeviceAction(deviceId: string, email: string, role: "operator" | "viewer"): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await checkUser();
    const input = z
      .object({
        email: z.string("Enter their e-mail address.").trim().min(1, "Enter their e-mail address.").max(320, "That address is too long."),
        role: z.enum(["operator", "viewer"], "Choose what they may do on this computer."),
      })
      .parse({ email, role });
    await shareDevice(id.parse(deviceId), input.email, input.role, ctx);
    refresh();
  });
}

/** The owner removes someone, or a person leaves a computer that was shared with them. */
export async function unshareDeviceAction(deviceId: string, userId: string): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await checkUser();
    await unshareDevice(id.parse(deviceId), z.string().min(1).max(64).parse(userId), ctx);
    refresh();
  });
}
