/**
 * Type a secret (password, TOTP code, username) into a page over CDP without it ever passing through
 * the model. The field is located in an isolated JS world (page scripts can't see or tamper with our
 * code), focused, cleared and then filled with `Input.insertText`, which behaves like real typing.
 *
 * Never log or return the text: results only describe *which* field was filled.
 *
 * Fills are bound to the login's sites: the document that owns the target field (main page, same-origin
 * iframe or out-of-process iframe) must be https on one of `allowedHosts` (or plain http on one of
 * `httpHosts`, i.e. the login's own http:// URL) — checked when the field is found and again right before
 * typing — so a prompt-injected page cannot get a secret typed into a foreign site.
 */
import { domainMatches, hostnameOf, randomToken } from "../util";
import { PageSession, attachToPage, pickActivePage, type CdpClient } from "./cdp";

export type FillKind = "username" | "password" | "totp" | "text";

export interface FillOptions {
  text: string;
  kind?: FillKind;
  selector?: string;
  submit?: boolean;
  /** Sites (and their subdomains) the field may belong to; only over https. Empty = refuse everything. */
  allowedHosts: string[];
  /** Hosts additionally allowed over plain http (exact host match). */
  httpHosts?: string[];
}

/** Fill binding for a saved login: its domains + URL host (https), and the URL host over http if the URL is http://. */
export function loginFillScope(login: { url: string; domains: string[] }): { allowedHosts: string[]; httpHosts: string[] } {
  const urlHost = login.url ? hostnameOf(login.url) : "";
  const allowedHosts = [...new Set([...login.domains.map((d) => hostnameOf(d)), urlHost].filter(Boolean))];
  const httpHosts = urlHost && /^http:\/\//i.test(login.url.trim()) ? [urlHost] : [];
  return { allowedHosts, httpHosts };
}

/** Why a field in a document of `origin` may not receive the secret, or null when it may. */
export function originRefusal(origin: string, opts: Pick<FillOptions, "allowedHosts" | "httpHosts">): string | null {
  let url: URL | null = null;
  try {
    url = origin && origin !== "null" ? new URL(origin) : null;
  } catch {
    url = null;
  }
  const sites = opts.allowedHosts.length ? opts.allowedHosts.join(", ") : "none";
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
    return `Refusing to fill: the field is in a document without a web origin (${origin || "unknown"}). This login may only be filled on ${sites}.`;
  }
  const host = url.hostname;
  if (url.protocol === "http:") {
    if ((opts.httpHosts ?? []).some((h) => hostnameOf(h) === hostnameOf(host))) return null;
    const onSite = opts.allowedHosts.some((d) => domainMatches(host, d));
    return onSite
      ? `Refusing to fill over an insecure connection (${url.origin}); this login's saved URL is https. Open the https:// page instead.`
      : `Refusing to fill: the field is on ${url.origin}, which is not a site of this login (${sites}). Navigate to the login's own site first.`;
  }
  if (opts.allowedHosts.some((d) => domainMatches(host, d))) return null;
  return `Refusing to fill: the field is on ${url.origin}, which is not a site of this login (${sites}). Navigate to the login's own site first.`;
}

export interface FillResult {
  ok: boolean;
  url: string;
  detail: string;
}

interface LocateResult {
  status: "ok" | "not_found" | "bad_selector" | "not_editable" | "incompatible" | "nothing_focused";
  mode?: "single" | "split";
  count?: number;
  via?: "selector" | "focused" | "auto";
  desc?: string;
  /** Origin of the document that owns the field (or the first box). */
  origin?: string;
}

/* ------------------------------------------------------------------ */
/* In-page scripts (run in an isolated world; state kept on its global) */
/* ------------------------------------------------------------------ */

