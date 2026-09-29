/**
 * Agent answers are Markdown; chat platforms each speak their own dialect. Conversions are best effort and never
 * lose text: anything a platform can't show stays as plain characters.
 */

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;

/** The fence a chunk ends inside of: its opening line ("```ts") and marker ("```"), or null when every fence is closed. */
function openFence(text: string): { line: string; marker: string } | null {
  let open: { line: string; marker: string } | null = null;
  for (const line of text.split("\n")) {
    const m = FENCE.exec(line);
    if (!m) continue;
    open = open ? null : { line: line.trim(), marker: m[1]! };
  }
  return open;
}

function cutPoint(text: string, limit: number): number {
  const window = text.slice(0, limit);
  for (const sep of ["\n\n", "\n", " "]) {
    const at = window.lastIndexOf(sep);
    if (at >= limit * 0.4) return at + sep.length;
  }
  return limit;
}

/** Split Markdown into messages of at most `max` characters, at paragraph/line/word boundaries; code fences stay balanced. */
export function splitMessage(text: string, max: number): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  let reopen = "";
  while (rest) {
    const body = reopen + rest;
    if (body.length <= max) {
      chunks.push(body);
      break;
    }
    const cut = cutPoint(body, max - 8);
    let chunk = body.slice(0, cut).trimEnd();
    rest = body.slice(cut).replace(/^\n+/, "");
    const fence = openFence(chunk);
    if (fence) {
      chunk += `\n${fence.marker}`;
      reopen = fence.line.length < max / 4 ? `${fence.line}\n` : "";
    } else reopen = "";
    chunks.push(chunk);
  }
  return chunks.filter((c) => c.trim());
}

interface Block {
  kind: "text" | "code" | "table" | "quote";
  lang?: string;
  lines: string[];
}

function blocks(markdown: string): Block[] {
  const out: Block[] = [];
  let code: Block | null = null;
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (code) {
      if (FENCE.test(line)) {
        out.push(code);
        code = null;
      } else code.lines.push(line);
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      code = { kind: "code", lang: fence[2] || undefined, lines: [] };
      continue;
    }
    const kind: Block["kind"] = TABLE_ROW.test(line) ? "table" : /^\s*>/.test(line) ? "quote" : "text";
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.lines.push(kind === "quote" ? line.replace(/^\s*>\s?/, "") : line);
    else out.push({ kind, lines: [kind === "quote" ? line.replace(/^\s*>\s?/, "") : line] });
  }
  if (code) out.push(code);
  return out;
}

/** Protects spans (code, links) from later replacements. */
class Stash {
  private items: string[] = [];
  put(value: string): string {
    this.items.push(value);
    return `\u0000${this.items.length - 1}\u0000`;
  }
  restore(text: string): string {
    return text.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => this.items[Number(i)] ?? "");
  }
}

const LINK = /!?\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)(?:[^\s()]|\([^\s()]*\))+)\)/g;
const BOLD = [/\*\*(?=\S)([^\n]*?\S)\*\*/g, /__(?=\S)([^\n]*?\S)__/g];
const STRIKE = /~~(?=\S)([^\n]*?\S)~~/g;
const ITALIC = [/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, /(^|[^\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])/g];

function listBullet(line: string): string {
  return line.replace(/^(\s*)[-*+]\s+(?=\S)/, "$1• ").replace(/^(\s*)[-*+]\s+\[( |x|X)\]\s+/, (_m, indent: string, done: string) => `${indent}${done.trim() ? "☑" : "☐"} `);
}

