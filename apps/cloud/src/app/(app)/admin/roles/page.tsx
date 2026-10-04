import type { Metadata } from "next";
import Link from "next/link";
import { Plus, ShieldCheck } from "lucide-react";
import { PageBody, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { formatNumber } from "@/lib/format";
import { requirePermission } from "@/lib/session";
import { cn } from "@/lib/utils";
import { listRoles } from "@/server/rbac";
import { can, effectivePermissions, isOwner, PAGE_PERMISSIONS, PERMISSIONS } from "@/server/rbac/permissions";
import { NewRoleDialog, type RoleSource } from "./_components/new-role-dialog";
import { RoleEditor } from "./_components/role-editor";

export const metadata: Metadata = { title: "Roles" };

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

export default async function RolesPage({ searchParams }: PageProps<"/admin/roles">) {
  const ctx = await requirePermission(PAGE_PERMISSIONS["/admin/roles"]);
  const params = await searchParams;
  const roles = await listRoles();
  const selected = roles.find((r) => r.id === first(params.role)) ?? roles[0];
  const sources: RoleSource[] = roles.map((r) => ({ id: r.id, name: r.name, permissions: effectivePermissions(r) }));
  const seePeople = can(ctx, "users.read");

  return (
    <>
      <PageHeader
        title="Roles"
        description="A role decides what someone may do. Choose a role to see and change its permissions."
        icon={<ShieldCheck />}
        actions={
          <NewRoleDialog
            sources={sources}
            trigger={
              <Button>
                <Plus />
                New role
              </Button>
            }
          />
        }
      />
      <PageBody>
        <nav aria-label="Roles">
          <ul className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @5xl:grid-cols-4">
            {roles.map((role) => {
              const active = role.id === selected?.id;
              const granted = effectivePermissions(role).length;
              return (
                <li key={role.id} className="relative">
                  <Link
                    href={`/admin/roles?role=${encodeURIComponent(role.id)}#role-editor`}
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      "animate-enter flex h-full flex-col gap-2 rounded-xl border bg-card p-4 shadow-card outline-none transition-colors hover:border-foreground/15 focus-visible:ring-[3px] focus-visible:ring-ring/50",
                      active && "border-foreground/40 ring-1 ring-foreground/10 hover:border-foreground/40",
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="min-w-0 text-[15px] font-medium tracking-[-0.01em] [overflow-wrap:anywhere]">{role.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{role.system ? "Built-in" : "Custom"}</span>
                    </span>
                    <span className="line-clamp-2 min-h-8 text-xs leading-relaxed text-muted-foreground">
                      {role.description || "No description."}
                    </span>
                    <span className="mt-auto flex items-center justify-between gap-2 pt-1 text-xs text-muted-foreground">
                      <span>
                        <span className="font-mono text-foreground tabular-nums">{formatNumber(role.userCount)}</span>{" "}
                        {role.userCount === 1 ? "person" : "people"}
                      </span>
                      <span>
                        <span className="font-mono tabular-nums">
                          {granted}/{PERMISSIONS.length}
                        </span>{" "}
                        permissions
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {selected && (
          <>
            <RoleEditor
              // A fresh editor per role and per saved version, so its state never shows another role's boxes.
              key={`${selected.id}:${selected.updatedAt.getTime()}`}
              role={{
                id: selected.id,
                key: selected.key,
                name: selected.name,
                description: selected.description,
                system: selected.system,
                permissions: effectivePermissions(selected),
              }}
              actor={{ owner: isOwner(ctx), roleId: ctx.role.id, permissions: [...ctx.role.permissions] }}
              sources={sources}
            />
            {seePeople && selected.userCount > 0 && (
              <p className="text-sm text-muted-foreground">
                <Link
                  href={`/admin/users?role=${encodeURIComponent(selected.id)}`}
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                >
                  See the {selected.userCount === 1 ? "person" : `${formatNumber(selected.userCount)} people`} with this role
                </Link>
              </p>
            )}
          </>
        )}
      </PageBody>
    </>
  );
}
