"use client";

import { useState } from "react";
import { UserPlus, Users } from "lucide-react";
import { RowActions } from "@/components/row-actions";
import { SettingsGroup } from "@/components/settings-kit";
import { Button } from "@/components/ui/button";
import { unshareDeviceAction } from "../../actions";
import {
  SHARE_ROLES,
  ShareDialog,
  type ShareRole,
} from "../../_components/share-dialog";

export interface AccessPerson {
  id: string;
  email: string;
  name: string | null;
  role: ShareRole;
}

/** Who else may use this computer. Only its owner sees and changes this list. */
export function PeopleAccess({
  deviceId,
  deviceName,
  people,
  blocked,
}: {
  deviceId: string;
  deviceName: string;
  people: AccessPerson[];
  /** Why sharing is not possible right now (role, cloud setting or plan); null when it is. */
  blocked: string | null;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AccessPerson | null>(null);

  return (
    <SettingsGroup
      id="people"
      icon={<Users />}
      title="People with access"
      description="Share this computer with other accounts of this cloud. It keeps running under your plan."
      actions={
        blocked ? undefined : (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <UserPlus />
            Share
          </Button>
        )
      }
    >
      {people.map((person) => {
        const role = SHARE_ROLES.find((r) => r.value === person.role);
        return (
          <div key={person.id} className="flex items-center gap-3 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {person.name?.trim() || person.email}
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                {person.name?.trim() ? `${person.email} · ` : ""}
                {role?.title}: {role?.description.toLowerCase()}
              </p>
            </div>
            <RowActions
              label={`Actions for ${person.email}`}
              items={[
                ...(blocked
                  ? []
                  : [
                      {
                        label: "Change access",
                        onSelect: () => setEditing(person),
                      },
                    ]),
                {
                  label: "Remove access",
                  tone: "danger" as const,
                  confirm: {
                    title: `Remove ${person.email}?`,
                    description: `They can no longer open ${deviceName}. Anything they have open closes within a minute.`,
                    confirmLabel: "Remove",
                    pendingLabel: "Removing…",
                    onConfirm: () => unshareDeviceAction(deviceId, person.id),
                  },
                  successMessage: "Access removed",
                },
              ]}
            />
          </div>
        );
      })}
      {people.length === 0 && (
        <p className="py-4 text-sm text-muted-foreground">
          {blocked ?? "Only you can open this computer."}
        </p>
      )}
      {people.length > 0 && blocked && (
        <p className="py-3 text-xs leading-relaxed text-muted-foreground">
          {blocked}
        </p>
      )}
      <ShareDialog
        deviceId={deviceId}
        deviceName={deviceName}
        open={adding}
        onOpenChange={setAdding}
      />
      <ShareDialog
        deviceId={deviceId}
        deviceName={deviceName}
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        person={
          editing ? { email: editing.email, role: editing.role } : undefined
        }
      />
    </SettingsGroup>
  );
}
