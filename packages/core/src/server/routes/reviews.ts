import type { Hono } from "hono";
import { badRequest } from "../../util";
import { getReview, reviewOverview, startReview, undoReviewAction } from "../../review/review";

export function registerReviewRoutes(app: Hono): void {
  app.get("/api/reviews", (c) => c.json(reviewOverview()));

  app.post("/api/reviews", async (c) => c.json(await startReview("manual"), 201));

  app.get("/api/reviews/:id", (c) => c.json(getReview(c.req.param("id"))));

  app.post("/api/reviews/:id/actions/:index/undo", async (c) => {
    const index = Number(c.req.param("index"));
    if (!Number.isInteger(index) || index < 0) throw badRequest("Invalid change");
    return c.json(await undoReviewAction(c.req.param("id"), index));
  });
}
