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

export { z };
