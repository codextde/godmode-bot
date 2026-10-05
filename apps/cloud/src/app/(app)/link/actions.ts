"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { runAction, type ActionResult } from "@/lib/action";
import { checkUser } from "@/lib/session";
import { approveLink, denyLink } from "@/server/devices/link";
import { AppError } from "@/server/errors";

const code = z.string("Enter the code shown in Godmode.").trim().min(8, "Enter the code shown in Godmode.").max(32, "Enter the code shown in Godmode.");

export type ApproveResult = ActionResult<{ deviceId: string; name: string }> & {
  /** The plan's computer limit is reached; the page then points to Billing. */
  planLimit?: boolean;
};

/** Links the computer that shows this code to the signed-in account (`approveLink` checks role, plan and code). */
export async function approveLinkAction(userCode: string): Promise<ApproveResult> {
  let planLimit = false;
  const result = await runAction(async () => {
    const ctx = await checkUser();
    try {
      const { device } = await approveLink(code.parse(userCode), ctx);
      revalidatePath("/", "layout");
      return { deviceId: device.id, name: device.name };
    } catch (err) {
      planLimit = err instanceof AppError && err.code === "plan_limit";
      throw err;
    }
  });
  return planLimit ? { ...result, planLimit } : result;
}

export async function denyLinkAction(userCode: string): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await checkUser();
    await denyLink(code.parse(userCode), ctx);
  });
}
