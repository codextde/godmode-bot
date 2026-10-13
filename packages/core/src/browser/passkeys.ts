/**
 * Passkeys in the Godmode browser. Every tab gets a virtual platform authenticator (CDP WebAuthn domain) holding the
 * vault's passkeys, so a site's "Create a passkey" / "Sign in with a passkey" completes without Chrome's dialogs, a
 * fingerprint or a phone — for agents and for the human in the live view alike. Passkeys sites create are sealed into
 * the vault and appear in every tab and browser of the same scope; private keys never reach agents (the chat proxy
 * refuses the WebAuthn domain).
 *
 * The bridge has its own CDP connection: auto-attach with waitForDebuggerOnStart puts the authenticator in place before
 * a new page runs any script. Its sessions mark every tab as attached, so the idle check pauses it (`pausePasskeys`).
 */
import { get } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { getSettings } from "../services/settings";
import { onSettingsApplied } from "../services/runtime";
import * as vault from "../vault/vault";
import { forgetPasskey, passkeysForBrowser, recordPasskeyUse, renamePasskeyUser, savePasskey, type WebAuthnCredential } from "../vault/passkeys";
import { CdpClient, type CdpParams } from "./cdp";
import { allRunning, onBrowserState, type RunningBrowser } from "./state";

const log = logger("passkeys");

type Credential = WebAuthnCredential & { rpId: string };

const AUTHENTICATOR = {
  protocol: "ctap2",
  ctap2Version: "ctap2_1",
  transport: "internal",
  hasResidentKey: true,
  hasUserVerification: true,
  isUserVerified: true,
  automaticPresenceSimulation: true,
  // Synced passkeys, like the ones of iCloud Keychain or Google Password Manager: some sites refuse device-bound ones.
  defaultBackupEligibility: true,
  defaultBackupState: true,
};

const key = (c: { rpId?: string; credentialId: string }) => `${c.rpId ?? ""} ${c.credentialId}`;

