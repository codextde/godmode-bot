/** A small tokenizer for the mod editor: TypeScript/JavaScript and JSON, enough to colour what matters when reading a mod. */

export type CodeLanguage = "ts" | "json" | "text";

export type TokenKind = "plain" | "comment" | "string" | "number" | "literal" | "keyword" | "engine" | "punct" | "key";

export interface Token {
  kind: TokenKind;
  text: string;
}

export function languageOf(path: string): CodeLanguage {
  if (/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(path)) return "ts";
  if (/\.json$/i.test(path)) return "json";
  return "text";
}

export function languageLabel(path: string): string {
  const language = languageOf(path);
  if (language === "json") return "JSON";
  if (language === "text") return /\.md$/i.test(path) ? "Markdown" : "Text";
  return /\.[cm]?js$|\.jsx$/i.test(path) ? "JavaScript" : "TypeScript";
}

const KEYWORDS = new Set([
  "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "declare", "default", "delete", "do", "else", "enum", "export",
  "extends", "finally", "for", "from", "function", "if", "implements", "import", "in", "instanceof", "interface", "keyof", "let", "namespace", "new",
  "of", "private", "protected", "public", "readonly", "return", "satisfies", "static", "super", "switch", "this", "throw", "try", "type", "typeof",
  "var", "void", "while", "yield",
]);
const LITERALS = new Set(["true", "false", "null", "undefined", "NaN", "Infinity"]);
/** Keywords an expression follows, so a "/" after them starts a regular expression. */
const BEFORE_EXPRESSION = new Set(["return", "typeof", "case", "in", "of", "void", "delete", "throw", "new", "else", "do", "yield", "await", "instanceof"]);
/** Words that are only keywords in some places; as an object key ("type: …") they are names. */
const CONTEXTUAL = new Set(["as", "async", "declare", "from", "in", "keyof", "namespace", "of", "readonly", "satisfies", "static", "type"]);

const WORD = /[\p{L}_$][\p{L}\p{N}_$]*/uy;
const CHAIN = /(?:\.[A-Za-z_]\w*)+/y;
const NUMBER = /0[xX][\da-fA-F_]+n?|0[bB][01_]+n?|0[oO][0-7_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?n?/y;
const SPACE = /\s+/y;

function collector() {
  const tokens: Token[] = [];
  const push = (kind: TokenKind, text: string) => {
    if (!text) return;
    const last = tokens[tokens.length - 1];
    if (last && last.kind === kind) last.text += text;
    else tokens.push({ kind, text });
  };
  return { tokens, push };
}

function match(re: RegExp, code: string, at: number): string {
  re.lastIndex = at;
  return re.exec(code)?.[0] ?? "";
}

/** Where a quoted string that starts at `start` ends (it stops at the line's end when it is never closed). */
function stringEnd(code: string, start: number): number {
  const quote = code[start];
  let i = start + 1;
  while (i < code.length && code[i] !== quote && code[i] !== "\n") i += code[i] === "\\" ? 2 : 1;
  if (code[i] === quote) i++;
  return Math.min(i, code.length);
}

/** Where a regular expression literal that starts at `start` ends; -1 when the "/" is a division after all. */
function regexEnd(code: string, start: number): number {
  let inClass = false;
  for (let i = start + 1; i < code.length; i++) {
    const c = code[i];
    if (c === "\n") return -1;
    if (c === "\\") i++;
    else if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      let end = i + 1;
      while (end < code.length && /[a-z]/.test(code[end])) end++;
      return end;
    }
  }
  return -1;
}

