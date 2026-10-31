import type { Hono } from "hono";
import { parsePullRequestUrl } from "@godmode/shared";
import { getPullRequest } from "../../github/pullRequests";
import { badRequest } from "../../util";

export function registerGithubRoutes(app: Hono): void {
  app.get("/api/github/pull", async (c) => {
    const ref = parsePullRequestUrl(c.req.query("url") ?? "");
    if (!ref) throw badRequest("Not a GitHub pull request link");
    const view = await getPullRequest(ref, { interactive: c.req.query("background") !== "1", force: c.req.query("refresh") === "1" });
    return c.json(view);
  });
}
