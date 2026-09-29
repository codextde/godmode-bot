/**
 * Chat tabs: every conversation drives its own tabs of the profile's Chromium, so chats work in parallel in one
 * browser (same cookies and logins) without touching each other's pages. A chat's first tab opens in its own
 * background window; tabs and popups it opens from there belong to it too.
 */
import { isUserPage, type CdpClient } from "./cdp";

export interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  title: string;
  openerId?: string;
  /** Parent target of an iframe target (older Chromium only reports its parent frame, whose id is the same). */
  parentId?: string;
  parentFrameId?: string;
}

interface Chat {
  /** The tab the chat's agent worked in last. */
  current: string | null;
  usedAt: number;
}

const BLANK = /^(about:blank|chrome:\/\/newtab\/?|chrome:\/\/new-tab-page\/?)$/i;

export class TabRegistry {
  private targets = new Map<string, TargetInfo>();
  /** Closed targets: other connections can still report on them for a moment (target ids are never reused). */
  private gone = new Set<string>();
  private owners = new Map<string, string>();
  /** Blank pages a new chat may take: the browser's first window and tabs given back by closed chats. */
  private spares = new Set<string>();
  private chats = new Map<string, Chat>();
  private listeners = new Set<(conversationId: string | null) => void>();

  constructor(client: CdpClient) {
    client.on("Target.targetCreated", (p) => this.learn(p.targetInfo as TargetInfo));
    client.on("Target.targetInfoChanged", (p) => this.learn(p.targetInfo as TargetInfo));
    client.on("Target.targetDestroyed", (p) => this.forget(p.targetId as string));
  }

  /**
   * A target another connection reported first (a popup, say, before Godmode's own connection heard of it). Known
   * targets are left alone: connections lag differently, so their reports can be older than what's known.
   */
  note(info: TargetInfo) {
    if (info?.targetId && !this.targets.has(info.targetId)) this.learn(info);
  }

  private learn(info: TargetInfo) {
    if (!info?.targetId || this.gone.has(info.targetId)) return;
    const known = this.targets.get(info.targetId);
    this.targets.set(info.targetId, { ...known, ...info });
    // Popups stay with the chat that opened them, even after the opener closes.
    if (info.type === "page" && !this.owners.has(info.targetId)) this.ownerOf(info.targetId);
    const owner = this.owners.get(info.targetId);
    if (owner && (!known || known.url !== info.url || known.title !== info.title)) this.changed(owner);
  }

  private forget(targetId: string) {
    this.targets.delete(targetId);
    this.spares.delete(targetId);
    this.gone.add(targetId);
    if (this.gone.size > 1000) this.gone.delete(this.gone.values().next().value!);
    const owner = this.owners.get(targetId);
    if (!owner) return;
    this.owners.delete(targetId);
    const chat = this.chats.get(owner);
    if (chat?.current === targetId) chat.current = null;
    this.changed(owner);
  }

  /** The chat a target belongs to: its own claim, else its opener's (popups) or parent's (iframes). */
  ownerOf(targetId: string, depth = 0): string | null {
    const owner = this.owners.get(targetId);
    if (owner) return owner;
    const t = this.targets.get(targetId);
    const via = t?.parentId ?? t?.parentFrameId ?? t?.openerId;
    if (!t || !via || depth > 8) return null;
    const inherited = this.ownerOf(via, depth + 1);
    if (inherited && t.type === "page") this.claim(targetId, inherited, false);
    return inherited;
  }

  /** Whether a CDP client of `conversationId` may see the target. Workers and browser UI are shared. */
  visibleTo(info: TargetInfo, conversationId: string): boolean {
    this.note(info);
    if (info.type === "page" || info.type === "iframe") return this.ownerOf(info.targetId) === conversationId;
    return info.type !== "tab";
  }

  claim(targetId: string, conversationId: string, focus = true) {
    this.owners.set(targetId, conversationId);
    this.spares.delete(targetId);
    const chat = this.chat(conversationId);
    if (focus || !chat.current) chat.current = targetId;
    chat.usedAt = Date.now();
    this.changed(conversationId);
  }

