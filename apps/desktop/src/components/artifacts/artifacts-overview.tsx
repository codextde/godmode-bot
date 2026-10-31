import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation } from "@tanstack/react-query";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { ArtifactSummary } from "@godmode/shared";
import { ARTIFACT_STARTERS, MASCOT_CHARACTER, MASCOT_COLOR } from "@godmode/shared";
import { AppWindow, ArrowUp, MoreHorizontal, Pin, PinOff, Search, Trash2 } from "lucide-react";
import { AgentAvatar, EmptyState } from "@/components/common";
import { Character } from "@/components/character";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AgentPicker } from "@/components/chat/agent-picker";
import { ArtifactThumb } from "@/components/artifacts/artifact-frame";
import { DeleteArtifactDialog, ago, useArtifactActions, useArtifactBusy } from "@/components/artifacts/artifact-view";
import { api, errorMessage } from "@/lib/api";
import { useAgents, useArtifact, useArtifacts } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";

/** Dashboards and small apps the agents built: a line to ask for a new one, then the gallery. */
const STARTER_TEXT = {
  sales: { title: "starters.sales.title", blurb: "starters.sales.blurb" },
  kpi: { title: "starters.kpi.title", blurb: "starters.kpi.blurb" },
  pipeline: { title: "starters.pipeline.title", blurb: "starters.pipeline.blurb" },
  budget: { title: "starters.budget.title", blurb: "starters.budget.blurb" },
  content: { title: "starters.content.title", blurb: "starters.content.blurb" },
  calculator: { title: "starters.calculator.title", blurb: "starters.calculator.blurb" },
} as const;

export function ArtifactsOverview() {
  const { t } = useTranslation(["artifacts", "common"]);
  const { data: artifacts, isLoading } = useArtifacts();
  const [query, setQuery] = useState("");
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return artifacts ?? [];
    return (artifacts ?? []).filter((a) => `${a.title} ${a.description} ${a.agentName ?? ""}`.toLowerCase().includes(q));
  }, [artifacts, query]);
  const empty = !isLoading && (artifacts?.length ?? 0) === 0;

  return (
    <div className="@container space-y-8">
      <Composer prominent={empty} />

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2 @5xl:grid-cols-3">
          {Array.from({ length: 2 }, (_, i) => (
            <Skeleton key={i} className="aspect-[16/11] rounded-xl" />
          ))}
        </div>
      ) : empty ? (
        <EmptyState
          art={<Character character={MASCOT_CHARACTER} color={MASCOT_COLOR} size={64} follow />}
          title={t("overview.emptyTitle")}
          description={t("overview.emptyDescription")}
        />
      ) : (
        <section className="space-y-3">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-medium">
              {t("overview.yourArtifacts")} <span className="ml-1 text-muted-foreground tabular-nums">{artifacts!.length}</span>
            </h3>
            {(artifacts?.length ?? 0) > 6 && (
              <div className="relative ml-auto w-56">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("common:actions.search")} className="h-8 pl-8 text-sm" />
              </div>
            )}
          </div>
          {list.length ? (
            <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2 @5xl:grid-cols-3">
              {list.map((a, i) => (
                <ArtifactTile key={a.id} artifact={a} index={i} />
              ))}
            </div>
          ) : (
            <p className="py-10 text-center text-sm text-muted-foreground">{t("overview.noMatch", { query })}</p>
          )}
        </section>
      )}
    </div>
  );
}

