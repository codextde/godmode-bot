/**
 * Process start-up of Godmode Cloud: environment, database, migrations, first-run data, the setup banner, then one
 * HTTP server (server/app.ts) that serves the relay itself and everything else through Next.
 *
 * Development: `pnpm --filter @godmode/cloud dev` (tsx). Production: `node dist/server.mjs` (scripts/build-server.mjs).
 */
import next from "next";
import { existsSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import path from "node:path";
import { config, normalizePublicUrl } from "@/server/config";
import { closeDb, pool } from "@/server/db";
import { runHousekeeping } from "@/server/housekeeping";
import { bootstrapData, ensureSetupCode, isSetupComplete } from "@/server/setup";
import { createCloudServer } from "./app";
import { migrate } from "./migrate";

const HOUR = 60 * 60_000;

// apps/cloud in development (this file is server/main.ts), /app in the image (dist/server.mjs). Never cwd alone:
// the image starts from "/".
const dir = path.resolve(process.env.CLOUD_APP_DIR?.trim() || path.join(import.meta.dirname, ".."));
process.env.CLOUD_APP_DIR = dir;
for (const name of [".env.local", ".env"]) {
  const file = path.join(dir, name);
  // Variables already set win over the files.
  if (existsSync(file)) process.loadEnvFile(file);
}
const dev = process.env.NODE_ENV !== "production";

function warnOnDomainMismatch(): void {
  const domain = normalizePublicUrl(process.env.DOMAIN ?? "");
  const coolify = normalizePublicUrl(process.env.SERVICE_URL_CLOUD ?? "");
  if (domain && coolify && domain !== coolify) {
    console.warn(`[cloud] DOMAIN (${domain}) and SERVICE_URL_CLOUD (${coolify}) differ. Using ${domain}; links and sign-in only work there.`);
  }
}

async function waitForDatabase(): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (let attempt = 0; ; attempt++) {
    try {
      await pool().query("select 1");
      return;
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`The database did not answer within 60 seconds: ${err instanceof Error ? err.message : err}`);
      if (attempt === 0) console.log("[cloud] waiting for the database…");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

function banner(lines: string[]): string {
  const width = Math.max(...lines.map((l) => l.length));
  const rule = "─".repeat(width + 4);
  return [`┌${rule}┐`, ...lines.map((l) => `│  ${l.padEnd(width)}  │`), `└${rule}┘`].join("\n");
}

async function announceSetup(): Promise<void> {
  const { publicUrl, dataDir } = config();
  const code = await ensureSetupCode();
  if (code) {
    console.log(
      banner([
        "Godmode Cloud is not set up yet.",
        "",
        `Open ${publicUrl}/setup and enter this setup code:`,
        "",
        `    ${code}`,
        "",
        `It is also saved in ${path.join(dataDir, "setup-code.txt")}.`,
      ]),
    );
  } else if (!(await isSetupComplete())) {
    console.log(
      banner([
        "Setup of Godmode Cloud was started but is not finished.",
        `Sign in at ${publicUrl}/login to continue it.`,
        "Until e-mail is set up, sign-in links are printed to this log.",
      ]),
    );
  }
}

function listen(server: Server, port: number, hostname: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const cfg = config();
  warnOnDomainMismatch();
  if (!cfg.publicUrlConfigured) console.warn(`[cloud] DOMAIN is not set; assuming ${cfg.publicUrl}.`);
  await waitForDatabase();
  await migrate();
  await bootstrapData();
  await announceSetup();

  let handle: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null = null;
  const cloud = createCloudServer({
    dev,
    nextHandler: (req, res) => {
      if (handle) return handle(req, res);
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8", "retry-after": "2", "cache-control": "no-store" });
      res.end("Godmode Cloud is starting. Try again in a moment.");
    },
    nextUpgradeDevPassthrough: dev,
  });
  // Listening before Next is ready lets /api/health and the relay answer while Next prepares.
  await listen(cloud.server, cfg.port, cfg.hostname);
  console.log(`[cloud] listening on ${cfg.hostname}:${cfg.port}, public address ${cfg.publicUrl}${dev ? " (development)" : ""}`);

  const app = next({ dev, dir, hostname: cfg.hostname, port: cfg.port, httpServer: cloud.server });
  await app.prepare();
  handle = app.getRequestHandler();
  console.log("[cloud] ready");

  const housekeeping = () => runHousekeeping().catch((err: unknown) => console.error("[cloud] housekeeping failed:", err));
  setTimeout(housekeeping, 60_000).unref();
  setInterval(housekeeping, 6 * HOUR).unref();

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[cloud] ${signal}: shutting down`);
    setTimeout(() => process.exit(1), 10_000).unref();
    try {
      await cloud.close();
      await app.close().catch(() => {});
      await closeDb();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

// One tenant's broken promise must not end every link and session in this process.
process.on("unhandledRejection", (reason) => console.error("[cloud] unhandled rejection:", reason));

main().catch((err: unknown) => {
  console.error("[cloud] could not start:", err);
  process.exit(1);
});