const LOCATE = String.raw`(args) => {
  const { kind, selector, stateKey, allowFocused } = args;
  const TEXT_TYPES = new Set(["", "text", "email", "password", "tel", "number", "search", "url"]);
  const USER_RE = /user|e-?mail|login|account|identifier|benutzer|nutzer|anmelde|usuario|utilisateur/;
  const OTP_RE = /one[-_ ]?time|otp|totp|2fa|mfa|two[-_ ]?factor|verification|verify|security[-_ ]?code|auth(entication)?[-_ ]?code|\bcode\b|token|\bpin\b/;
  const typeOf = (el) => (el.getAttribute("type") || "text").toLowerCase();
  const isEditable = (el) => {
    if (!el || el.nodeType !== 1 || el.disabled || el.readOnly) return false;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName === "INPUT") return TEXT_TYPES.has(typeOf(el));
    return !!el.isContentEditable;
  };
  const isVisible = (el) => {
    const win = el.ownerDocument && el.ownerDocument.defaultView;
    if (!win) return false;
    const st = win.getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || st.visibility === "collapse") return false;
    const r = el.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2;
  };
  const attrText = (el) => {
    const parts = ["name", "id", "autocomplete", "placeholder", "aria-label", "data-testid"].map((a) => el.getAttribute(a) || "");
    try { for (const l of el.labels || []) parts.push((l.textContent || "").slice(0, 80)); } catch {}
    return parts.join(" ").toLowerCase();
  };
  const describe = (el) => {
    let d = el.tagName.toLowerCase();
    if (el.tagName === "INPUT") d += "[type=" + typeOf(el) + "]";
    if (el.id) d += "#" + el.id;
    else if (el.getAttribute("name")) d += "[name=" + el.getAttribute("name") + "]";
    return d.slice(0, 80);
  };
  const originOf = (el) => {
    try { const w = el.ownerDocument.defaultView; return w ? String(w.origin) : "null"; } catch { return "null"; }
  };
  const kindOk = (el, k) => {
    const t = el.tagName === "INPUT" ? typeOf(el) : "";
    // Passwords only ever go into real password inputs (a visible text input named "password" could be read back).
    if (k === "password") return el.tagName === "INPUT" && t === "password";
    if (k === "username") return el.tagName === "INPUT" && ["", "text", "email", "tel"].includes(t);
    if (k === "totp") return el.tagName === "INPUT" && (t !== "password" || OTP_RE.test(attrText(el)) || el.getAttribute("autocomplete") === "one-time-code");
    return true;
  };

  // Every searchable root: the document, open shadow roots and same-origin frames (bounded).
  const roots = [];
  const collect = (root, depth) => {
    if (depth > 6 || roots.length > 300) return;
    roots.push(root);
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) collect(el.shadowRoot, depth + 1);
      if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
        try {
          const d = el.contentDocument;
          if (d && d.documentElement) collect(d, depth + 1);
        } catch {}
      }
    }
  };
  collect(document, 0);
  const all = (sel) => roots.flatMap((r) => { try { return [...r.querySelectorAll(sel)]; } catch { return []; } });
  const deepActive = () => {
    let a = document.activeElement;
    for (let i = 0; a && i < 20; i++) {
      if (a.shadowRoot && a.shadowRoot.activeElement) { a = a.shadowRoot.activeElement; continue; }
      if (a.tagName === "IFRAME" || a.tagName === "FRAME") {
        let inner = null;
        try { inner = a.contentDocument && a.contentDocument.activeElement; } catch {}
        if (inner && inner !== a.contentDocument.body) { a = inner; continue; }
      }
      break;
    }
    return a;
  };
  const found = (el, via) => {
    globalThis[stateKey] = { el, boxes: null };
    return { status: "ok", mode: "single", via, desc: describe(el), origin: originOf(el) };
  };

  if (selector) {
    let matches;
    try { document.querySelector(selector); } catch { return { status: "bad_selector" }; }
    matches = all(selector);
    let el = matches.find(isVisible) || matches[0];
    if (!el) return { status: "not_found" };
    if (!isEditable(el)) {
      const inner = el.tagName === "LABEL" && el.control ? el.control : el.querySelector && el.querySelector("input, textarea, [contenteditable='true'], [contenteditable='']");
      if (inner && isEditable(inner)) el = inner;
      else return { status: "not_editable", desc: describe(el) };
    }
    if ((kind === "password" || kind === "totp") && !kindOk(el, kind)) return { status: "incompatible", desc: describe(el) };
    return found(el, "selector");
  }

  const inputs = all("input, textarea").filter((el) => isEditable(el) && isVisible(el));
  const textLike = inputs.filter((el) => el.tagName === "INPUT" && ["", "text", "email", "tel"].includes(typeOf(el)));

  const splitBoxes = () => {
    const boxes = inputs.filter((el) => el.tagName === "INPUT" && el.maxLength === 1 && ["", "text", "tel", "number", "password"].includes(typeOf(el)));
    if (boxes.length < 4 || boxes.length > 8) return null;
    let anc = boxes[0];
    for (let i = 0; i < 4 && anc; i++) {
      anc = anc.parentElement;
      if (anc && boxes.every((b) => anc.contains(b))) return boxes;
    }
    return null;
  };

  if (kind === "totp") {
    const boxes = splitBoxes();
    if (boxes) {
      globalThis[stateKey] = { el: boxes[0], boxes };
      return { status: "ok", mode: "split", count: boxes.length, via: "auto", desc: describe(boxes[0]), origin: originOf(boxes[0]) };
    }
  }

  if (allowFocused) {
    const active = deepActive();
    if (active && isEditable(active) && kindOk(active, kind || "text")) return found(active, "focused");
  }

  let el = null;
  if (kind === "password") {
    const pws = inputs.filter((e) => e.tagName === "INPUT" && typeOf(e) === "password");
    el = pws.find((e) => !e.value) || pws[0] || null;
  } else if (kind === "username") {
    el =
      textLike.find((e) => /\b(username|email)\b/.test((e.getAttribute("autocomplete") || "").toLowerCase())) ||
      textLike.find((e) => typeOf(e) === "email") ||
      textLike.find((e) => USER_RE.test(attrText(e)) && !OTP_RE.test(attrText(e))) ||
      null;
    if (!el) {
      const pw = inputs.find((e) => e.tagName === "INPUT" && typeOf(e) === "password");
      if (pw) {
        for (let i = inputs.indexOf(pw) - 1; i >= 0 && !el; i--) if (textLike.includes(inputs[i])) el = inputs[i];
      }
    }
    if (!el && textLike.length === 1) el = textLike[0];
  } else if (kind === "totp") {
    const numericish = (e) => e.getAttribute("inputmode") === "numeric" || ["tel", "number"].includes(typeOf(e));
    el =
      inputs.find((e) => e.getAttribute("autocomplete") === "one-time-code") ||
      inputs.find((e) => e.tagName === "INPUT" && kindOk(e, "totp") && OTP_RE.test(attrText(e))) ||
      inputs.find((e) => e.tagName === "INPUT" && kindOk(e, "totp") && numericish(e) && e.maxLength > 1 && e.maxLength <= 8) ||
      (textLike.length === 1 ? textLike[0] : null) ||
      // Some widgets keep a tiny (but focusable) real input behind decorative boxes.
      all("input[autocomplete='one-time-code']").find((e) => isEditable(e)) ||
      null;
  } else {
    return { status: "nothing_focused" };
  }
  return el ? found(el, "auto") : { status: "not_found" };
}`;

