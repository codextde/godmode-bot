import type { Hono } from "hono";
import { listArchive, setArchived } from "../../services/archive";
import { body, z } from "../validate";

const archiveSchema = z.object({
  kind: z.enum(["workspace", "project", "agent", "routine"]),
  id: z.string().trim().min(1).max(100),
  archived: z.boolean(),
});

export function registerArchiveRoutes(app: Hono): void {
  app.get("/api/archive", (c) => c.json(listArchive()));

  app.post("/api/archive", async (c) => {
    const { kind, id, archived } = await body(c, archiveSchema);
    await setArchived(kind, id, archived);
    return c.json(listArchive());
  });
}
