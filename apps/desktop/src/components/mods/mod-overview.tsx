import { useEffect, useRef, useState, type ReactNode } from "react";
import { format, formatDistanceToNow } from "date-fns";
import { Braces, Check, CircleAlert, CircleCheck, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { modAbilities, modHookLabel, modState, type Mod, type ModAbility } from "@godmode/shared";
import { Callout } from "@/components/settings/settings-kit";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useAllAgents } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { ModProblems, modAuthor, modOriginLabel, sortedPaths } from "./mod-parts";
import { RunsForEditor } from "./runs-for";
import type { ModActions } from "./use-mod-actions";

const MAX_DESCRIPTION = 600;

function Block({ title, description, children }: { title: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        {description && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

/** The Overview tab: what the mod is, who runs it, and — like an app's permissions — what it hooks into and can do. */
export function ModOverview({
  mod,
  actions,
  onOpenCode,
  onOpenFile,
  onDelete,
}: {
  mod: Mod;
  actions: ModActions;
  onOpenCode: () => void;
  onOpenFile: (path: string, line?: number | null) => void;
  onDelete: () => void;
}) {
  const { data: agents = [] } = useAllAgents();
  const state = modState(mod);
  const check = mod.check;
  const checking = actions.checking.has(mod.id);
  const abilities = check ? modAbilities(check) : [];
  const everyday = abilities.filter((a) => a.level === "normal");
  const sensitive = abilities.filter((a) => a.level === "sensitive");
  const paths = sortedPaths(mod.files);
  const checkedAt = check ? new Date(check.checkedAt) : null;

  return (
    <div className="space-y-7 p-5">
      {state === "review" && (
        <Callout tone="warning" title={`${modAuthor(mod, agents)?.name ?? "An agent"} drafted this mod`}>
          <p>It stays off until you have read its code. Switching it on is your approval.</p>
          <Button size="xs" variant="outline" className="mt-2" onClick={onOpenCode}>
            <Braces /> Read the code
          </Button>
        </Callout>
      )}
      {state === "broken" && (
        <Callout tone="danger" title="Claude Code refuses this mod as it is">
          <p>Runs don't load it until the problems below are fixed.</p>
          <Button size="xs" variant="outline" className="mt-2" onClick={onOpenCode}>
            <Braces /> Fix the code
          </Button>
        </Callout>
      )}

      <div className="grid grid-cols-1 gap-x-8 gap-y-7 @3xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div className="space-y-7">
          <div className="space-y-2">
            <Label htmlFor={`mod-description-${mod.id}`} className="text-sm font-medium">
              Description
            </Label>
            <DescriptionField mod={mod} actions={actions} />
          </div>

          <Block title="Runs for" description="The agents whose runs load this mod while it is switched on.">
            <RunsForEditor mod={mod} actions={actions} />
            {mod.scope === "agents" && mod.agentIds.length === 0 && <p className="text-xs text-warning/85">No agent yet — nobody runs this mod until you pick one.</p>}
          </Block>

          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 rounded-lg border bg-paper-2/60 px-3 py-2.5">
              {!check ? (
                <CircleAlert className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              ) : check.ok ? (
                <CircleCheck className="size-3.5 shrink-0 text-success" aria-hidden />
              ) : (
                <TriangleAlert className="size-3.5 shrink-0 text-destructive" aria-hidden />
              )}
              <p className="min-w-0 flex-1 basis-40 text-xs leading-relaxed text-muted-foreground">
                {check && checkedAt ? (
                  <>
                    Checked with Claude Code
                    {check.claudeVersion && <span className="font-mono text-[11.5px] text-foreground/80"> {check.claudeVersion}</span>} ·{" "}
                    <time dateTime={check.checkedAt} title={format(checkedAt, "PPp")}>
                      {formatDistanceToNow(checkedAt, { addSuffix: true })}
                    </time>
                  </>
                ) : (
                  "Not checked yet. The check needs Claude Code on this computer."
                )}
              </p>
              <Button size="xs" variant="outline" disabled={checking} onClick={() => actions.check.mutate({ mod })}>
                {checking ? <Spinner className="size-3" /> : <RefreshCw />} {check ? "Check again" : "Check now"}
              </Button>
            </div>
            {check && (check.errors.length > 0 || check.warnings.length > 0) && (
              <div className="space-y-2 px-1">
                <ModProblems problems={check.errors} tone="error" paths={paths} onOpenFile={onOpenFile} />
                <ModProblems problems={check.warnings} tone="warning" paths={paths} onOpenFile={onOpenFile} />
              </div>
            )}
          </div>
        </div>

        <div className="space-y-7">
          <Block title="What it can do" description={check ? "Told from the events it hooks and what it calls on Claude Code." : undefined}>
            {!check ? (
              <Quiet>Not checked yet. Until Claude Code has checked it, read the code to see what this mod does.</Quiet>
            ) : abilities.length === 0 ? (
              <Quiet>Nothing yet — it doesn't hook into Claude Code.</Quiet>
            ) : (
              <>
                {everyday.length > 0 && <AbilityList abilities={everyday} />}
                {sensitive.length > 0 && (
                  <div className="space-y-2">
                    <p className="eyebrow pt-1 text-[10.5px]">Reaches outside the conversation</p>
                    <AbilityList abilities={sensitive} sensitive />
                  </div>
                )}
              </>
            )}
          </Block>

          <Block title="Hooks into">
            {!check ? (
              <Quiet>Not known until Claude Code checks the mod.</Quiet>
            ) : check.hooks.length === 0 ? (
              <Quiet>No hooks yet.</Quiet>
            ) : (
              <ul className="divide-y rounded-lg border bg-card">
                {check.hooks.map((h, i) => (
                  <li key={i} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-3.5 py-2">
                    <span className="text-[13px]">{modHookLabel(h)}</span>
                    <span className="flex min-w-0 items-baseline gap-1.5 font-mono text-[11px] text-muted-foreground">
                      <span className="text-foreground/75">{h.event}</span>
                      {h.matcher && <span className="truncate rounded-[4px] border bg-paper-2 px-1">{h.matcher}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Block>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-5">
        <p className="text-xs text-muted-foreground">
          {modOriginLabel(mod, agents)} · added {format(new Date(mod.createdAt), "PP")}
        </p>
        <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={onDelete}>
          <Trash2 /> Delete mod
        </Button>
      </div>
    </div>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed px-3.5 py-3 text-xs leading-relaxed text-muted-foreground">{children}</p>;
}

function AbilityList({ abilities, sensitive }: { abilities: ModAbility[]; sensitive?: boolean }) {
  return (
    <ul className={cn("divide-y rounded-lg border", sensitive ? "divide-warning/20 border-warning/30 bg-warning/[0.05]" : "bg-card")}>
      {abilities.map((a) => (
        <li key={a.id} className="flex gap-2.5 px-3.5 py-2.5">
          {sensitive ? <TriangleAlert className="mt-[3px] size-3.5 shrink-0 text-warning" aria-hidden /> : <Check className="mt-[3px] size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
          <div className="min-w-0">
            <p className="text-[13px] leading-snug font-medium">{a.label}</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{a.detail}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

function DescriptionField({ mod, actions }: { mod: Mod; actions: ModActions }) {
  const [text, setText] = useState(mod.description);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(mod.description);
  }, [mod.description]);

  return (
    <Textarea
      id={`mod-description-${mod.id}`}
      value={text}
      maxLength={MAX_DESCRIPTION}
      onChange={(e) => setText(e.target.value)}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        const next = text.trim();
        if (next !== mod.description) actions.update.mutate({ mod, patch: { description: next } });
        setText(next);
      }}
      placeholder="What this mod does, in a sentence or two."
      className="min-h-[4.5rem] text-[13px] leading-relaxed md:text-[13px]"
    />
  );
}
