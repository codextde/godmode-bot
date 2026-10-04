import type { Context, Hono } from "hono";
import { answerQuestion, getQuestion, listQuestions, type Answerer, type QuestionFilter } from "../../services/questions";
import { badRequest } from "../../util";
import { requestDevice } from "../auth";
import { body, z } from "../validate";

const FILTERS: readonly QuestionFilter[] = ["open", "answered", "approved", "declined", "withdrawn", "resolved", "all"];

const attachmentSchema = z.object({
  name: z.string().min(1).max(255),
  mime: z.string().max(255).default("application/octet-stream"),
  data: z.string().min(1),
});

const answerSchema = z
  .object({
    optionId: z.string().min(1).max(20).optional(),
    decision: z.enum(["approve", "decline"]).optional(),
    note: z.string().max(2000).optional(),
    text: z.string().max(20_000).optional(),
    attachments: z.array(attachmentSchema).max(20).optional(),
  })
  .refine((v) => [v.optionId, v.decision, v.text].filter((x) => x !== undefined).length === 1, "Give exactly one of optionId, decision or text")
  .refine((v) => v.note === undefined || v.decision !== undefined, "A note goes with a decision")
  .refine((v) => !v.attachments?.length || v.text !== undefined, "Files go with a text answer");

/** The human answering: from a paired phone, or from the desktop app / dashboard. */
export function answererOf(c: Context): Answerer {
  return { actor: "user", via: requestDevice(c) ? "phone" : "app" };
}

export function registerQuestionRoutes(app: Hono): void {
  app.get("/api/questions", (c) => {
    const status = (c.req.query("status") || "all") as QuestionFilter;
    if (!FILTERS.includes(status)) throw badRequest(`Unknown status "${status}"`);
    const limit = Number(c.req.query("limit") ?? 100);
    return c.json(
      listQuestions({
        status,
        conversationId: c.req.query("conversationId") || undefined,
        agentId: c.req.query("agentId") || undefined,
        limit: Number.isFinite(limit) ? limit : 100,
      }),
    );
  });

  app.get("/api/questions/:id", (c) => c.json(getQuestion(c.req.param("id"))));

  app.post("/api/questions/:id/answer", async (c) => {
    const input = await body(c, answerSchema);
    return c.json(answerQuestion(c.req.param("id"), input, answererOf(c)));
  });
}
