import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Globe, Globe2 } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";

const GLOBAL_DEFAULT = "__global";

/** The browser profile a workspace's agents use. Picking a global profile moves it into the workspace. */
export function WorkspaceProfileField({
  id,
  workspaceId,
  value,
  onChange,
}: {
  id: string;
  /** null while the workspace is being created */
  workspaceId: string | null;
  value: string | null;
  onChange: (profileId: string | null) => void;
}) {
  const { data: profiles } = useQuery({ queryKey: qk.browserProfiles, queryFn: api.browser.profiles, retry: false });
  if (!profiles) return null;

  const globalDefault = profiles.find((p) => !p.workspaceId && p.isDefault);
  const own = workspaceId ? profiles.filter((p) => p.workspaceId === workspaceId) : [];
  const movable = profiles.filter((p) => !p.workspaceId && !p.isDefault);
  const selected = value ? profiles.find((p) => p.id === value) : undefined;
  const moving = !!selected && (!workspaceId || selected.workspaceId !== workspaceId);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id}>Browser profile</Label>
        <Link to="/browser" className="flex items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground">
          Manage profiles <ArrowRight className="size-3" />
        </Link>
      </div>
      <Select value={value ?? GLOBAL_DEFAULT} onValueChange={(v) => onChange(v === GLOBAL_DEFAULT ? null : v)}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value={GLOBAL_DEFAULT}>
            <Globe2 className="size-4" />
            Global default
            {globalDefault && <span className="text-xs text-muted-foreground">{globalDefault.name}</span>}
          </SelectItem>
          {own.length > 0 && (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>This workspace</SelectLabel>
                {own.map((p) => (
                  <ProfileItem key={p.id} id={p.id} name={p.name} cookies={p.cookieCount} />
                ))}
              </SelectGroup>
            </>
          )}
          {movable.length > 0 && (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>Global — moves into this workspace</SelectLabel>
                {movable.map((p) => (
                  <ProfileItem key={p.id} id={p.id} name={p.name} cookies={p.cookieCount} />
                ))}
              </SelectGroup>
            </>
          )}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        {moving
          ? `${selected.name} moves into this workspace. Agents elsewhere that picked it keep using it.`
          : "The workspace's agents browse with this profile, unless an agent picks its own."}
      </p>
    </div>
  );
}

function ProfileItem({ id, name, cookies }: { id: string; name: string; cookies: number }) {
  return (
    <SelectItem value={id}>
      <Globe className="size-4" />
      {name}
      {cookies > 0 && <span className="text-xs text-muted-foreground">{cookies.toLocaleString()} cookies</span>}
    </SelectItem>
  );
}
