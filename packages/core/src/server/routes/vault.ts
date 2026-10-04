import type { Context, Hono } from "hono";
import { getConnInfo } from "hono/bun";
import { all } from "../../db";
import * as vault from "../../vault/vault";
import {
  createCredential,
  deleteCredential,
  getCredential,
  listCredentials,
  updateCredential,
} from "../../vault/credentials";
import { createTotp, currentCodes, deleteTotp, importTotpUris, listTotp, updateTotp } from "../../vault/totp";
import { importPasswords, MAX_IMPORT_BYTES, previewPasswordImport } from "../../vault/passwordImport";
import { audit } from "../../services/audit";
import { updateSettings } from "../../services/settings";
import { clientIp as relayedClientIp, isRelayed, rateLimitLogin, resetLoginAttempts, setDashboardPassword, type CloudRelayEnv } from "../auth";
import { issueGrant, requireGrant, verifyVaultPassphrase } from "../grants";
import { body, z } from "../validate";
import { badRequest, HttpError } from "../../util";

/** App-level secrets the UI always lists (set or not). */
const WELL_KNOWN_SECRETS = ["anthropic_api_key", "openai_api_key", "elevenlabs_api_key", "composio_api_key", "browser_use_api_key"];
const SECRET_KEY = /^[a-z0-9_]{2,64}$/;

/**
 * Peer address of the connection, used to key passphrase rate limiting. Deliberately ignores X-Forwarded-For,
 * which any client can set to get a fresh rate-limit bucket per request. In-process requests have no peer.
 * Requests relayed by Godmode Cloud report the cloud's idea of the address (for the audit log only).
 */
function clientIp(c: Context): string {
  if (isRelayed(c)) return relayedClientIp(c);
  try {
    return getConnInfo(c).remote.address ?? "local";
  } catch {
    return "local";
  }
}

/** Passphrase attempts relayed by Godmode Cloud share one bucket per channel: the cloud chooses the address it reports. */
function limitKey(c: Context): string {
  return isRelayed(c) ? `vault:${(c.env as CloudRelayEnv).channel}` : `vault:${clientIp(c)}`;
}

/** `workspaceId` query param: "all" (default) | "global" | <workspace id>. */
function scopeParam(c: Context): string | null | "all" {
  const raw = c.req.query("workspaceId");
  if (!raw || raw === "all") return "all";
  if (raw === "global") return null;
  return raw;
}

function secretKeyParam(c: Context): string {
  const key = c.req.param("key") ?? "";
  if (!SECRET_KEY.test(key)) throw badRequest("Secret key must be 2–64 characters of a–z, 0–9 and _");
  return key;
}

const workspaceIdSchema = z.string().min(1).max(100).nullable().optional();
const idSchema = z.string().min(1).max(100);

const credentialSchema = z.object({
  workspaceId: workspaceIdSchema,
  name: z.string().trim().min(1).max(200),
  url: z.string().max(2048).optional(),
  domains: z.array(z.string().max(253)).max(100).optional(),
  username: z.string().max(512).optional(),
  // null clears the stored value (same as ""); omitted keeps it.
  password: z.string().max(4096).nullable().optional(),
  notes: z.string().max(20_000).nullable().optional(),
  totpId: idSchema.nullable().optional(),
  tags: z.array(z.string().max(64)).max(50).optional(),
});

const totpSchema = z.object({
  workspaceId: workspaceIdSchema,
  issuer: z.string().max(200),
  accountName: z.string().max(512).optional(),
  secret: z.string().min(1).max(1024),
  algorithm: z.enum(["SHA1", "SHA256", "SHA512"]).optional(),
  digits: z.number().int().min(6).max(8).optional(),
  period: z.number().int().min(1).max(3600).optional(),
  credentialId: idSchema.nullable().optional(),
});

const nullToEmpty = (v: string | null | undefined) => (v === null ? "" : v);

/** Multipart upload of a password export: `file`, optional `workspaceId` (empty = global). */
async function passwordExportUpload(c: Context): Promise<{ data: Uint8Array; workspaceId: string | null; form: FormData }> {
  const tooLarge = () => new HttpError(413, "The export is larger than 512 MB", "too_large");
  if (Number(c.req.header("content-length") ?? 0) > MAX_IMPORT_BYTES + 1024 * 1024) throw tooLarge();
  if (!(c.req.header("content-type") ?? "").includes("multipart/form-data")) {
    throw badRequest("Upload the export as multipart/form-data with a `file` field");
  }
  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    throw badRequest("Could not read the uploaded file");
  }
  const file = form.get("file");
  if (!(file instanceof Blob)) throw badRequest("Choose an export file to import");
  if (file.size > MAX_IMPORT_BYTES) throw tooLarge();
  const workspaceId = form.get("workspaceId");
  return { data: new Uint8Array(await file.arrayBuffer()), workspaceId: typeof workspaceId === "string" && workspaceId ? workspaceId : null, form };
}