  /** Offer blank, unclaimed pages to the next chats (the browser just started, or a chat gave its last tab back). */
  addSpares(targetIds: string[]) {
    for (const id of targetIds) if (this.targets.has(id) && !this.owners.has(id)) this.spares.add(id);
  }

  /** The chat's agent works in this tab now (it navigated, typed, clicked or took a screenshot there). */
  focus(conversationId: string, targetId: string) {
    const page = this.pageOf(targetId);
    const chat = this.chat(conversationId);
    chat.usedAt = Date.now();
    if (!page || this.owners.get(page) !== conversationId || chat.current === page) return;
    chat.current = page;
    this.changed(conversationId);
  }

  /** Top-level page an iframe target lives in. */
  pageOf(targetId: string): string | null {
    let id: string | undefined = targetId;
    for (let hops = 0; id && hops < 10; hops++) {
      const t = this.targets.get(id);
      if (!t) return null;
      if (t.type === "page") return id;
      id = t.parentId ?? t.parentFrameId;
    }
    return null;
  }

  pagesOf(conversationId: string): TargetInfo[] {
    const pages: TargetInfo[] = [];
    for (const [id, owner] of this.owners) {
      const t = this.targets.get(id);
      if (owner === conversationId && t && isUserPage(t)) pages.push(t);
    }
    return pages;
  }

  /** The tab the chat works in: the one its agent used last, else its newest. */
  currentPage(conversationId: string): TargetInfo | null {
    const chat = this.chats.get(conversationId);
    const current = chat?.current ? this.targets.get(chat.current) : undefined;
    if (current && this.owners.get(current.targetId) === conversationId) return current;
    return this.pagesOf(conversationId).at(-1) ?? null;
  }

  /**
   * A spare blank page a new chat can take. Only pages offered as spares: a blank tab someone just opened may be a
   * chat's new tab whose createTarget answer is still on its way, or a human's.
   */
  spareBlankPage(): TargetInfo | null {
    for (const id of this.spares) {
      const t = this.targets.get(id);
      if (t && isUserPage(t) && BLANK.test(t.url) && !this.ownerOf(id)) return t;
    }
    return null;
  }

  isBlank(targetId: string): boolean {
    return BLANK.test(this.targets.get(targetId)?.url ?? "");
  }

  userPages(): TargetInfo[] {
    return [...this.targets.values()].filter(isUserPage);
  }

  info(targetId: string): TargetInfo | undefined {
    return this.targets.get(targetId);
  }

  touch(conversationId: string) {
    const chat = this.chats.get(conversationId);
    if (chat) chat.usedAt = Date.now();
  }

  usedAt(conversationId: string): number {
    return this.chats.get(conversationId)?.usedAt ?? 0;
  }

  /** Chats that have tabs open, in the order they opened their first one (tab strips shouldn't reshuffle). */
  openChats(): { conversationId: string; current: TargetInfo; tabs: number; usedAt: number }[] {
    const out = [];
    for (const [conversationId, chat] of this.chats) {
      const current = this.currentPage(conversationId);
      if (!current) continue;
      out.push({ conversationId, current, tabs: this.pagesOf(conversationId).length, usedAt: chat.usedAt });
    }
    return out;
  }

  /** Forget a chat; `keep` (its last tab, now blank) becomes a spare for the next chat. */
  dropChat(conversationId: string, keep?: string) {
    for (const [id, owner] of this.owners) if (owner === conversationId) this.owners.delete(id);
    if (keep) this.addSpares([keep]);
    this.chats.delete(conversationId);
    this.changed(conversationId);
  }

  /** Called with the chat whose tabs changed (null: something else in the browser). */
  onChange(fn: (conversationId: string | null) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private chat(conversationId: string): Chat {
    let chat = this.chats.get(conversationId);
    if (!chat) {
      chat = { current: null, usedAt: Date.now() };
      this.chats.set(conversationId, chat);
    }
    return chat;
  }

  private changed(conversationId: string | null) {
    for (const fn of [...this.listeners]) {
      try {
        fn(conversationId);
      } catch {
        /* listeners must not break the registry */
      }
    }
  }
}