class PasskeyBridge {
  private client: CdpClient | null = null;
  /** sessionId → the tab's authenticator */
  private sessions = new Map<string, { targetId: string; authenticatorId: string }>();
  /** What the authenticators hold, by rp id + credential id. */
  private loaded = new Map<string, Credential>();
  private offs: (() => void)[] = [];
  private removing = new Set<string>();
  private paused = false;
  private stopped = false;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private rb: RunningBrowser) {}

  private get workspaceId(): string | null {
    return get<{ workspace_id: string | null }>("SELECT workspace_id FROM browser_profiles WHERE id = ?", this.rb.profileId)?.workspace_id ?? null;
  }

  async start() {
    const client = await CdpClient.connect(this.rb.wsUrl);
    if (this.stopped) return client.close();
    this.client = client;
    this.loaded = new Map((passkeysForBrowser(this.workspaceId) ?? []).map((c) => [key(c), c]));
    this.offs.push(
      client.on("Target.attachedToTarget", (p) => void this.onAttached(p)),
      client.on("Target.detachedFromTarget", (p) => this.sessions.delete(p.sessionId)),
      client.on("WebAuthn.credentialAdded", (p, sid) => this.onAdded(p.credential, sid)),
      client.on("WebAuthn.credentialAsserted", (p, sid) => this.onAsserted(p.credential, sid)),
      client.on("WebAuthn.credentialDeleted", (p, sid) => this.onDeleted(p.credentialId, sid)),
      client.on("WebAuthn.credentialUpdated", (p, sid) => this.onUpdated(p.credential, sid)),
      bus.on((e) => {
        if (e.type === "entity.changed" && e.entity === "passkeys") this.syncSoon();
      }),
    );
    client.onClose(() => this.sessions.clear());
    await this.autoAttach(true);
  }

  private autoAttach(on: boolean) {
    return this.client!.send("Target.setAutoAttach", { autoAttach: on, waitForDebuggerOnStart: on, flatten: true, filter: [{ type: "page", exclude: false }] });
  }

  private async onAttached(p: CdpParams) {
    const client = this.client;
    const { sessionId, targetInfo, waitingForDebugger } = p as { sessionId: string; targetInfo: { targetId: string; type: string; url: string }; waitingForDebugger: boolean };
    if (!client) return;
    try {
      if (this.paused || targetInfo.type !== "page" || /^(devtools|chrome-extension|chrome-untrusted):/i.test(targetInfo.url)) {
        if (waitingForDebugger) await client.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
        await client.send("Target.detachFromTarget", { sessionId }).catch(() => {});
        return;
      }
      await client.send("WebAuthn.enable", { enableUI: false }, sessionId);
      const { authenticatorId } = await client.send<{ authenticatorId: string }>("WebAuthn.addVirtualAuthenticator", { options: AUTHENTICATOR }, sessionId);
      this.sessions.set(sessionId, { targetId: targetInfo.targetId, authenticatorId });
      for (const credential of this.loaded.values()) await this.add(sessionId, credential);
    } catch (err) {
      log.debug(`could not give tab ${targetInfo.targetId} an authenticator`, err);
    } finally {
      if (waitingForDebugger) await client.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
    }
  }

  private add(sessionId: string, credential: Credential) {
    const tab = this.sessions.get(sessionId);
    if (!tab || !this.client) return Promise.resolve();
    return this.client.send("WebAuthn.addCredential", { authenticatorId: tab.authenticatorId, credential }, sessionId).catch((err) => log.debug("addCredential failed", err));
  }

  private remove(sessionId: string, credentialId: string) {
    const tab = this.sessions.get(sessionId);
    if (!tab || !this.client) return Promise.resolve();
    // Chrome reports our own removals as credentialDeleted too: only a site's signal deletes from the vault.
    const mark = `${sessionId} ${credentialId}`;
    this.removing.add(mark);
    return this.client
      .send("WebAuthn.removeCredential", { authenticatorId: tab.authenticatorId, credentialId }, sessionId)
      .catch(() => {})
      .finally(() => setTimeout(() => this.removing.delete(mark), 1000));
  }

  /** Give the other tabs the passkey as it is now (removing their older copy first). */
  private async spread(credential: Credential, from: string | undefined) {
    for (const sessionId of this.sessions.keys()) {
      if (sessionId === from) continue;
      await this.remove(sessionId, credential.credentialId);
      await this.add(sessionId, credential);
    }
  }

  private ownerAgent(sessionId: string | undefined): string | null {
    const targetId = sessionId ? this.sessions.get(sessionId)?.targetId : undefined;
    const chat = targetId ? this.rb.tabs.ownerOf(targetId) : null;
    return chat ? (get<{ agent_id: string }>("SELECT agent_id FROM conversations WHERE id = ?", chat)?.agent_id ?? null) : null;
  }

  private onAdded(credential: Credential, sessionId: string | undefined) {
    if (!credential?.rpId) return;
    this.loaded.set(key(credential), credential);
    try {
      savePasskey(credential, { workspaceId: this.workspaceId, profileId: this.rb.profileId, agentId: this.ownerAgent(sessionId) });
      log.info(`saved a passkey for ${credential.rpId} (profile ${this.rb.profileId})`);
    } catch (err) {
      log.warn(`could not save the passkey ${credential.rpId} created in profile ${this.rb.profileId}`, err);
    }
    void this.spread(credential, sessionId);
  }

  private onAsserted(credential: Credential, sessionId: string | undefined) {
    if (!credential?.rpId) return;
    this.loaded.set(key(credential), credential);
    recordPasskeyUse(credential.rpId, credential.credentialId, credential.signCount);
    void this.spread(credential, sessionId);
  }

  private onDeleted(credentialId: string, sessionId: string | undefined) {
    if (this.removing.has(`${sessionId} ${credentialId}`)) return;
    const credential = [...this.loaded.values()].find((c) => c.credentialId === credentialId);
    if (!credential) return;
    this.loaded.delete(key(credential));
    forgetPasskey(credential.rpId, credentialId);
    for (const sid of this.sessions.keys()) if (sid !== sessionId) void this.remove(sid, credentialId);
  }

  private onUpdated(credential: Credential, sessionId: string | undefined) {
    if (!credential?.rpId) return;
    this.loaded.set(key(credential), credential);
    renamePasskeyUser(credential.rpId, credential.credentialId, credential.userName ?? "", credential.userDisplayName ?? "");
    void this.spread(credential, sessionId);
  }

  /** The vault's passkeys changed (deleted in the app, created in another browser): bring every tab up to date. */
  private syncSoon() {
    if (this.syncTimer) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      void this.sync().catch((err) => log.debug("passkey sync failed", err));
    }, 300);
  }

  private async sync() {
    if (this.stopped || !this.client) return;
    const current = passkeysForBrowser(this.workspaceId);
    if (!current) return;
    const next = new Map(current.map((c) => [key(c), c]));
    for (const [k, c] of this.loaded) {
      if (next.has(k)) continue;
      this.loaded.delete(k);
      for (const sid of this.sessions.keys()) await this.remove(sid, c.credentialId);
    }
    for (const [k, c] of next) {
      if (this.loaded.has(k)) continue;
      this.loaded.set(k, c);
      for (const sid of this.sessions.keys()) await this.add(sid, c);
    }
  }

  /** Detach from every tab so the idle check sees only other clients; `resume` attaches again. */
  async pause() {
    if (!this.client || this.paused) return;
    this.paused = true;
    await this.autoAttach(false).catch(() => {});
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.client!.send("Target.detachFromTarget", { sessionId }, undefined, 3000).catch(() => {})));
    this.sessions.clear();
  }

  async resume() {
    if (!this.client || !this.paused || this.stopped) return;
    this.paused = false;
    this.loaded = new Map((passkeysForBrowser(this.workspaceId) ?? []).map((c) => [key(c), c]));
    await this.autoAttach(true).catch((err) => log.debug("could not attach to the tabs again", err));
  }

  stop() {
    this.stopped = true;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    for (const off of this.offs) off();
    this.offs = [];
    this.client?.close();
    this.client = null;
    this.sessions.clear();
    this.loaded.clear();
  }
}

