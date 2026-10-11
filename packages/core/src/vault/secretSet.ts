/**
 * Secrets to mask, found in one pass over a text: a rolling hash of every position's first GRAM characters is looked up
 * among the secrets' own (a bit filter first, then a map), and only those candidates are compared. A vault with
 * thousands of logins used to cost one full scan of the text per secret — seconds for a run log of tens of megabytes,
 * tens of milliseconds for every streamed block.
 */
const GRAM = 4;
const BASE = 0x01000193;
const FILTER_BITS = 16;
/** BASE^(GRAM-1): what the character leaving the window added to the hash. */
const TOP = Array.from({ length: GRAM - 1 }).reduce<number>((p) => Math.imul(p, BASE), 1);

function gramHash(text: string, at: number): number {
  let h = 0;
  for (let j = 0; j < GRAM; j++) h = (Math.imul(h, BASE) + text.charCodeAt(at + j)) | 0;
  return h;
}

function slot(h: number): number {
  return Math.imul(h, 0x9e3779b1) >>> (32 - FILTER_BITS);
}

const longestFirst = (a: string, b: string) => b.length - a.length;

export class SecretSet {
  private all = new Set<string>();
  /** Secrets by the hash of their first GRAM characters, the longest first. */
  private buckets = new Map<number, string[]>();
  private filter = new Uint8Array(1 << FILTER_BITS);
  /** Shorter than GRAM: searched one by one. */
  private short: string[] = [];

  get size(): number {
    return this.all.size;
  }

  add(secret: string): void {
    if (!secret || this.all.has(secret)) return;
    this.all.add(secret);
    if (secret.length < GRAM) {
      this.short.push(secret);
      this.short.sort(longestFirst);
      return;
    }
    const h = gramHash(secret, 0);
    this.filter[slot(h)] = 1;
    const bucket = this.buckets.get(h);
    if (!bucket) this.buckets.set(h, [secret]);
    else {
      bucket.push(secret);
      bucket.sort(longestFirst);
    }
  }

  clear(): void {
    this.all.clear();
    this.buckets.clear();
    this.filter.fill(0);
    this.short = [];
  }

  /**
   * `text` with every secret in it replaced by `mask`, the same string when there is none. Secrets that overlap (one
   * inside or across another) become one mask, so no part of either stays readable.
   */
  replace(text: string, mask: string): string {
    if (!text || this.all.size === 0) return text;
    const spans: [number, number][] = [];
    const n = text.length;
    if (n >= GRAM && this.buckets.size) {
      let h = gramHash(text, 0);
      for (let i = 0; ; i++) {
        if (this.filter[slot(h)]) {
          for (const secret of this.buckets.get(h) ?? []) {
            if (text.startsWith(secret, i)) {
              spans.push([i, i + secret.length]);
              break;
            }
          }
        }
        if (i + GRAM >= n) break;
        h = (Math.imul(h - Math.imul(text.charCodeAt(i), TOP), BASE) + text.charCodeAt(i + GRAM)) | 0;
      }
    }
    let unsorted = false;
    for (const secret of this.short) {
      for (let at = text.indexOf(secret); at >= 0; at = text.indexOf(secret, at + secret.length)) {
        spans.push([at, at + secret.length]);
        unsorted = true;
      }
    }
    if (!spans.length) return text;
    if (unsorted) spans.sort((a, b) => a[0] - b[0]);
    const parts: string[] = [];
    let pos = 0;
    let [start, end] = spans[0]!;
    for (const [s, e] of spans) {
      if (s < end) {
        end = Math.max(end, e);
        continue;
      }
      parts.push(text.slice(pos, start), mask);
      pos = end;
      start = s;
      end = e;
    }
    parts.push(text.slice(pos, start), mask, text.slice(end));
    return parts.join("");
  }
}
