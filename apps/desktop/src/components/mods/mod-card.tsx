import { Braces, Ellipsis, Pencil, ShieldCheck, SlidersHorizontal, Trash2, TriangleAlert } from "lucide-react";
import { modState, type Mod } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useAllAgents } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { AbilityChip, HookChips, ModIconTile, ModStateBadge, modAuthor, modOriginLabel, sensitiveAbilities, type ModTab } from "./mod-parts";
import { RunsForRow } from "./runs-for";
import type { ModActions } from "./use-mod-actions";

const FOOTER_BUTTON = "h-7 gap-1.5 px-2 text-[12.5px] font-normal text-muted-foreground hover:text-foreground [&_svg]:size-3.5";

export function ModCard({ mod, actions, onOpen, onDelete }: { mod: Mod; actions: ModActions; onOpen: (tab: ModTab) => void; onDelete: () => void }) {
  const { data: agents = [] } = useAllAgents();
  const state = modState(mod);
  const checking = actions.checking.has(mod.id);
  const sensitive = sensitiveAbilities(mod.check);
  const firstError = mod.check?.errors[0];
  const moreErrors = (mod.check?.errors.length ?? 0) - 1;

  return (
    <article aria-label={mod.title} className={cn("flex w-full min-w-0 flex-col rounded-xl border bg-card shadow-card transition hover:border-foreground/15", checking && "glow-border")}>
      <div className="flex items-start gap-3.5 p-4">
        <ModIconTile icon={mod.icon} state={state} />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="min-w-0 text-[15px] leading-snug font-medium tracking-[-0.01em]">
              <button
                type="button"
                onClick={() => onOpen("overview")}
                className="block max-w-full truncate rounded-sm text-left decoration-foreground/25 underline-offset-[3px] outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {mod.title}
              </button>
            </h3>
            <ModStateBadge state={state} />
          </div>
          <p className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="truncate font-mono text-foreground/80" title={mod.name}>
              {mod.name}
            </span>
            <span aria-hidden className="opacity-50">
              ·
            </span>
            <span className="shrink-0">{modOriginLabel(mod, agents)}</span>
          </p>
        </div>

        <Switch
          checked={mod.enabled}
          onCheckedChange={(on) => actions.toggle(mod, on)}
          aria-label={`Switch on ${mod.title}`}
          className="mt-1 shrink-0"
        />
      </div>

      {mod.description && <p className="-mt-1 line-clamp-2 px-4 pb-4 text-[13px] leading-relaxed text-muted-foreground">{mod.description}</p>}

      {state === "broken" && firstError && !checking && (
        <div className="mx-4 mb-4 flex flex-wrap items-start gap-x-2.5 gap-y-2 rounded-lg border border-destructive/25 bg-destructive/[0.05] px-3 py-2.5 text-xs" role="alert">
          <TriangleAlert className="mt-px size-3.5 shrink-0 text-destructive" aria-hidden />
          <div className="min-w-0 flex-1 basis-48 leading-relaxed break-words text-destructive">
            <p className="line-clamp-3" title={firstError.message}>
              <span className="font-mono text-[11.5px]">{firstError.where}</span> <span className="text-destructive/85">{firstError.message}</span>
            </p>
            {moreErrors > 0 && <p className="mt-0.5 whitespace-nowrap text-destructive/70">and {moreErrors} more</p>}
          </div>
          <Button size="xs" variant="outline" onClick={() => onOpen("code")}>
            <Braces /> Fix
          </Button>
        </div>
      )}

      {state === "review" && (
        <div className="mx-4 mb-4 flex flex-wrap items-start gap-x-2.5 gap-y-2 rounded-lg border border-warning/30 bg-warning/[0.07] px-3 py-2.5 text-xs" role="status">
          <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
          <p className="min-w-0 flex-1 basis-48 leading-relaxed text-foreground/85">
            Drafted by <span className="font-medium text-foreground">{modAuthor(mod, agents)?.name ?? "an agent"}</span>. Read the code before you switch it on.
          </p>
          <Button size="xs" variant="outline" onClick={() => onOpen("code")}>
            <Braces /> Review
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5 px-4 pb-4">
        {mod.check ? (
          <>
            <span className="eyebrow mr-1 text-[10.5px]">Hooks into</span>
            {mod.check.hooks.length ? <HookChips hooks={mod.check.hooks} /> : <span className="text-xs text-muted-foreground">Nothing yet</span>}
            {sensitive.map((a) => (
              <AbilityChip key={a.id} ability={a} />
            ))}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            Not checked yet.{" "}
            <button
              type="button"
              disabled={checking}
              onClick={() => actions.check.mutate({ mod })}
              className="rounded-sm font-medium text-foreground/80 underline decoration-foreground/25 underline-offset-[3px] outline-none hover:text-foreground hover:decoration-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60"
            >
              {checking ? "Checking…" : "Check now"}
            </button>
          </p>
        )}
      </div>

      <div className="mt-auto border-t px-4 py-3">
        <RunsForRow mod={mod} actions={actions} />
      </div>

      <div className="flex flex-wrap items-center gap-0.5 rounded-b-xl border-t bg-paper-2/70 px-2 py-1.5">
        {mod.options.length > 0 && (
          <Button variant="ghost" size="sm" className={FOOTER_BUTTON} onClick={() => onOpen("options")}>
            <SlidersHorizontal /> Options
          </Button>
        )}
        <Button variant="ghost" size="sm" className={FOOTER_BUTTON} onClick={() => onOpen("code")}>
          <Braces /> Code
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="ml-auto size-7 text-muted-foreground" aria-label={`More actions for ${mod.title}`}>
              {checking ? <Spinner className="size-3.5" /> : <Ellipsis />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={() => onOpen("overview")}>
              <Pencil /> Edit…
            </DropdownMenuItem>
            <DropdownMenuItem disabled={checking} onClick={() => actions.check.mutate({ mod })}>
              <ShieldCheck /> Check again
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Trash2 /> Delete…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </article>
  );
}
