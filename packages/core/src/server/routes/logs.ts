import type { Hono } from "hono";
import type { LogLevel } from "@godmode/shared";
import { buildLogReport, clearLogs, listLogEntries, logOverview } from "../../diagnostics/logs";
import { logger } from "../../log";
import { body, z } from "../validate";

const ui = logger("ui");
const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];
/** UI error reports per minute; a render loop throwing on every frame must not flood the log. */
const CLIENT_ENTRIES_PER_MINUTE = 60;

const clientLogSchema = z.object({
  entries: z
    .array(
      z.object({
        level: z.enum(["info", "warn", "error"]),
        msg: z.string().min(1).max(2000),
        stack: z.string().max(8000).optional(),
        data: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .max(50),
});

let windowStart = 0;
let windowCount = 0;
let dropped = 0;

function admit(): boolean {
  const now = Date.now();
  if (now - windowStart >= 60_000) {
    if (dropped) ui.warn("dropped UI error reports (too many in one minute)", { dropped });
    windowStart = now;
    windowCount = 0;
    dropped = 0;
  }
  if (windowCount >= CLIENT_ENTRIES_PER_MINUTE) {
    dropped++;
    return false;
  }
  windowCount++;
  return true;
}

export function registerLogRoutes(app: Hono) {
  app.get("/api/logs", (c) => c.json(logOverview()));

  app.get("/api/logs/entries", (c) => {
    const level = c.req.query("level") as LogLevel | undefined;
    return c.json(
      listLogEntries({
        level: level && LEVELS.includes(level) ? level : undefined,
        search: c.req.query("search"),
        limit: Number(c.req.query("limit")) || undefined,
      }),
    );
  });

  app.get("/api/logs/report", (c) => {
    const text = buildLogReport(c.req.query("full") === "1" ? Infinity : undefined);
    return c.body(text, 200, { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" });
  });

  app.delete("/api/logs", (c) => {
    clearLogs();
    return c.json({ ok: true });
  });

  app.post("/api/logs/client", async (c) => {
    const { entries } = await body(c, clientLogSchema);
    for (const e of entries) {
      if (!admit()) continue;
      ui[e.level](e.msg, { ...e.data, ...(e.stack ? { err: { message: e.msg, stack: e.stack } } : {}) });
    }
    return c.json({ ok: true });
  });
}
