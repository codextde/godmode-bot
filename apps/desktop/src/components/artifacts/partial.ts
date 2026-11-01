
const OPEN_BLOCKS = [
  { open: /<script\b/gi, close: /<\/script\s*>/i },
  { open: /<style\b/gi, close: /<\/style\s*>/i },
  { open: /<!--/g, close: /-->/ },
];

export function safePartialHtml(html: string): string {
  let out = html;
  for (const { open, close } of OPEN_BLOCKS) {
    open.lastIndex = 0;
    let match: RegExpExecArray | null;
    let cut = -1;
    while ((match = open.exec(out))) {
      if (!close.test(out.slice(match.index + match[0].length))) {
        cut = match.index;
        break;
      }
    }
    if (cut >= 0) out = out.slice(0, cut);
  }
  const lt = out.lastIndexOf("<");
  if (lt >= 0 && out.indexOf(">", lt) === -1) out = out.slice(0, lt);
  return out;
}

function closeJson(text: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") stack.push("}");
    else if (c === "[") stack.push("]");
    else if (c === "}" || c === "]") stack.pop();
  }
  let out = text;
  if (inString) {
    out = out.replace(/\\u[0-9a-fA-F]{0,3}$/, "");
    if (escaped || /(^|[^\\])(\\\\)*\\$/.test(out)) out = out.slice(0, -1);
    out += '"';
  }
  out = out.replace(/[\s,]+$/, "");
  if (/:\s*$/.test(out)) out = out.replace(/,?\s*"(?:[^"\\]|\\.)*"\s*:\s*$/, "");
  return out + stack.reverse().join("");
}

export function parsePartialJson(text: string | undefined): unknown {
  if (!text?.trim()) return undefined;
  let rest = text;
  for (let attempt = 0; attempt < 40 && rest.trim(); attempt++) {
    try {
      return JSON.parse(closeJson(rest));
    } catch {
      const cut = Math.max(rest.lastIndexOf(","), rest.lastIndexOf("{"), rest.lastIndexOf("["));
      if (cut < 0) return undefined;
      rest = rest[cut] === "," || cut === rest.length - 1 ? rest.slice(0, cut) : rest.slice(0, cut + 1);
    }
  }
  return undefined;
}
