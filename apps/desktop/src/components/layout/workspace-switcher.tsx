import { useNavigate } from "react-router";
import { Check, ChevronsUpDown, Globe2, Layers, Plus, Settings2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useWorkspaces } from "@/lib/hooks";
import { useUi } from "@/stores/ui";
import { cn } from "@/lib/utils";
import { colorGradient } from "@/components/common";

/** Switches the active scope: all workspaces, global only, or a single workspace. */
export function WorkspaceSwitcher() {
  const { data: workspaces = [] } = useWorkspaces();
  const scope = useUi((s) => s.workspace);
  const setScope = useUi((s) => s.setWorkspace);
  const navigate = useNavigate();

  const current = workspaces.find((w) => w.id === scope);
  const label = scope === "all" ? "All workspaces" : scope === "global" ? "Global" : (current?.name ?? "All workspaces");
  const icon =
    scope === "all" ? (
      <Layers className="size-4" />
    ) : scope === "global" ? (
      <Globe2 className="size-4" />
    ) : (
      <span className="text-sm">{current?.icon ?? "🗂️"}</span>
    );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            "flex h-10 w-full items-center gap-2.5 rounded-xl border bg-card/60 px-2.5 text-left text-sm transition hover:bg-accent/60",
            "group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0",
          )}
        >
          <span
            className={cn(
              "grid size-6 shrink-0 place-items-center rounded-lg bg-gradient-to-br text-white",
              current ? colorGradient(current.color) : "from-zinc-500 to-zinc-700",
            )}
          >
            {icon}
          </span>
          <span className="min-w-0 flex-1 truncate font-medium group-data-[collapsible=icon]:hidden">{label}</span>
          <ChevronsUpDown className="size-3.5 text-muted-foreground group-data-[collapsible=icon]:hidden" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Scope</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => setScope("all")}>
          <Layers className="size-4" /> All workspaces {scope === "all" && <Check className="ml-auto size-4" />}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setScope("global")}>
          <Globe2 className="size-4" /> Global {scope === "global" && <Check className="ml-auto size-4" />}
        </DropdownMenuItem>
        {workspaces.length > 0 && <DropdownMenuSeparator />}
        {workspaces.map((w) => (
          <DropdownMenuItem key={w.id} onClick={() => setScope(w.id)}>
            <span className="w-4 text-center">{w.icon}</span> <span className="truncate">{w.name}</span>
            {scope === w.id && <Check className="ml-auto size-4" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate("/workspaces?new=1")}>
          <Plus className="size-4" /> New workspace
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigate("/workspaces")}>
          <Settings2 className="size-4" /> Manage workspaces
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
