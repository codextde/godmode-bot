import type { Hono } from "hono";
import { EFFORT_OPTIONS } from "@godmode/shared";
import {
  createAgent,
  deleteAgent,
  getAgent,
  listAgentCommits,
  listAgentFiles,
  listAgents,
  readAgentFile,
  updateAgent,
  writeAgentFile,
} from "../../agents/service";
import { AGENT_TEMPLATES } from "../../agents/templates";
import { createRoutine, deleteRoutine, listRoutines, runRoutineNow, updateRoutine } from "../../services/routines";
import { startChat } from "../../services/conversations";
import { conflict } from "../../util";
import { body, z } from "../validate";

const id = z.string().min(1).max(64);

const permissionsSchema = z
  .object({
    canManageAgents: z.boolean(),
    allowDelegation: z.boolean(),
    delegateTo: z.array(id).max(200),
    secretAccess: z.enum(["fill", "reveal"]),
    credentialIds: z.array(id).max(1000).nullable(),
    totpIds: z.array(id).max(1000).nullable(),
    maxBudgetUsd: z.number().positive().max(10_000).nullable(),
  })
  .partial();

const browserSchema = z
  .object({
    profileId: id.nullable(),
    enabled: z.boolean(),
    headless: z.boolean().nullable(),
  })
  .partial();

const subagentSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "Use lowercase letters, digits and hyphens"),
  description: z.string().trim().min(1).max(1000),
  prompt: z.string().trim().min(1).max(20_000),
  model: z.string().trim().max(100).optional(),
});

const agentSchema = z.object({
  workspaceId: id.nullable().optional(),
  name: z.string().trim().min(1, "Name is required").max(80),
  avatar: z.string().trim().max(32).optional(),
  color: z.string().trim().max(32).optional(),
  description: z.string().max(2000).optional(),
  instructions: z.string().max(50_000).optional(),
  model: z.string().trim().max(100).optional(),
  effort: z.enum(EFFORT_OPTIONS).nullable().optional(),
  enabled: z.boolean().optional(),
  permissions: permissionsSchema.optional(),
  browser: browserSchema.optional(),
  mcpServerIds: z.array(id).max(200).optional(),
  inheritMcp: z.boolean().optional(),
  subagents: z.array(subagentSchema).max(20).optional(),
});

const routineSchema = z.object({
  agentId: id,
  name: z.string().trim().min(1, "Name is required").max(120),
  cron: z.string().trim().min(1, "Cron expression is required").max(120),
  timezone: z.string().trim().max(64).optional(),
  prompt: z.string().trim().min(1, "Prompt is required").max(20_000),
  enabled: z.boolean().optional(),
  reuseConversation: z.boolean().optional(),
});

function scopeParam(value: string | undefined): string | null | "all" {
  if (!value || value === "all") return "all";
  if (value === "global") return null;
  return value;
}

export function registerAgentRoutes(app: Hono): void {
  /* Agents ------------------------------------------------------------ */

  app.get("/api/agents", (c) => c.json(listAgents({ workspaceId: scopeParam(c.req.query("workspaceId")) })));

  app.get("/api/agent-templates", (c) => c.json(AGENT_TEMPLATES));

  app.get("/api/agents/:id", (c) => c.json(getAgent(c.req.param("id"))));

  app.post("/api/agents", async (c) => c.json(await createAgent(await body(c, agentSchema))));

  app.patch("/api/agents/:id", async (c) => c.json(await updateAgent(c.req.param("id"), await body(c, agentSchema.partial()))));

  app.delete("/api/agents/:id", async (c) => {
    await deleteAgent(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/agents/:id/run", async (c) => {
    const agent = getAgent(c.req.param("id"));
    const { prompt } = await body(c, z.object({ prompt: z.string().trim().min(1, "Prompt is required").max(100_000) }));
    if (!agent.enabled) throw conflict(`Agent "${agent.name}" is disabled`);
    return c.json(await startChat({ agentId: agent.id, content: prompt, origin: "api" }));
  });

  /* Repository browser ------------------------------------------------ */

  app.get("/api/agents/:id/files", async (c) => c.json(await listAgentFiles(c.req.param("id"), c.req.query("path") ?? "")));

  app.get("/api/agents/:id/file", async (c) => c.json(await readAgentFile(c.req.param("id"), c.req.query("path") ?? "")));

  app.put("/api/agents/:id/file", async (c) => {
    const { path, content } = await body(c, z.object({ path: z.string().trim().min(1).max(1024), content: z.string() }));
    await writeAgentFile(c.req.param("id"), path, content);
    return c.json({ ok: true });
  });

  app.get("/api/agents/:id/commits", async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 500);
    return c.json(await listAgentCommits(c.req.param("id"), limit));
  });

  /* Routines ---------------------------------------------------------- */

  app.get("/api/routines", (c) => c.json(listRoutines({ agentId: c.req.query("agentId") || undefined })));

  app.post("/api/routines", async (c) => c.json(createRoutine(await body(c, routineSchema))));

  app.patch("/api/routines/:id", async (c) => c.json(updateRoutine(c.req.param("id"), await body(c, routineSchema.partial()))));

  app.delete("/api/routines/:id", (c) => {
    deleteRoutine(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/routines/:id/run", async (c) => c.json(await runRoutineNow(c.req.param("id"))));
}
