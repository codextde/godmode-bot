import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { CalendarClock, Layers, Plus, Search, SearchX, Sparkles, X } from "lucide-react";
import type { AgentTemplate, AgentTemplateCategory } from "@godmode/shared";
import { AGENT_TEMPLATE_CATEGORIES, AGENT_TEMPLATE_CATEGORY_LABELS } from "@godmode/shared";
import { AgentAvatar, EmptyState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Skeleton } from "@/components/ui/skeleton";
import { cronToHuman } from "@/components/agents/cron";
import { cn } from "@/lib/utils";

const SHORT_LABELS: Record<AgentTemplateCategory, string> = {
  leadership: "Leadership",
  finance: "Finance",
  legal: "Legal",
  people: "People",
  marketing: "Marketing",
  sales: "Sales",
  customer: "Customer service",
  ecommerce: "E-commerce",
  product: "Product & design",
  engineering: "Engineering & IT",
  data: "Data",
  operations: "Operations",
};

type Filter = AgentTemplateCategory | "all" | "all-in-one";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Each term has to start a word somewhere in the template: "ads" finds ads, not leads. */
const wordStarts = (query: string) =>
  query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => new RegExp(`(^|[^\\p{L}\\p{N}])${escape(term)}`, "iu"));

const searchText = (t: AgentTemplate) => [t.name, t.role, t.description, AGENT_TEMPLATE_CATEGORY_LABELS[t.category], ...(t.covers ?? [])].join(" ");

/**
 * Every role a company has, by department: one agent per job, or one all-in-one agent per department that covers
 * them all. Searchable, because there are many.
 */
export function RoleTemplates({
  templates,
  loading,
  onPick,
  onDescribe,
  title = "Or hire one role",
  description = "One agent per job, or one all-in-one agent that runs a whole department.",
  blankLabel = "Blank agent",
}: {
  templates: AgentTemplate[];
  loading: boolean;
  onPick: (templateId: string) => void;
  onDescribe: (text: string) => void;
  title?: string;
  description?: string;
  blankLabel?: string;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const terms = useMemo(() => wordStarts(query), [query]);
  const found = useMemo(() => templates.filter((t) => terms.every((re) => re.test(searchText(t)))), [templates, terms]);
  const inFilter = (t: AgentTemplate, f: Filter) => f === "all" || (f === "all-in-one" ? !!t.covers : t.category === f);
  const shown = found.filter((t) => inFilter(t, filter));
  const grouped = AGENT_TEMPLATE_CATEGORIES.map((c) => ({ category: c, items: shown.filter((t) => t.category === c) })).filter((g) => g.items.length > 0);
  const counts = (f: Filter) => found.filter((t) => inFilter(t, f)).length;
  const chips: Filter[] = ["all", "all-in-one", ...AGENT_TEMPLATE_CATEGORIES];

  return (
    <section aria-labelledby="roles-title" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div>
          <h2 id="roles-title" className="text-lg font-medium tracking-[-0.02em]">
            {title}
          </h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        <div className="flex w-full items-center gap-2 @xl:w-auto">
          <InputGroup className="flex-1 @xl:w-72">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput placeholder="Search roles…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search roles" />
            {query && (
              <InputGroupAddon align="inline-end">
                <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setQuery("")}>
                  <X />
                </InputGroupButton>
              </InputGroupAddon>
            )}
          </InputGroup>
          <Button variant="outline" onClick={() => onPick("scratch")}>
            <Plus /> {blankLabel}
          </Button>
        </div>
      </div>

      <div role="tablist" aria-label="Department" className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 @5xl:flex-wrap">
        {chips.map((c) => {
          const count = counts(c);
          if (c !== "all" && c !== filter && !count) return null;
          const active = filter === c;
          return (
            <button
              key={c}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setFilter(c)}
              className={cn(
                "flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs whitespace-nowrap transition focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                active ? "border-foreground/80 bg-foreground text-background" : "bg-card text-muted-foreground hover:border-foreground/20 hover:text-foreground",
              )}
            >
              {c === "all-in-one" && <Layers className="size-3" />}
              {c === "all" ? "All" : c === "all-in-one" ? "All-in-one" : SHORT_LABELS[c]}
              <span className={cn("tabular-nums", active ? "text-background/60" : "text-muted-foreground/70")}>{count}</span>
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-2 @5xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex gap-4 rounded-xl border bg-card p-4 shadow-card">
              <Skeleton className="size-12 shrink-0 rounded-xl" />
              <div className="flex-1">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="mt-2 h-3 w-full" />
                <Skeleton className="mt-1.5 h-3 w-2/3" />
              </div>
            </div>
          ))}
        </div>
      ) : shown.length === 0 ? (
        <EmptyState
          icon={<SearchX />}
          title={query ? `No role matches “${query.trim()}”` : "No roles here yet"}
          description="Describe the job in your own words and Godmode sets the agent up for you."
          action={
            <Button variant="outline" onClick={() => onDescribe(query.trim())}>
              <Sparkles /> Describe it instead
            </Button>
          }
        />
      ) : filter === "all" && !terms.length ? (
        <div className="space-y-8">
          {grouped.map((g) => (
            <div key={g.category} aria-labelledby={`dept-${g.category}`}>
              <h3 id={`dept-${g.category}`} className="mb-3 flex items-baseline gap-2 text-sm font-medium tracking-[-0.01em]">
                {AGENT_TEMPLATE_CATEGORY_LABELS[g.category]}
                <span className="text-xs font-normal text-muted-foreground tabular-nums">{g.items.length}</span>
              </h3>
              <TemplateGrid templates={g.items} onPick={onPick} />
            </div>
          ))}
        </div>
      ) : (
        <TemplateGrid templates={shown} onPick={onPick} />
      )}
    </section>
  );
}