/** Scroll the target into view; report its centre in top-level viewport CSS pixels and whether it is hit-testable. */
const PREPARE = String.raw`(args) => {
  const s = globalThis[args.stateKey];
  const el = s && (args.index == null ? s.el : s.boxes[args.index]);
  if (!el || !el.isConnected) return { ok: false };
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  let hit = null;
  try { hit = (el.getRootNode && el.getRootNode().elementFromPoint ? el.getRootNode() : el.ownerDocument).elementFromPoint(cx, cy); } catch {}
  const clickable = !!hit && (hit === el || el.contains(hit) || (hit.tagName === "LABEL" && hit.control === el));
  let x = cx, y = cy, win = el.ownerDocument.defaultView;
  try {
    while (win && win.frameElement) {
      const fr = win.frameElement.getBoundingClientRect();
      const cs = win.parent.getComputedStyle(win.frameElement);
      x += fr.left + parseFloat(cs.borderLeftWidth || "0") + parseFloat(cs.paddingLeft || "0");
      y += fr.top + parseFloat(cs.borderTopWidth || "0") + parseFloat(cs.paddingTop || "0");
      win = win.parent;
    }
  } catch { return { ok: true, clickable: false, x, y }; }
  return { ok: true, clickable: clickable && !args.inChildFrame, x, y };
}`;

/** Focus the target and clear its current content. Returns whether it ended up focused. */
const FOCUS_CLEAR = String.raw`(args) => {
  const s = globalThis[args.stateKey];
  const el = s && (args.index == null ? s.el : s.boxes[args.index]);
  if (!el || !el.isConnected) return { focused: false, origin: "null" };
  let origin = "null";
  try { origin = String(el.ownerDocument.defaultView.origin); } catch {}
  el.focus({ preventScroll: true });
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
    const proto = el.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    if (el.value !== "") {
      setter.call(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  } else if (el.isContentEditable) {
    const doc = el.ownerDocument;
    const range = doc.createRange();
    range.selectNodeContents(el);
    const sel = doc.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    doc.execCommand("delete");
  }
  let a = el.ownerDocument.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  return { focused: a === el, origin };
}`;

