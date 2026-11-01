import { modState, modUpdateAvailable } from "@godmode/shared";
import { useBootstrap, useMods } from "@/lib/hooks";

/** Plugins that wait for the human: an agent's draft or install to review, code the check refuses, an update. */
export function usePluginsWaiting(): number {
  const { data: boot } = useBootstrap();
  const { data: mods = [] } = useMods();
  if (!boot?.settings.plugins.enabled) return 0;
  return mods.filter((m) => ["review", "broken"].includes(modState(m)) || modUpdateAvailable(m)).length;
}
