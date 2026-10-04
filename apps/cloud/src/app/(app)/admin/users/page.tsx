import type { Metadata } from "next";
import Link from "next/link";
import { Download, MailPlus, Users } from "lucide-react";
import { StatusBadge } from "@/components/data-display";
import { DataTable, type DataTableColumn } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { FilterSelect, FilterSheet, ListToolbar, PAGE_SIZE, Pagination, SearchInput } from "@/components/list-controls";
import { PageBody, PageHeader } from "@/components/page";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { formatNumber } from "@/lib/format";
import { requirePermission } from "@/lib/session";
import type { Role, User } from "@/server/db";
import { listRoles } from "@/server/rbac";
import { can, PAGE_PERMISSIONS } from "@/server/rbac/permissions";
import { listUsers } from "@/server/users";
import { UserActions } from "./_components/user-actions";
import { grantableRoles, userCapabilities } from "./capabilities";
import { actionsTarget, givablePlans, plansOf } from "./data";

export const metadata: Metadata = { title: "People" };

type Row = User & { role: Role; deviceCount: number };

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

export default async function PeoplePage({ searchParams }: PageProps<"/admin/users">) {
  const ctx = await requirePermission(PAGE_PERMISSIONS["/admin/users"]);
  const params = await searchParams;
  const q = first(params.q).trim();
  const roleId = first(params.role);
  const status = first(params.status);
  const page = Math.max(Number.parseInt(first(params.page), 10) || 1, 1);

  const canGivePlans = can(ctx, "billing.manage");
  const [{ rows, total }, roles, plans] = await Promise.all([
    listUsers({ search: q, roleId: roleId || undefined, status: status || undefined, page, pageSize: PAGE_SIZE }),
    listRoles(),
    canGivePlans ? givablePlans() : Promise.resolve([]),
  ]);
  const { billingOn, byUser } = await plansOf(rows.map((r) => r.id));
  const grantable = grantableRoles(ctx, roles);
  const filtered = Boolean(q || roleId || status);

  const exportQuery = new URLSearchParams();
  if (q) exportQuery.set("q", q);
  if (roleId) exportQuery.set("role", roleId);
  if (status) exportQuery.set("status", status);
  const exportHref = `/admin/users/export${exportQuery.size ? `?${exportQuery}` : ""}`;

  const columns: DataTableColumn<Row>[] = [
    {
      id: "name",
      header: "Name",
      title: true,
      cell: (u) => (
        <>
          {u.name || u.email}
          {u.id === ctx.user.id && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(you)</span>}
        </>
      ),
    },
    { id: "email", header: "E-mail", cell: (u) => <span className="text-muted-foreground">{u.email}</span>, card: "line" },
    { id: "role", header: "Role", cell: (u) => u.role.name, card: "line" },
    {
      id: "status",
      header: "Status",
      card: "aside",
      cell: (u) => (u.status === "active" ? <StatusBadge tone="neutral">Active</StatusBadge> : <StatusBadge tone="danger">Suspended</StatusBadge>),
    },
    {
      id: "plan",
      header: "Plan",
      hideBelow: "4xl",
      card: false,
      cell: (u) => (billingOn ? (byUser.get(u.id)?.plan.name ?? "—") : <span className="text-muted-foreground">Unlimited</span>),
    },
    { id: "computers", header: "Computers", align: "right", mono: true, hideBelow: "3xl", card: false, cell: (u) => formatNumber(u.deviceCount) },
    { id: "seen", header: "Last sign-in", hideBelow: "3xl", card: "line", cell: (u) => <RelativeTime date={u.lastLoginAt} /> },
  ];

  return (
    <>
      <PageHeader
        title="People"
        description="Everyone with an account on this cloud, their role and what they use."
        icon={<Users />}
        actions={
          can(ctx, "invites.manage") && (
            <Button asChild>
              <Link href="/admin/invites?invite=1">
                <MailPlus />
                Invite people
              </Link>
            </Button>
          )
        }
      />
      <PageBody>
        <ListToolbar>
          <SearchInput placeholder="Search by name or e-mail…" aria-label="Search people" />
          <div className="flex items-center gap-2">
            <FilterSheet params={["role", "status"]}>
              <FilterSelect param="role" label="Role" allLabel="All roles" options={roles.map((r) => ({ value: r.id, label: r.name }))} />
              <FilterSelect
                param="status"
                label="Status"
                allLabel="Any status"
                options={[
                  { value: "active", label: "Active" },
                  { value: "suspended", label: "Suspended" },
                ]}
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
          caption="People"
          rows={rows}
          columns={columns}
          getRowId={(u) => u.id}
          rowHref={(u) => `/admin/users/${u.id}`}
          rowActions={(u) => (
            <UserActions
              user={actionsTarget(u)}
              caps={userCapabilities(ctx, u)}
              roles={grantable}
              plans={plans}
              billingOn={billingOn}
              openLink
            />
          )}
          footer={<Pagination total={total} noun={["person", "people"]} />}
          empty={
            <EmptyState
              icon={<Users />}
              title={filtered ? "No one matches this search." : "No one has an account yet."}
              description={filtered ? "Try another name, or clear the filters." : undefined}
              action={
                filtered ? (
                  <Button variant="outline" asChild>
                    <Link href="/admin/users">Clear search and filters</Link>
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
