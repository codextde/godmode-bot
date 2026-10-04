import type { Metadata } from "next";
import Link from "next/link";
import { Download, ScrollText } from "lucide-react";
import { DataTable, type DataTableColumn } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { FilterSelect, FilterSheet, ListToolbar, PAGE_SIZE, Pagination, SearchInput } from "@/components/list-controls";
import { PageBody, PageHeader } from "@/components/page";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { requirePermission } from "@/lib/session";
import { AUDIT_ACTIONS, listAudit } from "@/server/audit";
import type { AuditEntry } from "@/server/db";
import { can, PAGE_PERMISSIONS } from "@/server/rbac/permissions";
import { AuditMeta } from "./_components/audit-meta";

export const metadata: Metadata = { title: "Audit log" };

const ACTION_LABELS = new Map<string, string>(AUDIT_ACTIONS.map((a) => [a.action, a.label]));

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

/** Where a target id leads, for the kinds that have a page of their own. */
function targetHref(entry: AuditEntry, seePeople: boolean): string | null {
  if (entry.targetType === "user" && entry.targetId && seePeople) return `/admin/users/${entry.targetId}`;
  return null;
}

export default async function AuditPage({ searchParams }: PageProps<"/admin/audit">) {
  const ctx = await requirePermission(PAGE_PERMISSIONS["/admin/audit"]);
  const params = await searchParams;
  const q = first(params.q).trim();
  const requested = first(params.action);
  const action = ACTION_LABELS.has(requested) ? requested : "";
  const page = Math.max(Number.parseInt(first(params.page), 10) || 1, 1);

  const { rows, total } = await listAudit({ search: q, action: action || undefined, page, pageSize: PAGE_SIZE });
  const seePeople = can(ctx, "users.read");
  const filtered = Boolean(q || action);

  const exportQuery = new URLSearchParams();
  if (q) exportQuery.set("q", q);
  if (action) exportQuery.set("action", action);
  const exportHref = `/admin/audit/export${exportQuery.size ? `?${exportQuery}` : ""}`;

  const columns: DataTableColumn<AuditEntry>[] = [
    { id: "action", header: "What", title: true, cell: (e) => ACTION_LABELS.get(e.action) ?? e.action },
    { id: "at", header: "When", card: "aside", cell: (e) => <RelativeTime date={e.at} className="text-muted-foreground" /> },
    { id: "actor", header: "Who", card: "line", cell: (e) => <span className="[overflow-wrap:anywhere]">{e.actor}</span> },
    {
      id: "target",
      header: "Target",
      card: "line",
      mono: true,
      cell: (e) => {
        if (!e.targetId) return <span className="text-muted-foreground">—</span>;
        const href = targetHref(e, seePeople);
        const text = e.targetType ? `${e.targetType} ${e.targetId}` : e.targetId;
        return href ? (
          <Link href={href} className="relative underline-offset-4 hover:underline">
            {text}
          </Link>
        ) : (
          text
        );
      },
    },
    { id: "ip", header: "Address", mono: true, card: false, hideBelow: "4xl", cell: (e) => e.ip ?? <span className="text-muted-foreground">—</span> },
    { id: "meta", header: "Details", card: "line", cell: (e) => <AuditMeta meta={e.meta} /> },
  ];

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Who did what on this cloud: sign-ins, invitations, role and settings changes, computers and billing."
        icon={<ScrollText />}
      />
      <PageBody>
        <ListToolbar>
          <SearchInput placeholder="Search by person, action, target or address…" aria-label="Search the audit log" />
          <div className="flex items-center gap-2">
            <FilterSheet params={["action"]}>
              <FilterSelect
                param="action"
                label="Action"
                allLabel="All actions"
                options={AUDIT_ACTIONS.map((a) => ({ value: a.action, label: a.label }))}
                className="@2xl:w-56"
              />
            </FilterSheet>
            <Button variant="outline" asChild>
              {/* A plain link: the route answers with a file, not a page. */}
              <a href={exportHref} download>
                <Download />
                Export CSV
              </a>
            </Button>
          </div>
        </ListToolbar>
        <DataTable
          caption="Audit log"
          rows={rows}
          columns={columns}
          getRowId={(e) => String(e.id)}
          footer={<Pagination total={total} noun={["entry", "entries"]} />}
          empty={
            <EmptyState
              icon={<ScrollText />}
              title={filtered ? "No entry matches this search." : "Nothing has been recorded yet."}
              description={filtered ? undefined : "Entries appear as soon as someone signs in or changes something."}
              action={
                filtered ? (
                  <Button variant="outline" asChild>
                    <Link href="/admin/audit">Clear search and filter</Link>
                  </Button>
                ) : undefined
              }
            />
          }
        />
      </PageBody>
    </>
  );
}
