
export const ARTIFACT_TOOL_NAME = /(^|__)artifact_(create|update)$/;

export const ARTIFACT_PREVIEW_STEP = 1500;

export interface PartialArtifactInput {
  _streaming: true;
  id?: string;
  title?: string;
  html?: string;
  specText?: string;
  dataText?: string;
}

const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

function readString(buf: string, start: number): { value: string; end: number } {
  let out = "";
  let i = start + 1;
  while (i < buf.length) {
    const c = buf[i]!;
    if (c === '"') return { value: out, end: i + 1 };
    if (c === "\\") {
      const e = buf[i + 1];
      if (e === undefined) break;
      if (e === "u") {
        const hex = buf.slice(i + 2, i + 6);
        if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) break;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      out += ESCAPES[e] ?? e;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return { value: out, end: -1 };
}

function skipValue(buf: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < buf.length) {
    const c = buf[i]!;
    if (c === '"') {
      const s = readString(buf, i);
      if (s.end === -1) return -1;
      i = s.end;
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

export function partialArtifactInput(buf: string): PartialArtifactInput {
  const out: PartialArtifactInput = { _streaming: true };
  let i = buf.indexOf("{");
  if (i === -1) return out;
  i++;
  while (i < buf.length) {
    while (i < buf.length && /[\s,]/.test(buf[i]!)) i++;
    if (buf[i] !== '"') break;
    const key = readString(buf, i);
    if (key.end === -1) break;
    i = key.end;
    while (i < buf.length && /[\s:]/.test(buf[i]!)) i++;
    if (i >= buf.length) break;
    const c = buf[i]!;
    if (c === '"') {
      const v = readString(buf, i);
      if (key.value === "id" && v.end !== -1) out.id = v.value;
      else if (key.value === "title") out.title = v.value;
      else if (key.value === "html") out.html = v.value;
      else if (key.value === "spec") out.specText = v.value;
      else if (key.value === "data") out.dataText = v.value;
      if (v.end === -1) break;
      i = v.end;
      continue;
    }
    if (c === "{" || c === "[") {
      const end = skipValue(buf, i);
      const text = buf.slice(i, end === -1 ? buf.length : end);
      if (key.value === "spec") out.specText = text;
      else if (key.value === "data") out.dataText = text;
      if (end === -1) break;
      i = end;
      continue;
    }
    while (i < buf.length && buf[i] !== "," && buf[i] !== "}") i++;
  }
  return out;
}
