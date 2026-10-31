const MAX_TERMS = 8;

export type Term = { text: string; phrase: boolean };

export function parseQuery(input: string): Term[] {
  const terms: Term[] = [];
  const re = /"([^"]*)"?|([^\s"]+)/g;
  for (const m of input.matchAll(re)) {
    if (m[1] !== undefined) {
      const inner = words(m[1]);
      if (inner.length) terms.push({ text: inner.join(" "), phrase: true });
    } else if (m[2]) {
      for (const w of words(m[2])) terms.push({ text: w, phrase: false });
    }
  }
  return terms.slice(0, MAX_TERMS);
}

function words(s: string): string[] {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function termExpr(term: Term, alternatives?: string[]): string {
  if (alternatives?.length) return `(${alternatives.map((a) => `"${a}"*`).join(" OR ")})`;
  return term.phrase ? `"${term.text}"` : `"${term.text}"*`;
}

export function matchExpr(terms: Term[], fixes: Map<number, string[]> = new Map()): string {
  return terms.map((t, i) => termExpr(t, fixes.get(i))).join(" AND ");
}
