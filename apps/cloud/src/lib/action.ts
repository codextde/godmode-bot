/** The result shape of every server action, and the wrapper that produces it. */
import { unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";
import { AppError } from "@/server/errors";

export type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string; fields?: Record<string, string> };

/**
 * Runs a server action body. AppErrors become their message, zod errors become per-field messages, anything else is
 * logged and shown as a generic sentence. Next's own signals (redirect, notFound, forbidden) pass through untouched.
 */
export async function runAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof AppError) return { ok: false, error: err.message };
    if (err instanceof ZodError) {
      const fields: Record<string, string> = {};
      for (const issue of err.issues) {
        const key = issue.path.map(String).join(".") || "form";
        fields[key] ??= issue.message;
      }
      const first = err.issues[0]?.message;
      return { ok: false, error: err.issues.length === 1 && first ? first : "Check the highlighted fields.", fields };
    }
    console.error("[action] unexpected error:", err);
    return { ok: false, error: "Something went wrong on our side. Try again." };
  }
}