/** Fire change events, compare lengths (never values) and forget the target. */
const FINISH = String.raw`(args) => {
  const s = globalThis[args.stateKey];
  delete globalThis[args.stateKey];
  if (!s) return { matches: null, url: location.href };
  const targets = s.boxes || [s.el];
  for (const el of targets) {
    try { el.dispatchEvent(new Event("change", { bubbles: true })); } catch {}
  }
  let matches = null;
  if (s.boxes && args.split) matches = s.boxes.every((b) => String(b.value).length === 1);
  else if (s.el.tagName === "INPUT" || s.el.tagName === "TEXTAREA") matches = String(s.el.value).length === args.length;
  return { matches, url: location.href };
}`;

/* ------------------------------------------------------------------ */
/* Driver                                                               */
/* ------------------------------------------------------------------ */

interface FrameContext {
  session: PageSession;
  contextId: number | undefined;
  isChildFrame: boolean;
}

function call<T>(ctx: FrameContext, fn: string, args: Record<string, unknown>): Promise<T> {
  return ctx.session.evaluate<T>(`(${fn})(${JSON.stringify(args)})`, { contextId: ctx.contextId, timeoutMs: 10_000 });
}

/** Sessions for cross-origin iframes (out-of-process frames) of the page, via flattened auto-attach. */
async function childFrameSessions(page: PageSession): Promise<PageSession[]> {
  const client: CdpClient = page.client;
  const sessions: PageSession[] = [];
  const off = client.on("Target.attachedToTarget", (params, parentSessionId) => {
    if (parentSessionId !== page.sessionId) return;
    const info = params.targetInfo as { type: string; targetId: string };
    if (info.type === "iframe") sessions.push(new PageSession(client, params.sessionId as string, info.targetId));
  });
  try {
    await page.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await new Promise((r) => setTimeout(r, 150));
  } catch {
    /* not supported */
  } finally {
    off();
  }
  return sessions;
}

function locateFailure(loc: LocateResult, opts: FillOptions): string {
  const what = opts.kind ?? "text";
  switch (loc.status) {
    case "bad_selector":
      return `"${opts.selector}" is not a valid CSS selector.`;
    case "not_found":
      return opts.selector
        ? `No element matches "${opts.selector}" on the page.`
        : `Could not find a ${what} field on the page. Click into the field first or pass a CSS selector.`;
    case "not_editable":
      return `The element ${loc.desc ?? ""} is not an editable text field.`;
    case "incompatible":
      return opts.kind === "totp"
        ? `Refusing to type a 2FA code into ${loc.desc ?? "that element"}; only input fields can receive it.`
        : `Refusing to type a password into ${loc.desc ?? "a non-password field"}; only input[type=password] fields can receive it.`;
    case "nothing_focused":
      return "No text field is focused. Click into the field first or pass a CSS selector.";
    default:
      return "Could not locate the field.";
  }
}

