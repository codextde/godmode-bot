import type { Hono } from "hono";
import { MOD_ICONS } from "@godmode/shared";
import { disableIdleTimeout } from "../../mcp/http";
import {
  checkModUpdates,
  checkUnsaved,
  createMod,
  deleteMod,
  getMod,
  importMod,
  installMod,
  listModCatalog,
  listMods,
  listTemplates,
  recheckMod,
  updateGitMod,
  updateMod,
} from "../../mods/service";
import { body, z } from "../validate";

const files = z.record(z.string().max(200), z.string());
const optionValue = z.union([z.string().max(16_384), z.number(), z.boolean(), z.array(z.string().max(4000)).max(500)]);

const fields = {
  title: z.string().max(200),
  description: z.string().max(2000),
  icon: z.enum(MOD_ICONS),
  files,
  enabled: z.boolean(),
  scope: z.enum(["all", "agents"]),
  agentIds: z.array(z.string().max(100)).max(500),
};

const installSchema = z.object({
  source: z.string().min(1).max(500),
  ref: z.string().max(200).optional(),
  plugin: z.string().max(100).optional(),
  enabled: z.boolean().optional(),
  catalogId: z.string().max(100).optional(),
});

const createSchema = z.object({ ...fields, templateId: z.string().max(100), name: z.string().max(100) }).partial();
const patchSchema = z.object({ ...fields, digest: z.string().max(100), values: z.record(z.string().max(200), optionValue.nullable()) }).partial();

export function registerModRoutes(app: Hono): void {
  app.get("/api/mods", (c) => c.json(listMods()));

  app.get("/api/mods/templates", (c) => c.json(listTemplates()));

  /** Plugins Godmode recommends, installed from their repositories. */
  app.get("/api/mods/catalog", (c) => c.json(listModCatalog()));

  /** Install a plugin from a git repository (clones it and checks it with Claude Code: can take a minute). */
  app.post("/api/mods/install", async (c) => {
    const input = await body(c, installSchema);
    disableIdleTimeout(c);
    return c.json(await installMod(input), 201);
  });

  /** Look up the newest commit of the plugins from repositories (all, or `ids`). */
  app.post("/api/mods/updates", async (c) => {
    const input = await body(c, z.object({ ids: z.array(z.string().max(100)).max(500).optional() }));
    disableIdleTimeout(c);
    return c.json(await checkModUpdates(input.ids));
  });

  app.post("/api/mods", async (c) => {
    const input = await body(c, createSchema);
    disableIdleTimeout(c);
    return c.json(await createMod(input), 201);
  });

  /** Check files that aren't saved yet with Claude Code's validator. */
  app.post("/api/mods/check", async (c) => {
    const input = await body(c, z.object({ files }));
    disableIdleTimeout(c);
    return c.json({ check: await checkUnsaved(input.files) });
  });

  app.post("/api/mods/import", async (c) => {
    const input = await body(c, z.object({ path: z.string().min(1).max(4096) }));
    disableIdleTimeout(c);
    return c.json(await importMod(input.path), 201);
  });

  app.get("/api/mods/:id", (c) => c.json(getMod(c.req.param("id"))));

  app.patch("/api/mods/:id", async (c) => {
    const input = await body(c, patchSchema);
    disableIdleTimeout(c);
    return c.json(await updateMod(c.req.param("id"), input));
  });

  app.delete("/api/mods/:id", (c) => {
    deleteMod(c.req.param("id"));
    return c.json({ ok: true as const });
  });

  app.post("/api/mods/:id/update", async (c) => {
    disableIdleTimeout(c);
    return c.json(await updateGitMod(c.req.param("id")));
  });

  app.post("/api/mods/:id/check", async (c) => {
    disableIdleTimeout(c);
    return c.json(await recheckMod(c.req.param("id")));
  });
}
