"use client";

import { useMediaQuery } from "@/hooks/use-media-query";

/** Same breakpoint as apps/desktop: below 768 px the sidebar becomes a sheet and dialogs become drawers. */
export const MOBILE_BREAKPOINT = 768;

export function useIsMobile() {
  return useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
}