/** Fill `opts.text` into the right field of an attached page. */
export async function fillOnPage(page: PageSession, opts: FillOptions): Promise<FillResult> {
  const stateKey = `__godmode_fill_${randomToken(9)}`;
  const kind = opts.kind ?? "text";
  await page.waitForReady(5000);
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});

  const main: FrameContext = { session: page, contextId: await page.isolatedWorld(), isChildFrame: false };
  let ctx: FrameContext = main;
  let loc = await call<LocateResult>(main, LOCATE, { kind, selector: opts.selector ?? null, stateKey, allowFocused: true });

  if (loc.status === "not_found" || loc.status === "nothing_focused") {
    // The field may live in a cross-origin iframe (separate renderer) — search those too.
    for (const child of await childFrameSessions(page)) {
      const childCtx: FrameContext = { session: child, contextId: await child.isolatedWorld(), isChildFrame: true };
      try {
        const res = await call<LocateResult>(childCtx, LOCATE, { kind, selector: opts.selector ?? null, stateKey, allowFocused: false });
        if (res.status === "ok") {
          ctx = childCtx;
          loc = res;
          break;
        }
      } catch {
        /* frame navigated away */
      }
    }
  }

  const currentUrl = async () => {
    try {
      return await page.evaluate<string>("location.href", { timeoutMs: 3000 });
    } catch {
      return "";
    }
  };

  if (loc.status !== "ok") return { ok: false, url: await currentUrl(), detail: locateFailure(loc, opts) };
  const refusal = originRefusal(loc.origin ?? "", opts);
  if (refusal) {
    await call(ctx, FINISH, { stateKey, length: 0, split: false }).catch(() => {});
    return { ok: false, url: await currentUrl(), detail: refusal };
  }

  const fillOne = async (index: number | null, value: string) => {
    const pos = await call<{ ok: boolean; clickable?: boolean; x?: number; y?: number }>(ctx, PREPARE, {
      stateKey,
      index,
      inChildFrame: ctx.isChildFrame,
    });
    if (!pos.ok) throw new Error("The field disappeared from the page.");
    if (pos.clickable && typeof pos.x === "number" && typeof pos.y === "number") await page.click(pos.x, pos.y);
    const focus = await call<{ focused: boolean; origin: string }>(ctx, FOCUS_CLEAR, { stateKey, index });
    // Never type a secret unless our field has focus — it would land wherever the page put the caret.
    if (!focus.focused) throw new Error("Could not focus the field (the page moved focus elsewhere).");
    // Re-check the binding right before typing (the frame may have navigated since the field was located).
    const late = originRefusal(focus.origin, opts);
    if (late) throw new Error(late);
    await ctx.session.insertText(value);
  };

  const split = loc.mode === "split" && loc.count === opts.text.length;
  try {
    if (split) {
      for (let i = 0; i < opts.text.length; i++) await fillOne(i, opts.text[i]!);
    } else {
      await fillOne(null, opts.text);
    }
  } catch (err) {
    await call(ctx, FINISH, { stateKey, length: 0, split }).catch(() => {});
    return { ok: false, url: await currentUrl(), detail: err instanceof Error ? err.message : "Typing failed." };
  }

  const fin = await call<{ matches: boolean | null; url: string }>(ctx, FINISH, { stateKey, length: opts.text.length, split }).catch(() => ({
    matches: null,
    url: "",
  }));
  if (opts.submit) await ctx.session.pressKey("Enter");

  const where = split ? `${loc.count} one-digit boxes` : (loc.desc ?? "the field");
  const how = loc.via === "selector" ? "matched by selector" : loc.via === "focused" ? "focused field" : "auto-detected";
  let detail = `Filled ${kind === "text" ? "text" : kind} into ${where} (${how}${ctx.isChildFrame ? ", inside an embedded frame" : ""})${opts.submit ? " and pressed Enter" : ""}.`;
  if (fin.matches === false) detail += " Warning: the field's content length differs from what was typed — the page may have truncated or reformatted it.";
  return { ok: true, url: opts.submit ? await currentUrl() : fin.url || (await currentUrl()), detail };
}

/** Why nothing may be filled no matter which page is open (nothing to type, a login bound to no site), or null. */
export function fillPrecheck(opts: Pick<FillOptions, "text" | "allowedHosts">): FillResult | null {
  if (typeof opts.text !== "string" || opts.text.length === 0) return { ok: false, url: "", detail: "Nothing to type." };
  if (!Array.isArray(opts.allowedHosts) || opts.allowedHosts.length === 0) {
    return { ok: false, url: "", detail: "Refusing to fill: this login has no site (URL or domain) it belongs to. Ask the human to add one in the vault." };
  }
  return null;
}

/**
 * Fill into the active page (or the one whose URL contains `urlContains`) of a browser reached over CDP — Godmode's
 * Chromium on this computer or the Chrome in a VM. Callers check `fillPrecheck` first. The typed value never appears in
 * the result.
 */
export async function fillIntoActivePage(
  browser: { client: CdpClient; port?: number },
  opts: FillOptions & { urlContains?: string },
): Promise<FillResult> {
  // Belt and braces: error texts come from CDP/our scripts, but never let the typed value through.
  const scrub = (detail: string) => detail.split(opts.text).join("••••••••");
  try {
    const target = await pickActivePage(browser.client, { port: browser.port, urlContains: opts.urlContains });
    if (!target) {
      return { ok: false, url: "", detail: opts.urlContains ? `No open tab has a URL containing "${opts.urlContains}".` : "The browser has no open tab." };
    }
    const page = await attachToPage(browser.client, target.targetId);
    try {
      const result = await fillOnPage(page, opts);
      return { ...result, detail: scrub(result.detail) };
    } finally {
      await page.detach();
    }
  } catch (err) {
    return { ok: false, url: "", detail: scrub(`Could not fill the field: ${err instanceof Error ? err.message : String(err)}`) };
  }
}
