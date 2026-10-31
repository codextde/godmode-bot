import { ListTree, Unlink } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AgentMemory } from "@godmode/shared";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useLocale } from "@/i18n/language";

export interface MemorySection {
  title: string;
  level: number;
  /** 0-based line of the heading. */
  line: number;
}

/** Markdown headings outside code fences. */
export function memorySections(text: string): MemorySection[] {
  const out: MemorySection[] = [];
  let fence = false;
  text.split("\n").forEach((raw, line) => {
    if (/^\s*(```|~~~)/.test(raw)) fence = !fence;
    if (fence) return;
    const m = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(raw);
    if (m) out.push({ level: m[1]!.length, title: m[2]!.replace(/[*_`]/g, ""), line });
  });
  return out;
}

function decodePath(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

/** Relative links to memory/ notes that don't exist. */
export function brokenMemoryLinks(text: string, topics: string[]): string[] {
  const known = new Set(topics);
  const out = new Set<string>();
  for (const m of text.matchAll(/\]\(\s*(?:\.\/)?(memory\/[^)\s#?]+)/g)) {
    const path = decodePath(m[1]!);
    if (!known.has(path)) out.add(path);
  }
  return [...out];
}

/** A memory/ note a clicked link points at, or null for any other link. */
export function memoryLinkTarget(href: string | null): string | null {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("/")) return null;
  const path = decodePath(href.replace(/^\.\//, "").split(/[#?]/)[0]!);
  return path.startsWith("memory/") && !path.includes("..") ? path : null;
}

export function SectionMenu({ sections, onPick }: { sections: MemorySection[]; onPick: (s: MemorySection) => void }) {
  const { t } = useTranslation("agents");
  if (sections.length < 2) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={t("memoryEditorParts.jumpToSection")}>
          <ListTree /> {t("memoryEditorParts.sections")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-64 overflow-y-auto">
        {sections.map((s) => (
          <DropdownMenuItem key={s.line} onSelect={() => onPick(s)} className={cn("text-[13px]", s.level === 1 && "font-medium", s.level === 3 && "pl-6 text-muted-foreground")}>
            <span className="truncate">{s.title}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Live size of the draft against what dreams keep it under (`target`) and what a chat loads (`limit`). */
export function MemoryBudget({ chars, memory }: { chars: number; memory: Pick<AgentMemory, "target" | "limit"> }) {
  const { t } = useTranslation("agents");
  const { intlLocale } = useLocale();
  const { target, limit } = memory;
  const cut = chars > limit;
  const over = chars > target;
  const tone = cut ? "bg-destructive" : over ? "bg-warning" : "bg-dream/70";
  const hint = cut
    ? t("memoryEditorParts.budgetCut", { limit: limit.toLocaleString(intlLocale) })
    : over
      ? t("memoryEditorParts.budgetOver", { over: (chars - target).toLocaleString(intlLocale) })
      : t("memoryEditorParts.budgetOk");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-2">
          <div
            role="meter"
            aria-label={t("memoryEditorParts.sizeLabel")}
            aria-valuemin={0}
            aria-valuemax={limit}
            aria-valuenow={Math.min(chars, limit)}
            aria-valuetext={t("memoryEditorParts.sizeValue", { chars: chars.toLocaleString(intlLocale), target: target.toLocaleString(intlLocale) })}
            className="relative h-1 w-24 rounded-full bg-secondary"
          >
            <div className={cn("h-full rounded-full transition-[width] duration-300", tone)} style={{ width: `${Math.min(100, (chars / limit) * 100)}%` }} />
            <span aria-hidden className="absolute -top-0.5 -bottom-0.5 w-px bg-foreground/35" style={{ left: `${(target / limit) * 100}%` }} />
          </div>
          <span className={cn("tabular-nums", cut ? "text-destructive" : over ? "text-warning" : undefined)}>
            {t("memoryEditorParts.chars", { chars: chars.toLocaleString(intlLocale), target: target.toLocaleString(intlLocale) })}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

export function BrokenLinks({ paths }: { paths: string[] }) {
  const { t } = useTranslation("agents");
  if (!paths.length) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1 text-warning">
          <Unlink className="size-3" />
          {t("memoryEditorParts.brokenLinks", { count: paths.length })}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-80">
        <p className="mb-1">{t("memoryEditorParts.missingNotes")}</p>
        {paths.map((p) => (
          <p key={p} className="font-mono text-[11px]">
            {p}
          </p>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}