function tokenizeTs(code: string): Token[] {
  const { tokens, push } = collector();
  const n = code.length;
  // What stands before the cursor: tells a regular expression from a division, and a property from a keyword.
  let before: "value" | "operator" | "dot" = "operator";
  let lastPunct = "";
  // One entry per open template literal: the braces open inside the `${ }` being read.
  const templates: number[] = [];
  let inTemplate = false;
  let i = 0;

  while (i < n) {
    if (inTemplate) {
      let j = i;
      while (j < n && code[j] !== "`" && !(code[j] === "$" && code[j + 1] === "{")) j += code[j] === "\\" ? 2 : 1;
      j = Math.min(j, n);
      push("string", code.slice(i, j));
      i = j;
      if (i >= n) break;
      inTemplate = false;
      if (code[i] === "`") {
        push("string", "`");
        i++;
        templates.pop();
        before = "value";
      } else {
        push("punct", "${");
        i += 2;
        before = "operator";
        lastPunct = "{";
      }
      continue;
    }

    const c = code[i];
    const space = match(SPACE, code, i);
    if (space) {
      push("plain", space);
      i += space.length;
      continue;
    }
    if (c === "/" && code[i + 1] === "/") {
      const end = code.indexOf("\n", i);
      push("comment", code.slice(i, end < 0 ? n : end));
      i = end < 0 ? n : end;
      continue;
    }
    if (c === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      push("comment", code.slice(i, end < 0 ? n : end + 2));
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = stringEnd(code, i);
      push("string", code.slice(i, end));
      i = end;
      before = "value";
      continue;
    }
    if (c === "`") {
      push("string", "`");
      templates.push(0);
      inTemplate = true;
      i++;
      continue;
    }
    // After "<" it is a closing JSX tag, never a regular expression.
    if (c === "/" && before !== "value" && lastPunct !== "<") {
      const end = regexEnd(code, i);
      if (end > 0) {
        push("string", code.slice(i, end));
        i = end;
        before = "value";
        continue;
      }
    }
    if ((c >= "0" && c <= "9") || (c === "." && code[i + 1] >= "0" && code[i + 1] <= "9" && before !== "value")) {
      const number = match(NUMBER, code, i);
      if (number) {
        push("number", number);
        i += number.length;
        before = "value";
        continue;
      }
    }
    const word = match(WORD, code, i);
    if (word) {
      i += word.length;
      if (word === "$" && before !== "dot") {
        const chain = match(CHAIN, code, i);
        push("engine", word + chain);
        i += chain.length;
        before = "value";
        continue;
      }
      const isKey = CONTEXTUAL.has(word) && /^\s*:/.test(code.slice(i, i + 8));
      if (before === "dot" || isKey) push("plain", word);
      else if (KEYWORDS.has(word)) {
        push("keyword", word);
        before = BEFORE_EXPRESSION.has(word) ? "operator" : "value";
        lastPunct = "";
        continue;
      } else push(LITERALS.has(word) ? "literal" : "plain", word);
      before = "value";
      continue;
    }

    if (templates.length) {
      const top = templates.length - 1;
      if (c === "{") templates[top]++;
      else if (c === "}") {
        if (templates[top] === 0) {
          push("punct", "}");
          i++;
          inTemplate = true;
          continue;
        }
        templates[top]--;
      }
    }
    push("punct", c);
    i++;
    before = c === "." ? "dot" : c === ")" || c === "]" || c === "}" ? "value" : "operator";
    lastPunct = c;
  }
  return tokens;
}

function tokenizeJson(code: string): Token[] {
  const { tokens, push } = collector();
  const n = code.length;
  let i = 0;
  while (i < n) {
    const c = code[i];
    const space = match(SPACE, code, i);
    if (space) {
      push("plain", space);
      i += space.length;
    } else if (c === '"') {
      const end = stringEnd(code, i);
      push(/^\s*:/.test(code.slice(end, end + 16)) ? "key" : "string", code.slice(i, end));
      i = end;
    } else if ((c >= "0" && c <= "9") || (c === "-" && code[i + 1] >= "0" && code[i + 1] <= "9")) {
      const number = (c === "-" ? "-" : "") + match(NUMBER, code, c === "-" ? i + 1 : i);
      push("number", number);
      i += number.length;
    } else {
      const word = match(WORD, code, i);
      if (word) {
        push(LITERALS.has(word) ? "literal" : "plain", word);
        i += word.length;
      } else {
        push("punct", c);
        i++;
      }
    }
  }
  return tokens;
}

export function tokenize(code: string, language: CodeLanguage): Token[] {
  if (language === "ts") return tokenizeTs(code);
  if (language === "json") return tokenizeJson(code);
  return code ? [{ kind: "plain", text: code }] : [];
}
