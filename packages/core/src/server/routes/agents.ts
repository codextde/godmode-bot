import type { Hono } from "hono";
import { EFFORT_OPTIONS, isModelId } from "@godmode/shared";
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
import { listSlashCommands } from "../../runner/commands";
import type { RoutineTrigger } from "@godmode/shared";
import { createRoutine, deleteRoutine, getRoutine, listRoutines, resolveAppTrigger, runRoutineNow, updateRoutine } from "../../services/routines";
import { listEvents, sendTestEvent } from "../../automations/events";
import { rotateWebhookToken } from "../../automations/webhooks";
import { startChat } from "../../services/conversations";
import { dreamOverview, getDream, isDreaming, revertDream, startDream } from "../../memory/dreaming";
import { isMemoryPath } from "../../memory/files";
import { resolveRepoPath } from "../../agents/repo";
import { getSettings } from "../../services/settings";
import { conflict } from "../../util";
import { requireGrant } from "../grants";
import { body, computerTargetSchema, z } from "../validate";

const id = z.string().min(1).max(64);
const DEFAULT_TASK_PROMPT = "Carry out your instructions and report back what you did.";
const modelId = z
  .string()
  .trim()
  .refine((v) => v === "" || isModelId(v), "Invalid model id")
  .optional();

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

const computerSchema = z
  .object({
    enabled: z.boolean(),
    target: computerTargetSchema.nullable(),
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
  model: modelId,
});

export const agentSchema = z.object({
  workspaceId: id.nullable().optional(),
  name: z.string().trim().min(1, "Name is required").max(80),
  avatar: z.string().trim().max(32).optional(),
  color: z.string().trim().max(32).optional(),
  description: z.string().max(2000).optional(),
  instructions: z.string().max(50_000).optional(),
  model: modelId,
  effort: z.enum(EFFORT_OPTIONS).nullable().optional(),
  enabled: z.boolean().optional(),
  permissions: permissionsSchema.optional(),
  browser: browserSchema.optional(),
  computer: computerSchema.optional(),
  mcpServerIds: z.array(id).max(200).optional(),
  inheritMcp: z.boolean().optional(),
  subagents: z.array(subagentSchema).max(20).optional(),
  workingDirectory: z.string().trim().max(4096).nullable().optional(),
  vmId: id.nullable().optional(),
});

const triggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("schedule"), startWindowMinutes: z.number().optional() }),
  z.object({
    type: z.literal("app"),
    connectionId: id,
    toolkit: z.string().trim().max(100).optional(),
    triggerSlug: z.string().trim().min(1, "Choose an app event").max(200),
    triggerName: z.string().trim().max(200).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal("condition"),
    condition: z.string().trim().min(1, "Describe the condition").max(2000),
    checkModel: z.string().trim().max(200).nullable().optional(),
  }),
  z.object({ type: z.literal("webhook") }),
]);

