import type { Context } from "hono";
import { z } from "zod";
import { badRequest } from "../util";

/** Parse and validate a JSON body with a zod schema; throws 400 with details on failure. */
export async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw badRequest(
      "Validation failed: " + result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
      result.error.issues,
    );
  }
  return result.data;
}

/** A screen, window or browser tab shared with an agent (see ComputerTarget). */
export const computerTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("desktop") }),
  z.object({ kind: z.literal("display"), displayId: z.string().min(1).max(200), name: z.string().max(200).optional() }),
  z.object({
    kind: z.literal("window"),
    windowId: z.number().int().nonnegative().max(0xffffffff),
    pid: z.number().int().positive().max(0xffffffff),
    app: z.string().max(200).default(""),
    title: z.string().max(500).default(""),
    bundleId: z.string().max(300).nullable().optional(),
  }),
  z.object({
    kind: z.literal("tab"),
    profileId: z.string().min(1).max(100),
    targetId: z.string().min(1).max(200),
    title: z.string().max(500).default(""),
    url: z.string().max(4096).default(""),
  }),
]);

export { z };
