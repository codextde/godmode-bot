/**
 * In-memory state that must be one per process. Next.js bundles the app and esbuild bundles the custom server
 * (server/main.ts); both run in the same process, each with its own copy of every module. Anything they have to
 * agree on (caches, rate limits, the relay hub) therefore lives on `globalThis`, reached through this helper.
 */
type Store = Record<string, unknown>;

const store = ((globalThis as { __godmodeCloud?: Store }).__godmodeCloud ??= {});

/** The process-wide value under `key`, created by `init` the first time anyone asks. */
export function shared<T>(key: string, init: () => T): T {
  if (!(key in store)) store[key] = init();
  return store[key] as T;
}

/** For tests. */
export function resetShared(key?: string): void {
  if (key) delete store[key];
  else for (const k of Object.keys(store)) delete store[k];
}