export const routineSchema = z.object({
  agentId: id,
  name: z.string().trim().min(1, "Name is required").max(120),
  trigger: triggerSchema.optional(),
  /** Required for schedule and condition triggers (checked by the service). */
  cron: z.string().trim().max(120).optional(),
  timezone: z.string().trim().max(64).optional(),
  prompt: z.string().trim().min(1, "Prompt is required").max(20_000),
  filter: z.string().trim().max(2000).optional(),
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

  app.post("/api/agents", async (c) => {
    const input = await body(c, agentSchema);
    // Letting an agent read secrets in plain text needs a fresh passphrase confirmation (unless it's already the default).
    if (input.permissions?.secretAccess === "reveal" && getSettings().security.defaultSecretAccess !== "reveal") requireGrant(c);
    return c.json(await createAgent(input));
  });

  app.patch("/api/agents/:id", async (c) => {
    const agentId = c.req.param("id");
    const input = await body(c, agentSchema.partial());
    if (input.permissions?.secretAccess === "reveal" && getAgent(agentId).permissions.secretAccess !== "reveal") requireGrant(c);
    return c.json(await updateAgent(agentId, input));
  });

  app.delete("/api/agents/:id", async (c) => {
    await deleteAgent(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/agents/:id/run", async (c) => {
    const agent = getAgent(c.req.param("id"));
    const { prompt } = await body(c, z.object({ prompt: z.string().trim().max(100_000).optional() }));
    if (!agent.enabled) throw conflict(`Agent "${agent.name}" is disabled`);
    return c.json(await startChat({ agentId: agent.id, content: prompt || DEFAULT_TASK_PROMPT, origin: "api" }));
  });

  app.get("/api/agents/:id/commands", async (c) => c.json(await listSlashCommands(getAgent(c.req.param("id")))));

  /* Repository browser ------------------------------------------------ */

  app.get("/api/agents/:id/files", async (c) => c.json(await listAgentFiles(c.req.param("id"), c.req.query("path") ?? "")));

  app.get("/api/agents/:id/file", async (c) => c.json(await readAgentFile(c.req.param("id"), c.req.query("path") ?? "")));

  app.put("/api/agents/:id/file", async (c) => {
    const { path, content } = await body(c, z.object({ path: z.string().trim().min(1).max(1024), content: z.string() }));
    const agent = getAgent(c.req.param("id"));
    // A dream owns the memory files while it runs (its rollback or undo would take the edit with it).
    if (isMemoryPath(resolveRepoPath(agent.repoPath, path).rel) && isDreaming(agent.id)) {
      throw conflict(`${agent.name} is dreaming (consolidating its memory) — edit it when the dream has ended, or cancel the dream.`);
    }
    await writeAgentFile(agent.id, path, content);
    return c.json({ ok: true });
  });

  app.get("/api/agents/:id/commits", async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 500);
    return c.json(await listAgentCommits(c.req.param("id"), limit));
  });

  /* Dreams (background memory consolidation) ------------------------- */

  app.get("/api/agents/:id/dreams", (c) => c.json(dreamOverview(c.req.param("id"))));

  app.post("/api/agents/:id/dreams", async (c) => c.json(await startDream(c.req.param("id"), "manual")));

  app.get("/api/dreams/:id", (c) => c.json(getDream(c.req.param("id"))));

  app.post("/api/dreams/:id/revert", async (c) => c.json(await revertDream(c.req.param("id"))));

  /* Routines ---------------------------------------------------------- */

  app.get("/api/routines", (c) => c.json(listRoutines({ agentId: c.req.query("agentId") || undefined })));

  app.post("/api/routines", async (c) => {
    const input = await body(c, routineSchema);
    const trigger = await resolveAppTrigger(input.trigger as RoutineTrigger | undefined, input.agentId);
    return c.json(createRoutine({ ...input, trigger }));
  });

  app.patch("/api/routines/:id", async (c) => {
    const routineId = c.req.param("id");
    const patch = await body(c, routineSchema.partial());
    const trigger = patch.trigger
      ? await resolveAppTrigger(patch.trigger as RoutineTrigger, patch.agentId ?? getRoutine(routineId).agentId)
      : undefined;
    return c.json(updateRoutine(routineId, { ...patch, trigger }));
  });

  app.delete("/api/routines/:id", (c) => {
    deleteRoutine(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/routines/:id/run", async (c) => c.json(await runRoutineNow(c.req.param("id"))));

  /* Automation events -------------------------------------------------- */

  const limitParam = (value: string | undefined) => (value ? Number(value) || undefined : undefined);

  app.get("/api/routines/:id/events", (c) => {
    const routine = getRoutine(c.req.param("id"));
    return c.json(listEvents({ routineId: routine.id, limit: limitParam(c.req.query("limit")) }));
  });

  app.get("/api/automation-events", (c) =>
    c.json(listEvents({ routineId: c.req.query("routineId") || undefined, limit: limitParam(c.req.query("limit")) })),
  );

  app.post("/api/routines/:id/test-event", async (c) => {
    const { payload } = await body(c, z.object({ payload: z.unknown().optional() }));
    const { event } = await sendTestEvent(c.req.param("id"), payload);
    return c.json(event);
  });

  app.post("/api/routines/:id/webhook/rotate", (c) => c.json(rotateWebhookToken(c.req.param("id"))));
}
