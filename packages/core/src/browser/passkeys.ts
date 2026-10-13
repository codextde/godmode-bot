/**
 * Passkeys in the Godmode browser. Every tab gets a virtual platform authenticator (CDP WebAuthn domain) holding the
 * profile's passkeys from the vault, so a site's "Create a passkey" / "Sign in with a passkey" completes without Chrome's
 * dialogs, a fingerprint or a phone — for agents and for the human in the live view alike. Passkeys sites create are
 * sealed into the vault and reach every tab of the profile; private keys never reach agents (the chat proxy refuses the
 * WebAuthn domain).
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
import { forgetPasskey, passkeysForBrowser, recordPasskeyUse, renamePasskeyUser, savePasskey, type Credential } from "../vault/passkeys";
import { CdpClient, type CdpParams } from "./cdp";
import { allRunning, onBrowserState, type RunningBrowser } from "./state";

const log = logger("passkeys");

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
const same = (a: Credential, b: Credential) =>
  a.signCount === b.signCount && a.privateKey === b.privateKey && (a.userName ?? "") === (b.userName ?? "") && (a.userDisplayName ?? "") === (b.userDisplayName ?? "");

class PasskeyBridge {
  private client: CdpClient | null = null;
  /** sessionId → the tab's authenticator */
  private sessions = new Map<string, { targetId: string; authenticatorId: string }>();
  /** What the authenticators hold, by rp id + credential id: only passkeys the vault has. */
  private loaded = new Map<string, Credential>();
  private offs: (() => void)[] = [];
  /** Our own removals (Chrome reports them as credentialDeleted too), by session + credential id. */
  private removing = new Set<string>();
  /** Every session this connection has open, from the attach event until Chrome reports it detached. */
  private live = new Set<string>();
  private paused = false;
  private stopped = false;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private rb: RunningBrowser,
    private onLost: () => void,
  ) {}

  private get idle(): boolean {
    return this.paused || this.stopped;
  }

  private load() {
    this.loaded = new Map((passkeysForBrowser(this.rb.profileId) ?? []).map((c) => [key(c), c]));
  }

  async start() {
    const client = await CdpClient.connect(this.rb.wsUrl);
    if (this.stopped) return client.close();
    this.client = client;
    this.load();
    this.offs.push(
      client.on("Target.attachedToTarget", (p) => void this.onAttached(p)),
      client.on("Target.detachedFromTarget", (p) => {
        this.sessions.delete(p.sessionId);
        this.live.delete(p.sessionId);
      }),
      client.on("WebAuthn.credentialAdded", (p, sid) => this.onAdded(p.credential, sid)),
      client.on("WebAuthn.credentialAsserted", (p, sid) => this.onAsserted(p.credential, sid)),
      client.on("WebAuthn.credentialDeleted", (p, sid) => this.onDeleted(p.credentialId, sid)),
      client.on("WebAuthn.credentialUpdated", (p, sid) => this.onUpdated(p.credential, sid)),
      bus.on((e) => {
        if (e.type === "entity.changed" && e.entity === "passkeys") this.syncSoon();
      }),
    );
    client.onClose(() => {
      this.sessions.clear();
      this.live.clear();
      if (!this.stopped) this.onLost();
    });
    await this.autoAttach(true);
  }

  private autoAttach(on: boolean) {
    return this.client!.send("Target.setAutoAttach", { autoAttach: on, waitForDebuggerOnStart: on, flatten: true, filter: [{ type: "page", exclude: false }] });
  }

  private async onAttached(p: CdpParams) {
    const client = this.client;
    const { sessionId, targetInfo, waitingForDebugger } = p as { sessionId: string; targetInfo: { targetId: string; type: string; url: string }; waitingForDebugger: boolean };
    if (!client) return;
    const release = () => (waitingForDebugger ? client.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {}) : undefined);
    const detach = () => client.send("Target.detachFromTarget", { sessionId }).catch(() => {});
    this.live.add(sessionId);
    try {
      if (this.idle || targetInfo.type !== "page" || /^(devtools|chrome-extension|chrome-untrusted):/i.test(targetInfo.url)) {
        await release();
        await detach();
        return;
      }
      await client.send("WebAuthn.enable", { enableUI: false }, sessionId);
      const { authenticatorId } = await client.send<{ authenticatorId: string }>("WebAuthn.addVirtualAuthenticator", { options: AUTHENTICATOR }, sessionId);
      this.sessions.set(sessionId, { targetId: targetInfo.targetId, authenticatorId });
      for (const credential of this.loaded.values()) await this.add(sessionId, credential);
      // Paused (idle check) or stopped while this tab was being set up: let go of it like of the others.
      if (this.idle) {
        this.sessions.delete(sessionId);
        await release();
        await detach();
      }
    } catch (err) {
      log.debug(`could not give tab ${targetInfo.targetId} an authenticator`, err);
    } finally {
      await release();
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
    const mark = `${sessionId} ${credentialId}`;
    this.removing.add(mark);
    return this.client
      .send("WebAuthn.removeCredential", { authenticatorId: tab.authenticatorId, credentialId }, sessionId)
      .catch(() => {})
      .finally(() => setTimeout(() => this.removing.delete(mark), 1000));
  }

  /** Give the tabs (but `from`, which has it) the passkey as it is now, replacing their older copy. */
  private async spread(credential: Credential, from?: string) {
    for (const sessionId of [...this.sessions.keys()]) {
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
    const workspaceId = get<{ workspace_id: string | null }>("SELECT workspace_id FROM browser_profiles WHERE id = ?", this.rb.profileId)?.workspace_id ?? null;
    try {
      savePasskey(credential, { workspaceId, profileId: this.rb.profileId, agentId: this.ownerAgent(sessionId) });
    } catch (err) {
      // Not in the vault, so not in `loaded` either: a sync never takes it out of the tab that has it.
      log.warn(`could not save the passkey ${credential.rpId} created in profile ${this.rb.profileId}`, err);
      return;
    }
    log.info(`saved a passkey for ${credential.rpId} (profile ${this.rb.profileId})`);
    this.loaded.set(key(credential), credential);
    void this.spread(credential, sessionId);
  }

  private onAsserted(credential: Credential, sessionId: string | undefined) {
    if (!credential?.rpId) return;
    const known = this.loaded.get(key(credential));
    // Two tabs signing in at once: the counter only goes up.
    if (!known || credential.signCount < known.signCount) return;
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
    if (!credential?.rpId || !this.loaded.has(key(credential))) return;
    this.loaded.set(key(credential), credential);
    renamePasskeyUser(credential.rpId, credential.credentialId, credential.userName ?? "", credential.userDisplayName ?? "");
    void this.spread(credential, sessionId);
  }

  /** The vault's passkeys changed (deleted in the app, used in another tab): bring every tab up to date. */
  private syncSoon() {
    if (this.syncTimer) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      void this.sync().catch((err) => log.debug("passkey sync failed", err));
    }, 300);
  }

  private async sync() {
    if (this.idle || !this.client) return;
    const current = passkeysForBrowser(this.rb.profileId);
    if (!current) return;
    const next = new Map(current.map((c) => [key(c), c]));
    for (const [k, c] of [...this.loaded]) {
      if (next.has(k)) continue;
      this.loaded.delete(k);
      for (const sid of [...this.sessions.keys()]) await this.remove(sid, c.credentialId);
    }
    for (const [k, c] of next) {
      const known = this.loaded.get(k);
      if (known && (same(known, c) || known.signCount > c.signCount)) continue;
      this.loaded.set(k, c);
      await this.spread(c);
    }
  }

  /** Detach from every tab so the idle check sees only other clients; `resume` attaches again. */
  async pause() {
    if (!this.client || this.idle) return;
    this.paused = true;
    await this.autoAttach(false).catch(() => {});
    await Promise.all([...this.live].map((sessionId) => this.client!.send("Target.detachFromTarget", { sessionId }, undefined, 3000).catch(() => {})));
    this.sessions.clear();
  }

  async resume() {
    if (!this.client || !this.paused || this.stopped) return;
    this.load();
    this.paused = false;
    try {
      await this.autoAttach(true);
    } catch (err) {
      this.paused = true;
      throw err;
    }
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
  const bridge: PasskeyBridge = new PasskeyBridge(rb, () => {
    // The bridge's own connection dropped while the browser runs on: start a new one.
    if (bridges.get(rb.profileId) !== bridge) return;
    bridges.delete(rb.profileId);
    bridge.stop();
    if (wanted() && !rb.stopping && !rb.client.closed) startFor(rb);
  });
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

/** Whether passkeys from the vault are in use (the setting is on and the vault is open). */
export function passkeysEnabled(): boolean {
  return wanted();
}
