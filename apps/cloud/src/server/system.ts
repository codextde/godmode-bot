/** Health of the parts the admin overview's "System" card shows. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { max, sql } from "drizzle-orm";
import { config } from "./config";
import { db, stripeEvents } from "./db";
import { lastMailFailure } from "./mail";
import { relayHub } from "./relay-bridge";
import { getSettings } from "./settings";
import { shared } from "./shared";

export interface SystemStatus {
  version: string;
  publicUrl: string;
  publicUrlConfigured: boolean;
  database: boolean;
  email: { transport: "log" | "smtp"; lastFailure: { at: string; error: string } | null };
  stripe: { connected: boolean; livemode: boolean | null; lastEventAt: string | null };
  /** The Godmode dashboard build (`<uiDir>/index.html`) is there. */
  uiBuild: boolean;
  relay: { links: number; streams: number };
}

/** This app's version from its package.json, read once. */
function appVersion(): string {
  return shared("appVersion", () => {
    try {
      const pkg = JSON.parse(readFileSync(path.join(config().appDir, "package.json"), "utf8")) as { version?: unknown };
      return typeof pkg.version === "string" ? pkg.version : "unknown";
    } catch {
      return "unknown";
    }
  });
}

export async function getSystemStatus(): Promise<SystemStatus> {
  const { publicUrl, publicUrlConfigured, uiDir } = config();
  let database = true;
  let transport: "log" | "smtp" = "log";
  let stripe: SystemStatus["stripe"] = { connected: false, livemode: null, lastEventAt: null };
  try {
    await db.execute(sql`select 1`);
    const [email, billing, [last]] = await Promise.all([
      getSettings("email"),
      getSettings("billing"),
      db.select({ at: max(stripeEvents.receivedAt) }).from(stripeEvents),
    ]);
    transport = email.transport;
    stripe = { connected: billing.stripeSecretKeySet, livemode: billing.livemode, lastEventAt: last?.at ? last.at.toISOString() : null };
  } catch (err) {
    database = false;
    console.error("[system] database check failed:", err instanceof Error ? err.message : err);
  }
  const stats = relayHub().stats();
  return {
    version: appVersion(),
    publicUrl,
    publicUrlConfigured,
    database,
    email: { transport, lastFailure: lastMailFailure() },
    stripe,
    uiBuild: existsSync(path.join(uiDir, "index.html")),
    relay: { links: stats.links, streams: stats.streams },
  };
}
