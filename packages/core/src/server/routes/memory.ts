import type { Hono } from "hono";
import { IMPORT_MAX_CHARS, MEMORY_SOURCES } from "@godmode/shared";
import { acceptOffer, dismissOffer, listOffers } from "../../memory/offers";
import { importMemory } from "../../memory/importMemory";
import { body, z } from "../validate";

const importSchema = z.object({
  source: z.enum(MEMORY_SOURCES.map((s) => s.id) as [string, ...string[]]),
  text: z.string().min(1).max(IMPORT_MAX_CHARS),
});

export function registerMemoryRoutes(app: Hono): void {
  app.get("/api/offers", (c) => c.json(listOffers()));

  app.post("/api/offers/:id/accept", async (c) => c.json(await acceptOffer(c.req.param("id")), 201));

  app.post("/api/offers/:id/dismiss", (c) => c.json(dismissOffer(c.req.param("id"))));

  app.post("/api/memory/import", async (c) => {
    const input = await body(c, importSchema);
    return c.json(await importMemory({ source: input.source as (typeof MEMORY_SOURCES)[number]["id"], text: input.text }), 201);
  });
}
