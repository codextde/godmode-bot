import type { Metadata } from "next";
import Link from "next/link";
import { KeyRound, MailPlus } from "lucide-react";
import { StatusBadge } from "@/components/data-display";
import { DataTable, type DataTableColumn } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { FilterTabs, ListToolbar, PAGE_SIZE, Pagination, SearchInput } from "@/components/list-controls";
import { PageBody, PageHeader } from "@/components/page";
import { RelativeTime } from "@/components/relative-time";
import { InfoRow, SettingsGroup } from "@/components/settings-kit";
import { Button } from "@/components/ui/button";
import { requirePermission } from "@/lib/session";
import type { Invite, Role } from "@/server/db";
import { listRoles } from "@/server/rbac";
import { can, canGrantRole, PAGE_PERMISSIONS } from "@/server/rbac/permissions";
import { getSettings } from "@/server/settings";
import { listInvites, type InviteStatus } from "@/server/users/invites";
import { grantableRoles } from "../users/capabilities";
import { InviteDialog } from "./_components/invite-dialog";
import { InviteRowActions } from "./_components/invite-row-actions";

export const metadata: Metadata = { title: "Invites" };

type Row = Invite & { role: Role; inviter: string | null; status: InviteStatus };

const STATUSES: InviteStatus[] = ["pending", "accepted", "expired", "revoked"];

const EMPTY: Record<InviteStatus, string> = {
  pending: "No invitation is waiting to be accepted.",
  accepted: "Nobody has accepted an invitation yet.",
  expired: "No invitation has expired.",
  revoked: "No invitation was revoked.",
};

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

export default async function InvitesPage({ searchParams }: PageProps<"/admin/invites">) {
  const ctx = await requirePermission(PAGE_PERMISSIONS["/admin/invites"]);
  const params = await searchParams;
  const q = first(params.q).trim();
  const requested = first(params.status) as InviteStatus;
  const status: InviteStatus = STATUSES.includes(requested) ? requested : "pending";
  const page = Math.max(Number.parseInt(first(params.page), 10) || 1, 1);

  const [{ rows, total }, roles, auth, email] = await Promise.all([
    listInvites({ status, search: q, page, pageSize: PAGE_SIZE }),
    listRoles(),
    getSettings("auth"),
    getSettings("email"),
  ]);
  const grantable = grantableRoles(ctx, roles);
  const defaultRole = grantable.find((r) => r.id === "role_member") ?? grantable[grantable.length - 1];
  const domains = auth.allowedDomains;
  const domainList = domains.join(", ");

  const when: DataTableColumn<Row> =
    status === "accepted"
      ? { id: "when", header: "Accepted", card: "line", cell: (i) => <RelativeTime date={i.acceptedAt} /> }
      : status === "revoked"
        ? { id: "when", header: "Revoked", card: "line", cell: (i) => <RelativeTime date={i.revokedAt} /> }
        : { id: "when", header: status === "expired" ? "Expired" : "Expires", card: "line", cell: (i) => <RelativeTime date={i.expiresAt} /> };

  const columns: DataTableColumn<Row>[] = [
    { id: "email", header: "E-mail", title: true, cell: (i) => i.email },
    { id: "role", header: "Role", card: "line", cell: (i) => i.role.name },
    {
      id: "inviter",
      header: "Invited by",
      card: "line",
      hideBelow: "3xl",
      cell: (i) => i.inviter ?? <span className="text-muted-foreground">Someone who left</span>,
    },
    {
      id: "sent",
      header: "Last sent",
      card: false,
      hideBelow: "4xl",
      cell: (i) => <RelativeTime date={i.lastSentAt} fallback="Not e-mailed" />,
    },
    when,
  ];

  return (
    <>
      <PageHeader
        title="Invites"
        description="Invite people to this cloud and see who has not joined yet."
        icon={<MailPlus />}
        actions={
          grantable.length > 0 &&
          defaultRole && (
            <InviteDialog
              roles={grantable}
              defaultRoleId={defaultRole.id}
              defaultOpen={first(params.invite) === "1"}
              domainHint={domains.length > 0 ? `Only addresses at ${domainList} can join.` : null}
            />
          )
        }
      />
      <PageBody>
        <ListToolbar>
          <SearchInput placeholder="Search by e-mail…" aria-label="Search invitations" />
          <FilterTabs
            param="status"
            label="Invitation status"
            defaultValue="pending"
            options={[
              { value: "pending", label: "Pending" },
              { value: "accepted", label: "Accepted" },
              { value: "expired", label: "Expired" },
              { value: "revoked", label: "Revoked" },
            ]}
          />
        </ListToolbar>
        <DataTable
          caption={`Invitations: ${status}`}
          rows={rows}
          columns={columns}
          getRowId={(i) => i.id}
          rowActions={(i) => (
            <InviteRowActions
              invite={{ id: i.id, email: i.email }}
              canResend={(i.status === "pending" || i.status === "expired") && canGrantRole(ctx, i.role)}
              canRevoke={i.status === "pending"}
            />
          )}
          footer={<Pagination total={total} noun={["invitation", "invitations"]} />}
          empty={
            <EmptyState
              icon={<MailPlus />}
              title={q ? "No invitation matches this search." : EMPTY[status]}
              description={!q && status === "pending" ? "Use “Invite people” to send the first one." : undefined}
              action={
                q ? (
                  <Button variant="outline" asChild>
                    <Link href={status === "pending" ? "/admin/invites" : `/admin/invites?status=${status}`}>Clear search</Link>
                  </Button>
                ) : undefined
              }
            />
          }
        />

        <SettingsGroup
          title="Who can join"
          description="The sign-in rules that apply to invitations right now."
          icon={<KeyRound />}
          actions={
            can(ctx, PAGE_PERMISSIONS["/admin/settings/auth"]) ? (
              <Button variant="outline" size="sm" asChild>
                <Link href="/admin/settings/auth">Settings → Sign-in</Link>
              </Button>
            ) : (
              <StatusBadge tone="neutral" dot={false}>
                Changed by an owner
              </StatusBadge>
            )
          }
        >
          <InfoRow label="Sign-up">
            {auth.inviteOnly ? "Only invited people" : domains.length > 0 ? "Anyone at the allowed domains" : "Anyone with the address of this cloud"}
          </InfoRow>
          <InfoRow label="Allowed domains">{domains.length > 0 ? domainList : "Any e-mail domain"}</InfoRow>
          <InfoRow label="An invitation is valid for">
            {auth.inviteDays} {auth.inviteDays === 1 ? "day" : "days"}
          </InfoRow>
          <InfoRow label="Invitation e-mails">
            {email.transport === "smtp" ? "Sent by e-mail" : "Not set up — copy each invite link and send it yourself"}
          </InfoRow>
        </SettingsGroup>
      </PageBody>
    </>
  );
}
