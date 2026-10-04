"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Live `matchMedia` result. The server (and the hydration pass) see `serverValue`; the browser value follows right
 * after, so markup never mismatches.
 */
export function useMediaQuery(query: string, serverValue = false): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => serverValue,
  );
}
