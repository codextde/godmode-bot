"use client";

import { useState, useTransition, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Ban, CircleCheck, Ellipsis, Gift, LogOut, ShieldCheck, Trash2, UserRound } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { FormField, FormStack } from "@/components/form";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogClose,
  ResponsiveDialogFooter,
} from "@/components/responsive-dialog";
import { Callout } from "@/components/settings-kit";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { deleteUserAction, grantPlanAction, setUserRoleAction, setUserStatusAction, signOutUserAction } from "../actions";
import type { PlanOption, RoleOption, UserCapabilities } from "../capabilities";

export interface UserActionsTarget {
  id: string;
  email: string;
  name: string | null;
  status: "active" | "suspended";
  roleId: string;
  /** The plan an admin gave this person, if any, and until when ("2027-01-31"). */
  planOverrideId: string | null;
  planOverrideUntil: string | null;
}

type Dialog = "role" | "plan" | "suspend" | "signOut" | "delete" | null;

const NO_PLAN = "__none";

/**
 * Everything an admin can do to one account: the trailing menu of a People row, or the "Actions" button on a
 * person's page. Items the signed-in person may not use are left out (the server refuses them as well).
 */
export function UserActions({
  user,
  caps,
  roles,
  plans,
  billingOn,
  variant = "menu",
  openLink = false,
  afterDelete,
}: {
  user: UserActionsTarget;
  caps: UserCapabilities;
  /** Roles the signed-in person may give. */
  roles: RoleOption[];
  plans: PlanOption[];
  billingOn: boolean;
  variant?: "menu" | "button";
  /** Adds "Open" (the list's menu). */
  openLink?: boolean;
  /** Where to go once the account is gone (the person's own page no longer exists). */
  afterDelete?: string;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [pending, startTransition] = useTransition();
  const who = user.name || user.email;
  const canChangeRole = caps.role && roles.length > 0;
  const any = openLink || canChangeRole || caps.status || caps.signOut || caps.plan || caps.remove;
  if (!any) return null;

  const activate = () =>
    startTransition(async () => {
      const result = await setUserStatusAction(user.id, "active");
      if (result.ok) toast.success(`${who} can sign in again`);
      else toast.error(result.error);
    });

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          {variant === "button" ? (
            <Button variant="outline" disabled={pending}>
              Actions
              <Ellipsis />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Actions for ${user.email}`}
              disabled={pending}
              className="text-muted-foreground hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
            >
              <Ellipsis />
            </Button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          {openLink && (
            <DropdownMenuItem asChild>
              <Link href={`/admin/users/${user.id}`}>
                <UserRound />
                Open
              </Link>
            </DropdownMenuItem>
          )}
          {canChangeRole && (
            <DropdownMenuItem onSelect={() => setDialog("role")}>
              <ShieldCheck />
              Change role…
            </DropdownMenuItem>
          )}
          {caps.plan && (
            <DropdownMenuItem onSelect={() => setDialog("plan")}>
              <Gift />
              Give a plan…
            </DropdownMenuItem>
          )}
          {caps.status &&
            (user.status === "active" ? (
              <DropdownMenuItem onSelect={() => setDialog("suspend")}>
                <Ban />
                Suspend…
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={activate}>
                <CircleCheck />
                Reactivate
              </DropdownMenuItem>
            ))}
          {caps.signOut && (
            <DropdownMenuItem onSelect={() => setDialog("signOut")}>
              <LogOut />
              Sign out everywhere…
            </DropdownMenuItem>
          )}
          {caps.remove && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setDialog("delete")}>
                <Trash2 />
                Delete account…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {dialog === "role" && <RoleDialog user={user} roles={roles} onClose={() => setDialog(null)} />}
      {dialog === "plan" && <PlanDialog user={user} plans={plans} billingOn={billingOn} onClose={() => setDialog(null)} />}
      {dialog === "suspend" && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          title={`Suspend ${who}?`}
          description="They are signed out everywhere, their computers are disconnected and they cannot sign in until you reactivate them. Nothing is deleted."
          confirmLabel="Suspend"
          pendingLabel="Suspending…"
          tone="danger"
          onConfirm={() => setUserStatusAction(user.id, "suspended")}
          successMessage={`${who} is suspended`}
        />
      )}
      {dialog === "signOut" && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          title={`Sign ${who} out everywhere?`}
          description="Every browser signed in to this account has to sign in again. Linked computers stay linked."
          confirmLabel="Sign out everywhere"
          pendingLabel="Signing out…"
          onConfirm={() => signOutUserAction(user.id)}
          successMessage="Signed out everywhere"
        />
      )}
      {dialog === "delete" && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          title={`Delete the account of ${who}?`}
          description="Their subscription ends right away, their computers are unlinked and their sign-ins stop working. This cannot be undone."
          confirmLabel="Delete account"
          pendingLabel="Deleting…"
          tone="danger"
          confirmText={user.email}
          onConfirm={async () => {
            const result = await deleteUserAction(user.id, user.email);
            if (result.ok && afterDelete) router.push(afterDelete);
            return result;
          }}
          successMessage="Account deleted"
        />
      )}
    </>
  );
}

function RoleDialog({ user, roles, onClose }: { user: UserActionsTarget; roles: RoleOption[]; onClose: () => void }) {
  const [roleId, setRoleId] = useState(roles.some((r) => r.id === user.roleId) ? user.roleId : "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const chosen = roles.find((r) => r.id === roleId);
  const dirty = roleId !== "" && roleId !== user.roleId;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!dirty) return;
    setError(null);
    startTransition(async () => {
      const result = await setUserRoleAction(user.id, roleId);
      if (!result.ok) return setError(result.error);
      toast.success("Role changed");
      onClose();
    });
  };

  return (
    <ResponsiveDialog
      bare
      open
      onOpenChange={(open) => !open && !pending && onClose()}
      title="Change role"
      description={`Choose what ${user.name || user.email} may do. You can give roles whose permissions you have yourself.`}
    >
      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <ResponsiveDialogBody>
          <FormStack className="pb-2">
            <FormField label="Role" hint={chosen?.description || undefined}>
              <Select value={roleId} onValueChange={setRoleId} disabled={pending}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose a role" />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            {error && <Callout tone="danger" title={error} />}
          </FormStack>
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <ResponsiveDialogClose asChild>
            <Button type="button" variant="outline" disabled={pending}>
              Cancel
            </Button>
          </ResponsiveDialogClose>
          <SubmitButton pending={pending} pendingLabel="Saving…" disabled={!dirty}>
            Change role
          </SubmitButton>
        </ResponsiveDialogFooter>
      </form>
    </ResponsiveDialog>
  );
}

function PlanDialog({
  user,
  plans,
  billingOn,
  onClose,
}: {
  user: UserActionsTarget;
  plans: PlanOption[];
  billingOn: boolean;
  onClose: () => void;
}) {
  const current = user.planOverrideId && plans.some((p) => p.id === user.planOverrideId) ? user.planOverrideId : NO_PLAN;
  const [planId, setPlanId] = useState(current);
  const [until, setUntil] = useState(user.planOverrideUntil ?? "");
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const none = planId === NO_PLAN;
  const dirty = planId !== current || (!none && until !== (user.planOverrideUntil ?? ""));
  // Tomorrow, as the earliest end date the picker offers.
  const [minDate] = useState(() => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!dirty) return;
    setError(null);
    setFields({});
    startTransition(async () => {
      const result = await grantPlanAction({ userId: user.id, planId: none ? null : planId, until: none || !until ? null : until });
      if (!result.ok) {
        setFields(result.fields ?? {});
        if (!result.fields?.until) setError(result.error);
        return;
      }
      toast.success(none ? "Plan taken back" : "Plan given");
      onClose();
    });
  };

  return (
    <ResponsiveDialog
      bare
      open
      onOpenChange={(open) => !open && !pending && onClose()}
      title="Give a plan"
      description={`${user.name || user.email} gets this plan without paying. A subscription of their own always wins.`}
    >
      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <ResponsiveDialogBody>
          <FormStack className="pb-2">
            {!billingOn && (
              <Callout tone="muted" title="Billing is off">
                Everyone has everything right now. A plan you give here starts to count once billing is turned on.
              </Callout>
            )}
            <FormField label="Plan">
              <Select value={planId} onValueChange={setPlanId} disabled={pending}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_PLAN}>No plan given</SelectItem>
                  {plans.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField label="Until" optional error={fields.until} hint="Leave empty to give the plan without an end date.">
              <Input
                type="date"
                value={none ? "" : until}
                min={minDate}
                onChange={(e) => setUntil(e.target.value)}
                disabled={pending || none}
                className="font-mono tabular-nums"
              />
            </FormField>
            {error && <Callout tone="danger" title={error} />}
          </FormStack>
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <ResponsiveDialogClose asChild>
            <Button type="button" variant="outline" disabled={pending}>
              Cancel
            </Button>
          </ResponsiveDialogClose>
          <SubmitButton pending={pending} pendingLabel="Saving…" disabled={!dirty}>
            {none ? "Take plan back" : "Give plan"}
          </SubmitButton>
        </ResponsiveDialogFooter>
      </form>
    </ResponsiveDialog>
  );
}
