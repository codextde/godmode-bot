"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { StatusBadge } from "@/components/data-display";
import { Callout, SettingRow, SettingsGroup } from "@/components/settings-kit";
import { SubmitButton } from "@/components/submit-button";
import { UnsavedGuard } from "@/components/unsaved-guard";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { PERMISSIONS, type Permission } from "@/server/rbac/permissions";
import { deleteRoleAction, updateRoleAction } from "../actions";
import { NewRoleDialog, type RoleSource } from "./new-role-dialog";

export interface EditableRole {
  id: string;
  key: string;
  name: string;
  description: string;
  system: boolean;
  /** The permissions the role really has (owners: all). */
  permissions: string[];
}

const GROUPS = [...new Set(PERMISSIONS.map((p) => p.group))];

/** Admin-area permissions do nothing for someone who cannot open the admin area. */
const NEEDS_ADMIN_ACCESS = PERMISSIONS.filter((p) => p.group !== "Personal" && p.key !== "admin.access").map((p) => p.key as string);

/**
 * The permission editor of one role: checkboxes grouped as in PERMISSIONS, an explicit Save, Duplicate and (custom
 * roles) Delete. The owner role is fixed; a permission the signed-in person does not hold cannot be switched.
 */
export function RoleEditor({
  role,
  actor,
  sources,
}: {
  role: EditableRole;
  actor: { owner: boolean; roleId: string; permissions: string[] };
  sources: RoleSource[];
}) {
  const router = useRouter();
  const [name, setName] = useState(role.name);
  const [description, setDescription] = useState(role.description);
  const [checked, setChecked] = useState<Set<string>>(() => new Set(role.permissions));
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const isOwnerRole = role.key === "owner";
  const ownRole = !actor.owner && actor.roleId === role.id;
  const locked = isOwnerRole || ownRole;
  const mayToggle = (key: string) => !locked && (actor.owner || actor.permissions.includes(key));

  const permissionsDirty = useMemo(() => {
    const before = new Set(role.permissions);
    return before.size !== checked.size || [...checked].some((p) => !before.has(p));
  }, [checked, role.permissions]);
  const nameDirty = name.trim() !== role.name;
  const descriptionDirty = description.trim() !== role.description;
  const dirty = !locked && (permissionsDirty || nameDirty || descriptionDirty);
  const hasGreyed = !locked && !actor.owner && PERMISSIONS.some((p) => !actor.permissions.includes(p.key));
  const adminOnlyWithoutAccess = !checked.has("admin.access") && NEEDS_ADMIN_ACCESS.some((p) => checked.has(p));

  const toggle = (key: Permission, on: boolean) =>
    setChecked((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const reset = () => {
    setName(role.name);
    setDescription(role.description);
    setChecked(new Set(role.permissions));
    setFields({});
    setError(null);
  };

  const save = () => {
    setError(null);
    setFields({});
    startTransition(async () => {
      const result = await updateRoleAction(role.id, {
        ...(nameDirty ? { name } : {}),
        ...(descriptionDirty ? { description } : {}),
        ...(permissionsDirty ? { permissions: [...checked] } : {}),
      });
      if (!result.ok) {
        setFields(result.fields ?? {});
        if (!result.fields?.name && !result.fields?.description) setError(result.error);
        return;
      }
      toast.success("Saved");
    });
  };

  return (
    <SettingsGroup
      id="role-editor"
      title={role.name}
      description={role.description || (role.system ? "A built-in role." : "A custom role.")}
      icon={<ShieldCheck />}
      actions={
        <StatusBadge tone="neutral" dot={false}>
          {role.system ? "Built-in" : "Custom"}
        </StatusBadge>
      }
      footer={
        <>
          {!role.system && (
            <ConfirmDialog
              trigger={
                <Button variant="ghost" className="mr-auto text-destructive hover:text-destructive" disabled={pending}>
                  <Trash2 />
                  Delete
                </Button>
              }
              title={`Delete the role “${role.name}”?`}
              description="A role can only be deleted when nobody has it and no invitation is waiting for it."
              confirmLabel="Delete role"
              pendingLabel="Deleting…"
              tone="danger"
              onConfirm={async () => {
                const result = await deleteRoleAction(role.id);
                if (result.ok) router.push("/admin/roles");
                return result;
              }}
              successMessage="Role deleted"
            />
          )}
          <NewRoleDialog
            title={`Duplicate “${role.name}”`}
            from={sources.find((s) => s.id === role.id)}
            sources={sources}
            trigger={
              <Button variant="outline" disabled={pending}>
                <Copy />
                Duplicate
              </Button>
            }
          />
          {!locked && (
            <>
              {dirty && (
                <Button variant="ghost" onClick={reset} disabled={pending}>
                  Discard
                </Button>
              )}
              <SubmitButton type="button" onClick={save} pending={pending} pendingLabel="Saving…" disabled={!dirty}>
                Save
              </SubmitButton>
            </>
          )}
        </>
      }
    >
      <UnsavedGuard when={dirty} />
      {(isOwnerRole || ownRole || error) && (
        <div className="flex flex-col gap-3 py-4">
          {isOwnerRole && (
            <Callout tone="info" title="Owners can always do everything">
              This role cannot be changed. It also covers the sign-in, e-mail and security settings, which no permission below grants.
            </Callout>
          )}
          {ownRole && (
            <Callout tone="muted" title="This is your own role">
              You can&apos;t edit the role you have yourself. Ask an owner to change it.
            </Callout>
          )}
          {error && <Callout tone="danger" title={error} />}
        </div>
      )}

      {!role.system && (
        <>
          <SettingRow label="Name" htmlFor="role-name" stacked>
            <Input
              id="role-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              disabled={locked || pending}
              aria-invalid={fields.name ? true : undefined}
              aria-describedby={fields.name ? "role-name-error" : undefined}
              className="text-base md:text-sm @xl:max-w-sm"
            />
            {fields.name && (
              <p id="role-name-error" role="alert" className="mt-2 text-xs text-destructive">
                {fields.name}
              </p>
            )}
          </SettingRow>
          <SettingRow label="Description" htmlFor="role-description" stacked>
            <Input
              id="role-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={200}
              disabled={locked || pending}
              aria-invalid={fields.description ? true : undefined}
              aria-describedby={fields.description ? "role-description-error" : undefined}
              className="text-base md:text-sm"
            />
            {fields.description && (
              <p id="role-description-error" role="alert" className="mt-2 text-xs text-destructive">
                {fields.description}
              </p>
            )}
          </SettingRow>
        </>
      )}

      {GROUPS.map((group) => (
        <div key={group} role="group" aria-labelledby={`perm-group-${group}`} className="py-4">
          <h3 id={`perm-group-${group}`} className="eyebrow mb-2 text-[10.5px]">
            {group}
          </h3>
          <div className="grid grid-cols-1 gap-x-6 @2xl:grid-cols-2">
            {PERMISSIONS.filter((p) => p.group === group).map((p) => {
              const inputId = `perm-${p.key}`;
              const enabled = mayToggle(p.key);
              return (
                <label
                  key={p.key}
                  htmlFor={inputId}
                  title={!locked && !enabled ? "You don't have this permission yourself, so you can't change it." : undefined}
                  className={cn(
                    "flex items-start gap-3 rounded-md py-2 text-sm pointer-coarse:py-3",
                    enabled ? "cursor-pointer" : "cursor-not-allowed text-muted-foreground",
                  )}
                >
                  <Checkbox
                    id={inputId}
                    checked={checked.has(p.key)}
                    onCheckedChange={(value) => toggle(p.key, value === true)}
                    disabled={!enabled || pending}
                    className="mt-0.5"
                  />
                  <span className="min-w-0 leading-snug">{p.label}</span>
                </label>
              );
            })}
          </div>
        </div>
      ))}

      {(hasGreyed || adminOnlyWithoutAccess) && (
        <div className="flex flex-col gap-2 py-4 text-xs leading-relaxed text-muted-foreground">
          {adminOnlyWithoutAccess && <p>Without “Open the admin area” the other admin permissions have no effect.</p>}
          {hasGreyed && <p>Greyed-out permissions are ones you don&apos;t have yourself, so you can&apos;t change them.</p>}
        </div>
      )}
    </SettingsGroup>
  );
}
