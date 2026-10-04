"use client";

import { useEffect, useId, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/confirm-dialog";

/*
 * One small store for the whole page: which guards are active and which navigation waits for an answer.
 * Links are intercepted here; code that navigates by itself (the command palette) calls guardNavigation().
 */
let active: string[] = [];
let waiting: (() => void) | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Runs `proceed` now, or after the person confirms leaving when a form on the page has unsaved changes. */
export function guardNavigation(proceed: () => void) {
  if (active.length === 0) return proceed();
  waiting = proceed;
  emit();
}

function isPlainLeftClick(e: MouseEvent) {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.defaultPrevented;
}

/**
 * Asks before leaving a page with unsaved changes (house rule 6): in-app links, the command palette, reloads and
 * closing the tab. Render it once inside the form: `<UnsavedGuard when={dirty} />`. The browser's back button is not
 * intercepted (the App Router offers no way to); the reload/close prompt is the browser's own.
 */
export function UnsavedGuard({
  when,
  title = "Leave without saving?",
  description = "Your changes on this page will be lost.",
}: {
  when: boolean;
  title?: string;
  description?: string;
}) {
  const id = useId();
  const router = useRouter();
  const pending = useSyncExternalStore(
    subscribe,
    () => waiting,
    () => null,
  );
  const owner = useSyncExternalStore(
    subscribe,
    () => active[active.length - 1] ?? null,
    () => null,
  );

  useEffect(() => {
    if (!when) return;
    active = [...active, id];
    emit();

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    // Capture phase on document runs before React's own listener on the root, so Next's <Link> never sees the click.
    const onClick = (e: MouseEvent) => {
      if (!isPlainLeftClick(e) || !(e.target instanceof Element)) return;
      const a = e.target.closest<HTMLAnchorElement>("a[href]");
      if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return; // beforeunload covers leaving the site
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      e.preventDefault();
      e.stopPropagation();
      waiting = () => {
        // /d/… is served by the custom server, not by Next: load it as a document.
        if (url.pathname.startsWith("/d/")) window.location.assign(url.href);
        else router.push(`${url.pathname}${url.search}${url.hash}`);
      };
      emit();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      active = active.filter((a) => a !== id);
      if (active.length === 0) waiting = null;
      emit();
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [when, id, router]);

  if (owner !== id) return null;
  return (
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) {
          waiting = null;
          emit();
        }
      }}
      title={title}
      description={description}
      confirmLabel="Leave"
      cancelLabel="Stay"
      tone="danger"
      onConfirm={() => {
        const proceed = waiting;
        waiting = null;
        emit();
        proceed?.();
      }}
    />
  );
}
