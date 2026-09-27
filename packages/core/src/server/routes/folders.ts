import type { Hono } from "hono";
import { listFolders, recentFolders } from "../../services/folders";

export function registerFolderRoutes(app: Hono): void {
  app.get("/api/folders", (c) => c.json(listFolders(c.req.query("path"), ["1", "true"].includes(c.req.query("hidden") ?? ""))));

  app.get("/api/folders/recent", (c) => c.json(recentFolders()));
}
