import type { Metadata } from "next";
import Link from "next/link";
import { Laptop, Power, PowerOff, Trash2 } from "lucide-react";
import { AutoRefresh } from "@/components/auto-refresh";
import { StatusBadge } from "@/components/data-display";
import { DataTable, type DataTableColumn } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { FilterSelect, FilterSheet, ListToolbar, PAGE_SIZE, Pagination, SearchInput } from "@/components/list-controls";
import { PageBody, PageHeader } from "@/components/page";
import { RelativeTime } from "@/components/relative-time";
import { RowActions } from "@/components/row-actions";
import { Callout } from "@/components/settings-kit";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format";
import { requirePermission } from "@/lib/session";
import type { Device, User } from "@/server/db";
import { adminListDevices } from "@/server/devices";
import { can, PAGE_PERMISSIONS } from "@/server/rbac/permissions";
import { relayHub } from "@/server/relay-bridge";
import { usageTotals } from "@/server/usage";
import { removeDeviceAction, setDeviceStatusAction } from "./actions";

export const metadata: Metadata = { title: "Computers" };

type Row = Device & { owner: User };

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

export default async function AdminComputersPage({ searchParams }: PageProps<"/admin/devices">) {
  const ctx = await requirePermission(PAGE_PERMISSIONS["/admin/devices"]);
  const params = await searchParams;
  const q = first(params.q).trim();
  const requested = first(params.status);
  const status = requested === "active" || requested === "disabled" ? requested : undefined;
  const page = Math.max(Number.parseInt(first(params.page), 10) || 1, 1);

  const { rows, total } = await adminListDevices({ search: q, status, page, pageSize: PAGE_SIZE });
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const traffic = await usageTotals(rows.map((r) => r.id), monthStart);
  const hub = relayHub();
  const manage = can(ctx, "devices.manage");
  const seePeople = can(ctx, "users.read");
  const filtered = Boolean(q || status);

  const columns: DataTableColumn<Row>[] = [
    { id: "name", header: "Computer", title: true, cell: (d) => d.name },
    {
      id: "owner",
      header: "Owner",
      card: "line",
      cell: (d) =>
        seePeople ? (
          <Link href={`/admin/users/${d.owner.id}`} className="relative underline-offset-4 hover:underline">
            {d.owner.email}
          </Link>
        ) : (
          d.owner.email
        ),
    },
    {
      id: "state",
      header: "Status",
      card: "aside",
      cell: (d) =>
        d.status === "disabled" ? (
          <StatusBadge tone="warning">Turned off</StatusBadge>
        ) : hub.isOnline(d.id) ? (
          <StatusBadge tone="positive" live>
            Online
          </StatusBadge>
        ) : (
          <StatusBadge tone="neutral">Offline</StatusBadge>
        ),
    },
    {
      id: "version",
      header: "Version",
      mono: true,
      card: false,
      hideBelow: "4xl",
      cell: (d) => d.appVersion || <span className="text-muted-foreground">—</span>,
    },
    { id: "seen", header: "Last seen", card: "line", hideBelow: "3xl", cell: (d) => <RelativeTime date={d.lastSeenAt} /> },
    {
      id: "traffic",
      header: "Traffic this month",
      align: "right",
      mono: true,
      card: "line",
      cell: (d) => formatBytes((traffic[d.id]?.bytesIn ?? 0) + (traffic[d.id]?.bytesOut ?? 0)),
    },
  ];

  return (
    <>
      <AutoRefresh seconds={20} />
      <PageHeader
        title="Computers"
        description="Every computer linked to this cloud. You see details only; nobody can open someone else's computer from here."
        icon={<Laptop />}
      />
      <PageBody>
        <ListToolbar>
          <SearchInput placeholder="Search by name or owner…" aria-label="Search computers" />
          <FilterSheet params={["status"]}>
            <FilterSelect
              param="status"
              label="Status"
              allLabel="Any status"
              options={[
                { value: "active", label: "Turned on" },
                { value: "disabled", label: "Turned off" },
              ]}
            />
          </FilterSheet>
        </ListToolbar>
        {!manage && (
          <Callout tone="muted" title="You can look, not change">
            Your role lets you see linked computers. Turning one off or removing it needs the permission to manage computers.
          </Callout>
        )}
        <DataTable
          caption="Linked computers"
          rows={rows}
          columns={columns}
          getRowId={(d) => d.id}
          rowActions={
            manage
              ? (d) => (
                  <RowActions
                    label={`Actions for ${d.name}`}
                    items={[
                      d.status === "active"
                        ? {
                            label: "Turn off",
                            icon: <PowerOff />,
                            confirm: {
                              title: `Turn off ${d.name}?`,
                              description: `The cloud disconnects this computer and refuses its link until someone turns it on again. Godmode keeps working on the computer itself. Its owner is ${d.owner.email}.`,
                              confirmLabel: "Turn off",
                              pendingLabel: "Turning off…",
                              onConfirm: setDeviceStatusAction.bind(null, d.id, "disabled"),
                            },
                            successMessage: "Computer turned off",
                          }
                        : {
                            label: "Turn on",
                            icon: <Power />,
                            onSelect: setDeviceStatusAction.bind(null, d.id, "active"),
                            successMessage: "Computer turned on",
                          },
                      {
                        label: "Remove",
                        icon: <Trash2 />,
                        tone: "danger",
                        separator: true,
                        confirm: {
                          title: `Remove ${d.name}?`,
                          description: `This unlinks the computer from ${d.owner.email}. To use it with this cloud again it has to be linked again in Godmode on that computer.`,
                          confirmLabel: "Remove",
                          pendingLabel: "Removing…",
                          onConfirm: removeDeviceAction.bind(null, d.id),
                        },
                        successMessage: "Computer removed",
                      },
                    ]}
                  />
                )
              : undefined
          }
          footer={<Pagination total={total} noun={["computer", "computers"]} />}
          empty={
            <EmptyState
              icon={<Laptop />}
              title={filtered ? "No computer matches this search." : "No computer is linked yet."}
              description={filtered ? undefined : "People link their computers in Godmode under Settings → Cloud."}
              action={
                filtered ? (
                  <Button variant="outline" asChild>
                    <Link href="/admin/devices">Clear search and filters</Link>
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