function TemplateGrid({ templates, onPick }: { templates: AgentTemplate[]; onPick: (templateId: string) => void }) {
  return (
    <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-2 @5xl:grid-cols-3">
      {templates.map((t, i) => (
        <TemplateCard key={t.id} template={t} index={i} onPick={() => onPick(t.id)} />
      ))}
    </div>
  );
}

function TemplateCard({ template, index, onPick }: { template: AgentTemplate; index: number; onPick: () => void }) {
  const allInOne = !!template.covers?.length;
  return (
    <motion.button
      type="button"
      onClick={onPick}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index, 9) * 0.03 }}
      className={cn(
        "group flex items-start gap-4 rounded-xl border bg-card p-4 text-left shadow-card transition hover:border-foreground/15 hover:shadow-float focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        allInOne && "bg-linear-to-b from-brand/[0.07] to-card",
      )}
    >
      <AgentAvatar agent={{ id: template.id, avatar: template.avatar, color: template.color, character: template.character }} size="lg" className="shrink-0" />
      <span className="flex min-w-0 flex-1 flex-col self-stretch">
        <span className="block truncate font-medium tracking-[-0.01em]">{template.name}</span>
        <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {template.role}
          {template.leads && <span className="rounded-[5px] border bg-secondary px-1.5 py-px text-[10px] font-medium">Leads a team</span>}
          {allInOne && (
            <span className="inline-flex items-center gap-1 rounded-[5px] border border-brand/25 bg-brand/10 px-1.5 py-px text-[10px] font-medium text-foreground">
              <Layers className="size-2.5" /> All-in-one
            </span>
          )}
        </span>
        <span className="mt-1.5 line-clamp-2 text-[13px] leading-5 text-muted-foreground">{template.description}</span>
        {allInOne && (
          <span className="mt-2 line-clamp-3 text-xs leading-5 text-muted-foreground">
            <span className="font-medium text-foreground/80">{template.covers!.length} jobs:</span> {template.covers!.join(" · ")}
          </span>
        )}
        {template.routine && (
          <span className="mt-auto pt-2.5">
            <span className="inline-flex max-w-full items-center gap-1.5 rounded-[5px] border bg-secondary px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
              <CalendarClock className="size-3 shrink-0" />
              <span className="truncate">{cronToHuman(template.routine.cron)}</span>
            </span>
          </span>
        )}
      </span>
    </motion.button>
  );
}