const importIdsSchema = z.array(z.number().int().min(0)).max(100_000);

export function registerVaultRoutes(app: Hono): void {
  /* ---------------------------------------------------------------- */
  /* Vault lifecycle                                                   */
  /* ---------------------------------------------------------------- */

  app.get("/api/vault/status", (c) => c.json(vault.status()));

  app.post("/api/vault/setup", async (c) => {
    const input = await body(
      c,
      z.object({
        passphrase: z.string().min(8).max(1024),
        rememberDevice: z.boolean(),
        userName: z.string().trim().max(100).optional(),
        // "" = no dashboard password
        dashboardPassword: z.union([z.literal(""), z.string().min(8).max(512)]).optional(),
      }),
    );
    const status = await vault.setup(input.passphrase, input.rememberDevice);
    if (input.userName) updateSettings({ general: { userName: input.userName } });
    if (input.dashboardPassword) {
      setDashboardPassword(input.dashboardPassword);
      updateSettings({ server: { hasDashboardPassword: true } });
    }
    audit("user", "vault.setup", null, { rememberDevice: input.rememberDevice, dashboardPassword: !!input.dashboardPassword });
    return c.json(status);
  });

  app.post("/api/vault/unlock", async (c) => {
    const ip = clientIp(c);
    const key = limitKey(c);
    rateLimitLogin(key);
    const { passphrase } = await body(c, z.object({ passphrase: z.string().min(1).max(1024) }));
    if (!vault.isInitialized()) throw badRequest("Vault not initialized");
    const status = await vault.unlock(passphrase).catch((err: unknown) => {
      audit("user", "vault.unlock_failed", null, { ip });
      throw err;
    });
    resetLoginAttempts(key);
    audit("user", "vault.unlock", null, { ip });
    return c.json(status);
  });

  app.post("/api/vault/lock", (c) => {
    vault.lock();
    audit("user", "vault.lock");
    return c.json(vault.status());
  });

  app.post("/api/vault/passphrase", async (c) => {
    const ip = clientIp(c);
    const key = limitKey(c);
    rateLimitLogin(key);
    const { current, next } = await body(c, z.object({ current: z.string().min(1).max(1024), next: z.string().min(8).max(1024) }));
    if (!vault.isInitialized()) throw badRequest("Vault not initialized");
    const wasUnlocked = vault.isUnlocked();
    await vault.changePassphrase(current, next).catch((err: unknown) => {
      audit("user", "vault.passphrase_change_failed", null, { ip });
      throw err;
    });
    resetLoginAttempts(key);
    // Refresh the device key so auto-unlock keeps working with the new passphrase.
    if (vault.status().rememberDevice) await vault.setRememberDevice(true);
    // changePassphrase leaves the data key in memory; a vault that was locked stays locked.
    if (!wasUnlocked) vault.lock();
    audit("user", "vault.passphrase_changed", null, { ip });
    return c.json({ ok: true as const });
  });

  /** Re-enter the vault passphrase → short-lived grant for revealing secrets (does not change the lock state). */
  app.post("/api/vault/grant", async (c) => {
    const ip = clientIp(c);
    const key = limitKey(c);
    rateLimitLogin(key);
    const { passphrase } = await body(c, z.object({ passphrase: z.string().min(1).max(1024) }));
    if (!vault.isInitialized()) throw badRequest("Vault not initialized");
    if (!verifyVaultPassphrase(passphrase)) {
      audit("user", "vault.grant_failed", null, { ip });
      throw badRequest("Wrong passphrase");
    }
    resetLoginAttempts(key);
    audit("user", "vault.grant", null, { ip });
    return c.json(issueGrant());
  });

  app.post("/api/vault/remember", async (c) => {
    const { remember } = await body(c, z.object({ remember: z.boolean() }));
    // Storing the vault key on this device lets anything running as this user read it: confirm with the passphrase.
    if (remember && !vault.status().rememberDevice) requireGrant(c);
    await vault.setRememberDevice(remember);
    audit("user", "vault.remember_device", null, { remember });
    return c.json(vault.status());
  });

  /* ---------------------------------------------------------------- */
  /* App secrets (API keys). Values are never returned.                */
  /* ---------------------------------------------------------------- */

  app.get("/api/vault/secrets", (c) => {
    const stored = new Map(
      all<{ key: string; updated_at: string }>("SELECT key, updated_at FROM secrets").map((r) => [r.key, r.updated_at] as const),
    );
    const extra = [...stored.keys()].filter((k) => !WELL_KNOWN_SECRETS.includes(k)).sort();
    return c.json(
      [...WELL_KNOWN_SECRETS, ...extra].map((key) => ({ key, set: stored.has(key), updatedAt: stored.get(key) ?? null })),
    );
  });

  app.put("/api/vault/secrets/:key", async (c) => {
    const key = secretKeyParam(c);
    const { value } = await body(c, z.object({ value: z.string().max(16_384) }));
    const trimmed = value.trim();
    vault.setAppSecret(key, trimmed || null);
    audit("user", trimmed ? "secret.set" : "secret.delete", key);
    return c.json({ ok: true as const });
  });

  app.delete("/api/vault/secrets/:key", (c) => {
    const key = secretKeyParam(c);
    vault.setAppSecret(key, null);
    audit("user", "secret.delete", key);
    return c.json({ ok: true as const });
  });

  /* ---------------------------------------------------------------- */
  /* Credentials (website logins)                                      */
  /* ---------------------------------------------------------------- */

  // Comparing an export with saved passwords would answer "is this the password?", so both steps need a grant.
  app.post("/api/credentials/import/preview", async (c) => {
    requireGrant(c);
    const { data, workspaceId } = await passwordExportUpload(c);
    return c.json(previewPasswordImport(data, workspaceId));
  });

  app.post("/api/credentials/import", async (c) => {
    requireGrant(c);
    const { data, workspaceId, form } = await passwordExportUpload(c);
    let raw: unknown;
    try {
      raw = JSON.parse(String(form.get("ids") ?? "[]"));
    } catch {
      throw badRequest("`ids` must be a JSON array of row ids");
    }
    const ids = importIdsSchema.safeParse(raw);
    if (!ids.success) throw badRequest("`ids` must be a JSON array of row ids");
    const { source, ...result } = importPasswords(data, workspaceId, ids.data);
    audit("user", "credential.import", null, { ...result, source, workspaceId });
    return c.json(result);
  });

  app.get("/api/credentials", (c) => c.json(listCredentials({ workspaceId: scopeParam(c), search: c.req.query("search") || undefined })));

  app.get("/api/credentials/:id", (c) => c.json(getCredential(c.req.param("id"))));

  app.post("/api/credentials/:id/reveal", (c) => {
    requireGrant(c);
    const credential = getCredential(c.req.param("id"), { reveal: true });
    audit("user", "credential.reveal", credential.id, { name: credential.name });
    return c.json({ password: credential.password ?? null, notes: credential.notes ?? null });
  });

  app.post("/api/credentials", async (c) => {
    const input = await body(c, credentialSchema);
    const credential = createCredential({ ...input, password: nullToEmpty(input.password), notes: nullToEmpty(input.notes) });
    audit("user", "credential.create", credential.id, { name: credential.name });
    return c.json(credential);
  });

  app.patch("/api/credentials/:id", async (c) => {
    const input = await body(c, credentialSchema.partial());
    const credential = updateCredential(c.req.param("id"), {
      ...input,
      password: nullToEmpty(input.password),
      notes: nullToEmpty(input.notes),
    });
    audit("user", "credential.update", credential.id, { name: credential.name, fields: Object.keys(input) });
    return c.json(credential);
  });

  app.delete("/api/credentials/:id", (c) => {
    const credential = getCredential(c.req.param("id"));
    deleteCredential(credential.id);
    audit("user", "credential.delete", credential.id, { name: credential.name });
    return c.json({ ok: true as const });
  });

  /* ---------------------------------------------------------------- */
  /* TOTP (2FA)                                                        */
  /* ---------------------------------------------------------------- */

  app.get("/api/totp", (c) => c.json(listTotp({ workspaceId: scopeParam(c), search: c.req.query("search") || undefined })));

  app.get("/api/totp/codes", (c) => {
    const raw = c.req.query("ids");
    const ids = raw
      ? raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    return c.json(currentCodes(ids));
  });

  app.post("/api/totp/import", async (c) => {
    const input = await body(
      c,
      z.object({ workspaceId: workspaceIdSchema, uris: z.array(z.string().max(100_000)).min(1).max(1000) }),
    );
    const result = importTotpUris(input);
    audit("user", "totp.import", null, {
      imported: result.imported.length,
      skipped: result.skipped.length,
      workspaceId: input.workspaceId ?? null,
    });
    return c.json(result);
  });

  app.post("/api/totp", async (c) => {
    const input = await body(c, totpSchema);
    const entry = createTotp(input);
    audit("user", "totp.create", entry.id, { issuer: entry.issuer, accountName: entry.accountName });
    return c.json(entry);
  });

  app.patch("/api/totp/:id", async (c) => {
    const input = await body(c, totpSchema.partial());
    const entry = updateTotp(c.req.param("id"), input);
    audit("user", "totp.update", entry.id, { issuer: entry.issuer, fields: Object.keys(input) });
    return c.json(entry);
  });

  app.delete("/api/totp/:id", (c) => {
    const id = c.req.param("id");
    deleteTotp(id);
    audit("user", "totp.delete", id);
    return c.json({ ok: true as const });
  });
}
