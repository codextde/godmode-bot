import type { Hono } from "hono";
import { parsePullRequestUrl } from "@godmode/shared";
import { getPullRequest, mergePullRequest, setAutoMerge } from "../../github/pullRequests";
import { audit } from "../../services/audit";
import { badRequest } from "../../util";
import { body, z } from "../validate";

export function registerGithubRoutes(app: Hono): void {
  app.get("/api/github/pull", async (c) => {
    const ref = parsePullRequestUrl(c.req.query("url") ?? "");
    if (!ref) throw badRequest("Not a GitHub pull request link");
    const view = await getPullRequest(ref, { interactive: c.req.query("background") !== "1", force: c.req.query("refresh") === "1" });
    return c.json(view);
  });

  app.post("/api/github/pull/merge", async (c) => {
    const input = await body(c, z.object({ url: z.string().min(1).max(500), method: z.enum(["merge", "squash", "rebase"]), headSha: z.string().regex(/^[0-9a-f]{40}$/i) }));
    const ref = parsePullRequestUrl(input.url);
    if (!ref) throw badRequest("Not a GitHub pull request link");
    const view = await mergePullRequest(ref, input.method, input.headSha);
    audit("user", "github.pull.merge", `${ref.owner}/${ref.repo}#${ref.number}`, { method: input.method });
    return c.json(view);
  });

  app.post("/api/github/pull/auto-merge", async (c) => {
    const input = await body(c, z.object({ url: z.string().min(1).max(500), method: z.enum(["merge", "squash", "rebase"]).nullable() }));
    const ref = parsePullRequestUrl(input.url);
    if (!ref) throw badRequest("Not a GitHub pull request link");
    const view = await setAutoMerge(ref, input.method);
    audit("user", input.method ? "github.pull.auto_merge.enable" : "github.pull.auto_merge.disable", `${ref.owner}/${ref.repo}#${ref.number}`, input.method ? { method: input.method } : {});
    return c.json(view);
  });
}
