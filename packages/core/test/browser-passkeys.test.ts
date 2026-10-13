/**
 * Passkeys in the Godmode browser against a real headless Chromium (skipped when none is installed): a site creates a
 * passkey in an agent's tab, it lands sealed in the vault, other tabs and a restarted browser sign in with it, deleting
 * it in the vault takes it out of the tabs, and agents can't reach the authenticators.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { all, closeDb, openDb } from "../src/db";
import { CdpClient, attachToPage, type PageSession } from "../src/browser/cdp";
import { findChrome } from "../src/browser/chrome";
import { getRunning } from "../src/browser/state";
import { openChatLease, releaseChatLease } from "../src/browser/proxy";
import { passkeysActive, pausePasskeys, resumePasskeys } from "../src/browser/passkeys";
import * as manager from "../src/browser/manager";
import { applyRuntimeSettings } from "../src/services/runtime";
import { updateSettings } from "../src/services/settings";
import { deletePasskey, listPasskeys, passkeysForHost } from "../src/vault/passkeys";
import * as vault from "../src/vault/vault";

const PAGE = `<!doctype html><title>Passkeys</title><script>
const enc = (s) => new TextEncoder().encode(s);
window.register = async (name) => {
  const c = await navigator.credentials.create({ publicKey: {
    challenge: new Uint8Array(32), rp: { name: "Test" }, user: { id: enc(name), name, displayName: name.toUpperCase() },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    authenticatorSelection: { residentKey: "required", userVerification: "required", authenticatorAttachment: "platform" },
  } });
  return { id: c.id, attachment: c.authenticatorAttachment };
};
window.signIn = async () => {
  try {
    const c = await navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32), userVerification: "required", timeout: 3000 } });
    return { id: c.id, user: new TextDecoder().decode(c.response.userHandle) };
  } catch (e) {
    return { error: e.name };
  }
};
</script>`;

const chrome = findChrome();
const b64url = (b64: string) => b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe.skipIf(!chrome)("passkeys in the browser", () => {
  let dataDir: string;
  let site: ReturnType<typeof Bun.serve>;
  let origin: string;
  let profileId: string;
  let agentClient: CdpClient;

  const rb = () => getRunning(profileId)!;

  async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 10_000): Promise<NonNullable<T>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await Promise.resolve(fn()).catch(() => undefined);
      if (v) return v as NonNullable<T>;
      if (Date.now() > deadline) throw new Error("timed out");
      await Bun.sleep(100);
    }
  }

  async function openTab(): Promise<PageSession> {
    const { targetId } = await rb().client.send<{ targetId: string }>("Target.createTarget", { url: `${origin}/` });
    const page = await attachToPage(rb().client, targetId);
    await waitFor(() => page.evaluate<boolean>("document.readyState === 'complete' && typeof signIn === 'function'", { timeoutMs: 1000 }));
    return page;
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "godmode-passkeys-"));
    openDb(loadConfig({ dataDir }).dbPath);
    await vault.setup("correct horse battery staple", false);
    site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } }) });
    // An IP can't be a passkey's site; localhost is a secure context over http.
    origin = `http://localhost:${site.port}`;
    manager.ensureDefaultProfile();
    profileId = manager.createProfile({ name: "Passkeys", workspaceId: null }).id;
    await manager.launchBrowser(profileId, { headless: true });
    await waitFor(() => passkeysActive(profileId));
  }, 60_000);

  afterAll(async () => {
    agentClient?.close();
    releaseChatLease("run_pk");
    await manager.shutdownBrowsers();
    site?.stop(true);
    closeDb();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }, 60_000);

  test("a passkey a site creates in an agent's tab is sealed into the vault", async () => {
    const url = openChatLease({
      runId: "run_pk",
      profileId,
      conversationId: "cnv_pk",
      open: async () => {
        await manager.ensureChatTab(rb(), "cnv_pk");
        return rb();
      },
    });
    const version = (await (await fetch(`${url}/json/version`)).json()) as { webSocketDebuggerUrl: string };
    agentClient = await CdpClient.connect(version.webSocketDebuggerUrl);
    const targetId = await manager.ensureChatTab(rb(), "cnv_pk");
    const { sessionId } = await agentClient.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    await agentClient.send("Page.navigate", { url: `${origin}/` }, sessionId);
    const evaluate = async <T>(expression: string) =>
      (await agentClient.send<{ result: { value: T } }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId)).result.value;
    await waitFor(() => evaluate<boolean>("document.readyState === 'complete' && typeof register === 'function'"));

    const created = await evaluate<{ id: string; attachment: string }>("register('dana@example.com')");
    expect(created.attachment).toBe("platform");
    const [saved] = await waitFor(() => (listPasskeys().length ? listPasskeys() : null));
    expect(saved).toMatchObject({ rpId: "localhost", userName: "dana@example.com", userDisplayName: "DANA@EXAMPLE.COM", profileId, workspaceId: null });
    expect(passkeysForHost("app.localhost", null).map((p) => p.id)).toEqual([saved!.id]);

    const [row] = all<{ private_key_enc: string; credential_id: string }>("SELECT private_key_enc, credential_id FROM passkeys");
    expect(b64url(row!.credential_id)).toBe(created.id);
    expect(row!.private_key_enc).not.toContain("MIG");

    // The agent's endpoint never reaches the authenticators (they hold the private keys).
    await expect(agentClient.send("WebAuthn.enable", {}, sessionId)).rejects.toThrow("only reaches its own chat");
    await expect(agentClient.send("WebAuthn.getCredentials", { authenticatorId: "x" }, sessionId)).rejects.toThrow("only reaches its own chat");
  }, 30_000);

  test("another tab signs in with it", async () => {
    const page = await openTab();
    try {
      const res = await page.evaluate<{ id?: string; user?: string; error?: string }>("signIn()");
      expect(res.user).toBe("dana@example.com");
      expect(res.id).toBe(b64url(all<{ credential_id: string }>("SELECT credential_id FROM passkeys")[0]!.credential_id));
      await waitFor(() => all<{ sign_count: number }>("SELECT sign_count FROM passkeys")[0]!.sign_count > 1);
    } finally {
      await page.detach();
    }
  }, 30_000);

  test("a restarted browser signs in from the vault", async () => {
    releaseChatLease("run_pk");
    agentClient.close();
    await manager.stopBrowser(profileId);
    expect(passkeysActive(profileId)).toBe(false);
    await manager.launchBrowser(profileId, { headless: true });
    await waitFor(() => passkeysActive(profileId));
    const page = await openTab();
    try {
      expect(await page.evaluate<{ user?: string }>("signIn()")).toMatchObject({ user: "dana@example.com" });
    } finally {
      await page.detach();
    }
  }, 60_000);

  test("the idle check sees no attached tabs while the authenticators pause", async () => {
    const attached = async () =>
      (await rb().client.send<{ targetInfos: { type: string; attached: boolean }[] }>("Target.getTargets")).targetInfos.filter((t) => t.type === "page" && t.attached).length;
    await waitFor(async () => (await attached()) > 0);
    await pausePasskeys(profileId);
    expect(await attached()).toBe(0);
    await resumePasskeys(profileId);
    await waitFor(async () => (await attached()) > 0);
    const page = await openTab();
    try {
      expect((await page.evaluate<{ user?: string }>("signIn()")).user).toBe("dana@example.com");
    } finally {
      await page.detach();
    }
  }, 30_000);

  test("a passkey deleted in the vault is gone from open tabs", async () => {
    const page = await openTab();
    try {
      deletePasskey(listPasskeys()[0]!.id);
      await Bun.sleep(800);
      expect((await page.evaluate<{ error?: string }>("signIn()", { timeoutMs: 15_000 })).error).toBe("NotAllowedError");
    } finally {
      await page.detach();
    }
  }, 30_000);

  test("switching passkeys off hands the tabs back to Chrome", async () => {
    applyRuntimeSettings(updateSettings({ browser: { passkeys: false } }));
    expect(passkeysActive(profileId)).toBe(false);
    applyRuntimeSettings(updateSettings({ browser: { passkeys: true } }));
    await waitFor(() => passkeysActive(profileId));
  }, 30_000);
});
