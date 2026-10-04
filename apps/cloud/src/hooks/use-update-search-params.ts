"use client";

import { useCallback, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Change query parameters of the current page without a scroll jump. `null` or "" removes a parameter. Unless
 * `keepPage` is set, `page` is reset, because a new filter or search starts at the first page.
 *
 *   const [update, pending] = useUpdateSearchParams();
 *   update({ role: "admin" });
 */
export function useUpdateSearchParams(): [(changes: Record<string, string | null>, opts?: { keepPage?: boolean }) => void, boolean] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const update = useCallback(
    (changes: Record<string, string | null>, opts: { keepPage?: boolean } = {}) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      if (!opts.keepPage && !("page" in changes)) next.delete("page");
      const query = next.toString();
      startTransition(() => router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false }));
    },
    [router, pathname, searchParams],
  );
  return [update, pending];
}

/** `href` for the current page with some query parameters changed (for <Link>s). */
export function hrefWithParams(pathname: string, current: URLSearchParams | { toString(): string }, changes: Record<string, string | null>): string {
  const next = new URLSearchParams(current.toString());
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === "") next.delete(key);
    else next.set(key, value);
  }
  const query = next.toString();
  return query ? `${pathname}?${query}` : pathname;
}
