"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, Search, SlidersHorizontal, X } from "lucide-react";
import { Segmented } from "@/components/controls";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { hrefWithParams, useUpdateSearchParams } from "@/hooks/use-update-search-params";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/** The default page size of every list (house rule 7). */
export const PAGE_SIZE = 25;

function isTyping(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.closest("[role=dialog]") !== null;
}

/* ------------------------------------------------------------------ */
/* Search                                                               */
/* ------------------------------------------------------------------ */

/**
 * Debounced search that writes `?q=` (and resets `?page=`). "/" anywhere on the page focuses it; Escape clears it.
 * The page reads `searchParams.q` on the server.
 */
export function SearchInput({
  placeholder = "Search…",
  param = "q",
  debounce = 300,
  "aria-label": ariaLabel = "Search",
  className,
}: {
  placeholder?: string;
  param?: string;
  debounce?: number;
  "aria-label"?: string;
  className?: string;
}) {
  const searchParams = useSearchParams();
  const [update, pending] = useUpdateSearchParams();
  const urlValue = searchParams.get(param) ?? "";
  const [value, setValue] = useState(urlValue);
  const sent = useRef(urlValue);
  const input = useRef<HTMLInputElement>(null);

  // Follow the URL when it changes from elsewhere (back button, a cleared filter).
  useEffect(() => {
    if (urlValue !== sent.current) {
      sent.current = urlValue;
      setValue(urlValue);
    }
  }, [urlValue]);

  useEffect(() => {
    const next = value.trim();
    if (next === sent.current) return;
    const timer = setTimeout(() => {
      sent.current = next;
      update({ [param]: next || null });
    }, debounce);
    return () => clearTimeout(timer);
  }, [value, debounce, param, update]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      e.preventDefault();
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div role="search" className={cn("relative w-full min-w-0 @xl:max-w-xs", className)}>
      <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={input}
        type="search"
        inputMode="search"
        enterKeyHint="search"
        autoComplete="off"
        spellCheck={false}
        aria-label={ariaLabel}
        aria-keyshortcuts="/"
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.preventDefault();
            setValue("");
          }
        }}
        className="pr-9 pl-8"
      />
      <div className="absolute inset-y-0 right-1 flex items-center">
        {pending ? (
          <Spinner className="mr-1.5 text-muted-foreground" aria-label="Searching" />
        ) : value ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Clear search"
            onClick={() => {
              setValue("");
              input.current?.focus();
            }}
            className="text-muted-foreground"
          >
            <X />
          </Button>
        ) : (
          <kbd
            aria-hidden
            className="mr-1.5 hidden h-5 items-center rounded-[4px] border bg-paper-2 px-1.5 font-mono text-[10px] text-muted-foreground pointer-fine:inline-flex"
          >
            /
          </kbd>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Filters                                                              */
/* ------------------------------------------------------------------ */

const ALL = "__all";

/** A Select bound to one query parameter (`?role=admin`). The first entry clears it. */
export function FilterSelect({
  param,
  label,
  allLabel,
  options,
  className,
}: {
  param: string;
  /** Accessible name, e.g. "Role". */
  label: string;
  /** "All roles" */
  allLabel: string;
  options: { value: string; label: string }[];
  className?: string;
}) {
  const searchParams = useSearchParams();
  const [update] = useUpdateSearchParams();
  const value = searchParams.get(param) ?? ALL;
  return (
    <Select value={options.some((o) => o.value === value) ? value : ALL} onValueChange={(v) => update({ [param]: v === ALL ? null : v })}>
      <SelectTrigger aria-label={label} className={cn("w-full min-w-40 @2xl:w-auto", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Segmented tabs bound to one query parameter (`?status=pending`); `defaultValue` is the value without a parameter. */
export function FilterTabs<T extends string>({
  param,
  label,
  options,
  defaultValue,
  className,
}: {
  param: string;
  label: string;
  options: { value: T; label: ReactNode }[];
  defaultValue: T;
  className?: string;
}) {
  const searchParams = useSearchParams();
  const [update] = useUpdateSearchParams();
  const raw = searchParams.get(param);
  const value = (options.find((o) => o.value === raw)?.value ?? defaultValue) as T;
  return (
    <Segmented
      aria-label={label}
      value={value}
      onChange={(v) => update({ [param]: v === defaultValue ? null : v })}
      options={options}
      className={className}
    />
  );
}

/**
 * Filters for a list (house rule 7): shown inline from `@2xl`, folded behind one "Filters" button that opens a bottom
 * drawer below. Pass FilterSelect / FilterTabs as children and the parameter names in `params` so "Clear filters"
 * and the counter work.
 */
export function FilterSheet({
  children,
  params,
  title = "Filters",
  className,
}: {
  children: ReactNode;
  /** The query parameters these filters write, e.g. ["role", "status"]. */
  params: string[];
  title?: string;
  className?: string;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const descriptionId = useId();
  const active = params.filter((p) => searchParams.get(p)).length;
  const clearHref = hrefWithParams(pathname, searchParams, Object.fromEntries([...params, "page"].map((p) => [p, null])));

  return (
    <div className={cn("contents", className)}>
      <div className="hidden flex-wrap items-center gap-2 @2xl:flex">{children}</div>
      <div className="@2xl:hidden">
        <Button type="button" variant="outline" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open}>
          <SlidersHorizontal />
          {title}
          {active > 0 && (
            <span className="grid h-5 min-w-5 place-items-center rounded-[5px] bg-primary px-1 font-mono text-[10.5px] text-primary-foreground tabular-nums">
              {active}
            </span>
          )}
        </Button>
        <Drawer open={open} onOpenChange={setOpen}>
          <DrawerContent aria-describedby={descriptionId}>
            <DrawerHeader>
              <DrawerTitle>{title}</DrawerTitle>
              <DrawerDescription id={descriptionId} className="sr-only">
                Narrow down the list.
              </DrawerDescription>
            </DrawerHeader>
            <div className="flex flex-col gap-3 overflow-y-auto px-5 pb-2 [&>*]:w-full">{children}</div>
            <DrawerFooter>
              <DrawerClose asChild>
                <Button>Show results</Button>
              </DrawerClose>
              {active > 0 && (
                <Button variant="ghost" asChild>
                  <Link href={clearHref} replace scroll={false} onClick={() => setOpen(false)}>
                    Clear filters
                  </Link>
                </Button>
              )}
            </DrawerFooter>
          </DrawerContent>
        </Drawer>
      </div>
    </div>
  );
}

/** The row above a list: search on the left, filters and other controls on the right. */
export function ListToolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-wrap items-center gap-2 @2xl:flex-nowrap @2xl:justify-between", className)}>{children}</div>;
}

/* ------------------------------------------------------------------ */
/* Pagination                                                           */
/* ------------------------------------------------------------------ */

function pageWindow(page: number, pages: number): (number | "gap")[] {
  const keep = new Set([1, pages, page - 1, page, page + 1].filter((p) => p >= 1 && p <= pages));
  const sorted = [...keep].sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push("gap");
    out.push(p);
  });
  return out;
}

/**
 * `?page=` pagination for a list of `total` rows (25 per page by default). Keeps every other query parameter.
 * Renders nothing for an empty list.
 */
export function Pagination({
  total,
  pageSize = PAGE_SIZE,
  param = "page",
  noun = ["result", "results"],
  className,
}: {
  total: number;
  pageSize?: number;
  param?: string;
  /** Singular and plural for the counter: ["person", "people"]. */
  noun?: [string, string];
  className?: string;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  if (total <= 0) return null;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const requested = Number.parseInt(searchParams.get(param) ?? "1", 10);
  const page = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), pages) : 1;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const href = (p: number) => hrefWithParams(pathname, searchParams, { [param]: p <= 1 ? null : String(p) });
  const word = total === 1 ? noun[0] : noun[1];

  const step = (target: number, dir: "prev" | "next") => {
    const disabled = dir === "prev" ? page <= 1 : page >= pages;
    const label = dir === "prev" ? "Previous page" : "Next page";
    const icon = dir === "prev" ? <ChevronLeft /> : <ChevronRight />;
    if (disabled) {
      return (
        <Button variant="outline" size="icon-sm" disabled aria-label={label}>
          {icon}
        </Button>
      );
    }
    return (
      <Button variant="outline" size="icon-sm" asChild>
        <Link href={href(target)} aria-label={label} rel={dir}>
          {icon}
        </Link>
      </Button>
    );
  };

  return (
    <nav aria-label="Pagination" className={cn("flex flex-wrap items-center justify-between gap-x-4 gap-y-2", className)}>
      <p className="text-xs text-muted-foreground">
        {pages > 1 ? (
          <>
            <span className="font-mono tabular-nums">
              {formatNumber(from)}–{formatNumber(to)}
            </span>{" "}
            of <span className="font-mono tabular-nums">{formatNumber(total)}</span> {word}
          </>
        ) : (
          <>
            <span className="font-mono tabular-nums">{formatNumber(total)}</span> {word}
          </>
        )}
      </p>
      {pages > 1 && (
        <div className="flex items-center gap-1">
          {step(page - 1, "prev")}
          <ul className="hidden items-center gap-1 @md:flex">
            {pageWindow(page, pages).map((p, i) =>
              p === "gap" ? (
                <li key={`gap-${i}`} aria-hidden className="w-6 text-center text-xs text-muted-foreground">
                  …
                </li>
              ) : (
                <li key={p}>
                  <Button
                    variant={p === page ? "outline" : "ghost"}
                    size="icon-sm"
                    asChild
                    className={cn("font-mono text-xs tabular-nums", p === page ? "pointer-events-none" : "text-muted-foreground")}
                  >
                    <Link href={href(p)} aria-label={`Page ${p}`} aria-current={p === page ? "page" : undefined}>
                      {p}
                    </Link>
                  </Button>
                </li>
              ),
            )}
          </ul>
          <span className="px-2 font-mono text-xs text-muted-foreground tabular-nums @md:hidden">
            {page} / {pages}
          </span>
          {step(page + 1, "next")}
        </div>
      )}
    </nav>
  );
}