const bridges = new Map<string, PasskeyBridge>();

function wanted(): boolean {
  try {
    const s = getSettings().browser;
    return s.enabled && s.passkeys && vault.isUnlocked();
  } catch {
    return false;
  }
}

function startFor(rb: RunningBrowser) {
  if (bridges.has(rb.profileId) || rb.stopping) return;
  const bridge = new PasskeyBridge(rb);
  bridges.set(rb.profileId, bridge);
  bridge.start().catch((err) => {
    log.warn(`passkeys are not available in the browser of profile ${rb.profileId}`, err);
    if (bridges.get(rb.profileId) === bridge) bridges.delete(rb.profileId);
    bridge.stop();
  });
}

function stopFor(profileId: string) {
  bridges.get(profileId)?.stop();
  bridges.delete(profileId);
}

/** Start or stop the bridges to match the setting and the vault (locked = Chrome's own passkey dialogs). */
function reconcile() {
  if (!wanted()) {
    for (const id of [...bridges.keys()]) stopFor(id);
    return;
  }
  for (const rb of allRunning()) if (!rb.stopping && !rb.client.closed) startFor(rb);
}

let installed = false;

/** Follow browsers as they start and stop. Called once by the browser manager. */
export function initPasskeys() {
  if (installed) return;
  installed = true;
  onBrowserState((profileId, rb) => {
    if (!rb) stopFor(profileId);
    else if (wanted()) startFor(rb);
  });
  onSettingsApplied(reconcile);
  bus.on((e) => {
    if (e.type === "vault.status") reconcile();
  });
}

export async function pausePasskeys(profileId: string): Promise<void> {
  await bridges.get(profileId)?.pause();
}

export async function resumePasskeys(profileId: string): Promise<void> {
  await bridges.get(profileId)?.resume();
}

/** Whether the profile's tabs have passkeys from the vault right now. */
export function passkeysActive(profileId: string): boolean {
  return bridges.has(profileId);
}
