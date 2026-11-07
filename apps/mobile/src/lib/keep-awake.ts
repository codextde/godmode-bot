import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";

/** The screen stays on until `work` ends: a phone that sleeps drops the request the work hangs on. */
export async function staysAwake<T>(tag: string, work: () => Promise<T>): Promise<T> {
  await activateKeepAwakeAsync(tag).catch(() => undefined);
  try {
    return await work();
  } finally {
    void deactivateKeepAwake(tag).catch(() => undefined);
  }
}