/* ------------------------------------------------------------------ */
/* Telegram (HTML parse mode)                                          */
/* ------------------------------------------------------------------ */

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function telegramInline(text: string): string {
  const stash = new Stash();
  let s = text.replace(/`([^`\n]+)`/g, (_m, code: string) => stash.put(`<code>${escapeHtml(code)}</code>`));
  s = s.replace(LINK, (_m, label: string, url: string) => stash.put(`<a href="${escapeHtml(url).replace(/"/g, "&quot;")}">${escapeHtml(label)}</a>`));
  s = escapeHtml(s);
  for (const re of BOLD) s = s.replace(re, "<b>$1</b>");
  s = s.replace(STRIKE, "<s>$1</s>");
  for (const re of ITALIC) s = s.replace(re, "$1<i>$2</i>");
  return stash.restore(s);
}

function telegramLine(line: string): string {
  const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
  if (heading) return `<b>${telegramInline(heading[1]!)}</b>`;
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return "──────────";
  return telegramInline(listBullet(line));
}

/** Markdown → Telegram's HTML subset (b, i, s, code, pre, a, blockquote). */
export function toTelegramHtml(markdown: string): string {
  return blocks(markdown)
    .map((b) => {
      if (b.kind === "code") {
        const body = escapeHtml(b.lines.join("\n"));
        if (!body.trim()) return "";
        return b.lang ? `<pre><code class="language-${escapeHtml(b.lang)}">${body}</code></pre>` : `<pre>${body}</pre>`;
      }
      if (b.kind === "table") return `<pre>${escapeHtml(b.lines.join("\n"))}</pre>`;
      if (b.kind === "quote") return `<blockquote>${b.lines.map(telegramLine).join("\n")}</blockquote>`;
      return b.lines.map(telegramLine).join("\n");
    })
    .join("\n")
    .trim();
}

/** Markdown without markup, for platforms that refused the formatted version. */
export function toPlainText(markdown: string): string {
  return blocks(markdown)
    .map((b) => {
      if (b.kind === "code" || b.kind === "table") return b.lines.join("\n");
      return b.lines
        .map((line) =>
          listBullet(line)
            .replace(/^\s{0,3}#{1,6}\s+/, "")
            .replace(LINK, "$1 ($2)")
            .replace(/(\*\*|__|~~|`)/g, ""),
        )
        .join("\n");
    })
    .join("\n")
    .trim();
}

/* ------------------------------------------------------------------ */
/* Slack (mrkdwn)                                                      */
/* ------------------------------------------------------------------ */

function slackEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function slackInline(text: string): string {
  const stash = new Stash();
  let s = text.replace(/`([^`\n]+)`/g, (_m, code: string) => stash.put(`\`${slackEscape(code)}\``));
  s = s.replace(LINK, (_m, label: string, url: string) => stash.put(`<${url.replace(/[<>|]/g, encodeURIComponent)}|${slackEscape(label).replace(/\|/g, "¦")}>`));
  s = slackEscape(s);
  for (const re of BOLD) s = s.replace(re, (_m, inner: string) => stash.put(`*${inner}*`));
  s = s.replace(STRIKE, "~$1~");
  for (const re of ITALIC) s = s.replace(re, "$1_$2_");
  // Bold may wrap italics: restore twice (stashed spans can contain stashed spans).
  return stash.restore(stash.restore(s));
}

function slackLine(line: string): string {
  const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
  if (heading) return `*${slackInline(heading[1]!)}*`;
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return "──────────";
  return slackInline(listBullet(line));
}

/** Markdown → Slack mrkdwn. */
export function toSlackMrkdwn(markdown: string): string {
  return blocks(markdown)
    .map((b) => {
      if (b.kind === "code" || b.kind === "table") return `\`\`\`\n${slackEscape(b.lines.join("\n"))}\n\`\`\``;
      if (b.kind === "quote") return b.lines.map((l) => `> ${slackLine(l)}`).join("\n");
      return b.lines.map(slackLine).join("\n");
    })
    .join("\n")
    .trim();
}

/** Slack message text → plain text: mentions, links and escapes resolved. */
export function fromSlackText(text: string): string {
  return text
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replace(/<mailto:([^|>]+)\|[^>]+>/g, "$1")
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<!(here|channel|everyone)>/g, "@$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
