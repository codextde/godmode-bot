/**
 * Stand-ins for `next/headers` and `next/navigation` so server actions run in vitest. Import this file first in a
 * test, then drive `request` (cookies and headers of the pretend request) between calls.
 */
import { vi } from "vitest";

export const request = {
  cookies: new Map<string, string>(),
  headers: new Map<string, string>([["host", "localhost:3210"]]),
  reset() {
    this.cookies.clear();
    this.headers = new Map([["host", "localhost:3210"]]);
  },
};

export class RedirectError extends Error {
  digest: string;
  constructor(public url: string) {
    super("NEXT_REDIRECT");
    this.digest = `NEXT_REDIRECT;replace;${url};307;`;
  }
}

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (request.cookies.has(name) ? { name, value: request.cookies.get(name)! } : undefined),
    set: (name: string, value: string, options?: { maxAge?: number; expires?: Date }) => {
      const gone = options?.maxAge === 0 || (options?.expires !== undefined && options.expires.getTime() <= Date.now()) || value === "";
      if (gone) request.cookies.delete(name);
      else request.cookies.set(name, value);
    },
  }),
  headers: async () => ({ get: (name: string) => request.headers.get(name.toLowerCase()) ?? null }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectError(url);
  },
  forbidden: () => {
    throw Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK;403"), { digest: "NEXT_HTTP_ERROR_FALLBACK;403" });
  },
  unstable_rethrow: (err: unknown) => {
    if (typeof err === "object" && err !== null && "digest" in err && String((err as { digest: unknown }).digest).startsWith("NEXT_")) throw err;
  },
}));

/** Runs an action that is expected to redirect and returns where to. */
export async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    if (err instanceof RedirectError) return err.url;
    throw err;
  }
  throw new Error("expected a redirect");
}

/** Captures console.log while the server "sends" e-mail to the log, and finds the code and link in it. */
export function captureMail() {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return {
    async wait(pattern: RegExp): Promise<string> {
      for (let i = 0; i < 100; i++) {
        const match = pattern.exec(lines.join("\n"));
        if (match) return match[1] ?? match[0];
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`nothing matched ${pattern} in:\n${lines.join("\n")}`);
    },
    stop() {
      spy.mockRestore();
    },
  };
}