function Composer({ prominent }: { prominent: boolean }) {
  const { t } = useTranslation("artifacts");
  const navigate = useNavigate();
  const scope = useUi((s) => s.workspace);
  const { data: agents = [] } = useAgents();
  const usable = agents.filter((a) => a.enabled);
  const [agentId, setAgentId] = useState<string | null>(null);
  const picked = usable.find((a) => a.id === agentId) ?? usable.find((a) => a.isDefault) ?? usable[0];
  const [prompt, setPrompt] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  const start = useMutation({
    mutationFn: () =>
      api.artifacts.start({ prompt: prompt.trim(), agentId: picked?.id, workspaceId: scope !== "all" && scope !== "global" ? scope : null }),
    onSuccess: ({ conversationId }) => navigate(`/chat/${conversationId}`),
    onError: (err) => toast.error(t("overview.startError"), { description: errorMessage(err) }),
  });
  const submit = () => {
    if (prompt.trim() && !start.isPending) start.mutate();
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <section className={cn("rounded-2xl border bg-card shadow-card transition", prominent && "ring-4 ring-brand/8")}>
      <div className="p-3 pb-2">
        <Textarea
          ref={box}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={onKey}
          placeholder={t("overview.composerPlaceholder")}
          className="min-h-[76px] resize-none border-0 bg-transparent p-1.5 text-[15px] shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2.5">
        <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
          {ARTIFACT_STARTERS.map((s) => {
            const text = STARTER_TEXT[s.id as keyof typeof STARTER_TEXT];
            return (
              <button
                key={s.id}
                type="button"
                title={text ? t(text.blurb) : s.blurb}
                onClick={() => {
                  setPrompt(s.prompt);
                  box.current?.focus();
                }}
                className="rounded-full border bg-background px-2.5 py-1 text-xs text-muted-foreground transition hover:border-foreground/20 hover:text-foreground"
              >
                {text ? t(text.title) : s.title}
              </button>
            );
          })}
        </div>
        {usable.length > 1 && picked && <AgentPicker agents={usable} value={picked.id} onChange={setAgentId} />}
        <Button size="sm" onClick={submit} disabled={!prompt.trim() || start.isPending || !picked} className="gap-1.5">
          {start.isPending ? <Spinner /> : <ArrowUp />} {t("overview.buildIt")}
        </Button>
      </div>
    </section>
  );
}

/** True once the element came near the screen (and stays true): tiles load their artifact only then. */
function useSeen<T extends Element>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && setSeen(true), { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen] as const;
}

function ArtifactTile({ artifact, index }: { artifact: ArtifactSummary; index: number }) {
  const { t } = useTranslation(["artifacts", "common"]);
  const [box, seen] = useSeen<HTMLDivElement>();
  const { data: full } = useArtifact(seen ? artifact.id : null);
  const actions = useArtifactActions(artifact);
  const busy = useArtifactBusy(artifact);
  const { data: agents = [] } = useAgents("all");
  const agent = agents.find((a) => a.id === artifact.agentId);
  const [deleting, setDeleting] = useState(false);

  return (
    <motion.article
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index, 8) * 0.03 }}
      className="group relative overflow-hidden rounded-xl border bg-card shadow-card transition hover:-translate-y-0.5 hover:border-foreground/15 hover:shadow-lg"
    >
      <Link to={`/artifacts/${artifact.id}`} className="block outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <div ref={box} className="relative aspect-[16/10] border-b bg-background">
          {full ? (
            <ArtifactThumb html={full.html} data={full.data} title={artifact.title} className="absolute inset-0" />
          ) : (
            <Skeleton className="absolute inset-0 rounded-none" />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/[0.04] to-transparent" />
          {busy && (
            <span className="absolute top-2.5 left-2.5 inline-flex items-center gap-1.5 rounded-full border bg-card/95 px-2 py-0.5 text-[11px] font-medium text-brand-strong shadow-sm backdrop-blur">
              <Spinner className="size-3" /> {t("tile.updating")}
            </span>
          )}
        </div>
        <div className="flex items-start gap-3 p-3.5">
          <div className="min-w-0 flex-1">
            <h3 className="flex items-center gap-1.5 truncate text-sm font-medium tracking-[-0.01em]">
              {artifact.pinned && <Pin className="size-3 shrink-0 text-muted-foreground" />}
              <span className="truncate">{artifact.title}</span>
            </h3>
            <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{artifact.description || t("version", { version: artifact.version })}</p>
            <div className="mt-2.5 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
              {agent && <AgentAvatar agent={agent} size="sm" className="size-4" />}
              <span className="truncate">{artifact.agentName ?? t("common:words.agent")}</span>
              <span aria-hidden>·</span>
              <span className="shrink-0">{ago(artifact.updatedAt)}</span>
            </div>
          </div>
        </div>
      </Link>
      <div className="absolute right-2 bottom-2.5 opacity-0 transition group-focus-within:opacity-100 group-hover:opacity-100">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={t("more")}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => actions.pin.mutate(!artifact.pinned)}>
              {artifact.pinned ? <PinOff /> : <Pin />} {artifact.pinned ? t("unpin") : t("pinToTop")}
            </DropdownMenuItem>
            {artifact.conversationId && (
              <DropdownMenuItem asChild>
                <Link to={`/chat/${artifact.conversationId}`}>
                  <AppWindow /> {t("openChat")}
                </Link>
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
              <Trash2 /> {t("common:actions.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <DeleteArtifactDialog artifact={artifact} open={deleting} onOpenChange={setDeleting} />
    </motion.article>
  );
}
