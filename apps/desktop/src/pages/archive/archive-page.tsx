import { useMemo, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { formatDistanceToNowStrict } from "date-fns";
import { Archive, ArchiveRestore, RefreshCw, Workflow } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Agent } from "@godmode/shared";
import { AgentAvatar, EmptyState, PageBody, PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { archiveCount, useArchive, useArchiveList, type ArchiveTarget } from "@/components/archive/use-archive";
import { errorMessage } from "@/lib/api";
import { useAllAgents, useWorkspaces } from "@/lib/hooks";
import { useLocale } from "@/i18n/language";

interface Row {
  target: ArchiveTarget;
  icon: ReactNode;
  meta?: string;
  archivedAt: string | null;
  open?: () => void;
}

const glyph = (icon: string) => <span className="grid size-6 shrink-0 place-items-center text-base leading-none">{icon}</span>;

export default function ArchivePage() {
  const { t } = useTranslation(["archive", "common"]);
  const navigate = useNavigate();
  const archive = useArchiveList();
  const { restore, pending } = useArchive();
  const { data: workspaces = [] } = useWorkspaces();
  const { data: agents = [] } = useAllAgents();
  const list = archive.data;

  const sections = useMemo(() => {
    if (!list) return [];
    // Names of what is still around, and of what is archived alongside.
    const workspaceName = new Map([...workspaces, ...list.workspaces].map((w) => [w.id, `${w.icon} ${w.name}`]));
    const agentById = new Map<string, Agent>([...agents, ...list.agents].map((a) => [a.id, a]));
    const out: { key: string; label: string; rows: Row[] }[] = [
      {
        key: "workspaces",
        label: t("sections.workspaces"),
        rows: list.workspaces.map((w) => ({
          target: { kind: "workspace", id: w.id, name: w.name },
          icon: glyph(w.icon),
          meta: w.projects.length ? t("projectCount", { count: w.projects.length }) : undefined,
          archivedAt: w.archivedAt,
        })),
      },
      {
        key: "projects",
        label: t("sections.projects"),
        rows: list.projects.map((p) => ({
          target: { kind: "project", id: p.id, name: p.name },
          icon: glyph(p.icon),
          meta: workspaceName.get(p.workspaceId),
          archivedAt: p.archivedAt,
        })),
      },
      {
        key: "agents",
        label: t("sections.agents"),
        rows: list.agents.map((a) => ({
          target: { kind: "agent", id: a.id, name: a.name },
          icon: <AgentAvatar agent={a} size="sm" still className="size-6 rounded-md text-xs" />,
          meta: [a.role, a.workspaceId ? workspaceName.get(a.workspaceId) : undefined].filter(Boolean).join(" · ") || undefined,
          archivedAt: a.archivedAt,
          open: () => navigate(`/agents/${a.id}`),
        })),
      },
      {
        key: "routines",
        label: t("sections.routines"),
        rows: list.routines.map((r) => ({
          target: { kind: "routine", id: r.id, name: r.name },
          icon: (
            <span className="grid size-6 shrink-0 place-items-center rounded-md border bg-muted text-muted-foreground">
              <Workflow className="size-3.5" />
            </span>
          ),
          meta: agentById.get(r.agentId)?.name,
          archivedAt: r.archivedAt,
        })),
      },
    ];
    return out.filter((s) => s.rows.length);
  }, [list, workspaces, agents, navigate, t]);

  return (
    <>
      <PageHeader icon={<Archive />} title={t("title")} />
      <PageBody>
        {archive.isLoading ? (
          <div className="max-w-4xl space-y-2">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-12 w-full rounded-xl" />
            ))}
          </div>
        ) : archive.isError ? (
          <EmptyState
            icon={<Archive />}
            title={t("loadError")}
            description={errorMessage(archive.error)}
            action={
              <Button variant="outline" onClick={() => archive.refetch()}>
                <RefreshCw /> {t("common:actions.tryAgain")}
              </Button>
            }
            className="max-w-4xl"
          />
        ) : archiveCount(list) === 0 ? (
          <EmptyState icon={<Archive />} title={t("empty")} className="max-w-4xl" />
        ) : (
          <div className="max-w-4xl space-y-6">
            {sections.map((s) => (
              <section key={s.key}>
                <h2 className="eyebrow mb-2 px-1">{s.label}</h2>
                <div className="space-y-0.5 rounded-xl border bg-card p-1.5 shadow-card">
                  <AnimatePresence initial={false}>
                    {s.rows.map((row) => (
                      <ArchiveRow key={row.target.id} row={row} busy={pending === row.target.id} onRestore={() => restore(row.target)} />
                    ))}
                  </AnimatePresence>
                </div>
              </section>
            ))}
          </div>
        )}
      </PageBody>
    </>
  );
}

function ArchiveRow({ row, busy, onRestore }: { row: Row; busy: boolean; onRestore: () => void }) {
  const { t } = useTranslation("archive");
  const { dateLocale, intlLocale } = useLocale();
  const when = row.archivedAt ? new Date(row.archivedAt) : null;
  const body = (
    <>
      {row.icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium tracking-[-0.01em]">{row.target.name}</span>
        {row.meta && <span className="mt-0.5 block truncate text-[12.5px] text-muted-foreground">{row.meta}</span>}
      </span>
      {when && (
        <span
          className="w-24 shrink-0 text-right text-xs text-muted-foreground tabular-nums transition-opacity group-focus-within:opacity-0 group-hover:opacity-0"
          title={t("archivedAt", { date: when.toLocaleString(intlLocale) })}
        >
          {formatDistanceToNowStrict(when, { addSuffix: true, locale: dateLocale })}
        </span>
      )}
    </>
  );
  const rowClass = "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left";
  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, height: 0, transition: { duration: 0.18 } }}
      className="group relative overflow-hidden rounded-lg"
    >
      {row.open ? (
        <button
          type="button"
          onClick={row.open}
          className={`${rowClass} transition group-hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none`}
        >
          {body}
        </button>
      ) : (
        <div className={`${rowClass} transition group-hover:bg-accent/50`}>{body}</div>
      )}
      <div className="absolute inset-y-0 right-2 flex items-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        <Button size="xs" variant="outline" className="bg-card" disabled={busy} onClick={onRestore}>
          <ArchiveRestore /> {t("restore")}
        </Button>
      </div>
    </motion.div>
  );
}
