import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarClock } from "lucide-react";
import type { Routine } from "@godmode/shared";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useAllAgents } from "@/lib/hooks";
import { modKey } from "@/lib/desktop";
import { Kbd } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CronBuilder } from "./cron-builder";
import { DEFAULT_CRON, localTimezone, validateCron } from "./cron";
import { TimezoneSelect } from "./timezone-select";

export interface RoutineDraft {
  agentId: string;
  name: string;
  cron: string;
  timezone: string;
  prompt: string;
  enabled: boolean;
  reuseConversation: boolean;
}

/**
 * Create / edit a routine. Pass `routine` to edit; `agentId` to lock the agent when creating.
 * Mount with a changing `key` (e.g. routine id) so the form re-initialises.
 */
export function RoutineDialog({
  open,
  onOpenChange,
  routine,
  agentId,
  initial,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  routine?: Routine | null;
  agentId?: string;
  initial?: Partial<RoutineDraft>;
}) {
  const qc = useQueryClient();
  const { data: agents = [] } = useAllAgents();
  const editing = !!routine;
  const [draft, setDraft] = useState<RoutineDraft>(() => ({
    agentId: routine?.agentId ?? agentId ?? initial?.agentId ?? "",
    name: routine?.name ?? initial?.name ?? "",
    cron: routine?.cron ?? initial?.cron ?? DEFAULT_CRON,
    timezone: routine?.timezone || initial?.timezone || localTimezone(),
    prompt: routine?.prompt ?? initial?.prompt ?? "",
    enabled: routine?.enabled ?? initial?.enabled ?? true,
    reuseConversation: routine?.reuseConversation ?? initial?.reuseConversation ?? false,
  }));
  const [touched, setTouched] = useState(false);
  const set = <K extends keyof RoutineDraft>(k: K, v: RoutineDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const cronError = validateCron(draft.cron);
  const problems = {
    agentId: !draft.agentId ? "Pick an agent" : null,
    name: !draft.name.trim() ? "Name your routine" : null,
    prompt: !draft.prompt.trim() ? "Tell the agent what to do each time" : null,
  };
  const invalid = !!cronError || Object.values(problems).some(Boolean);

  const save = useMutation({
    mutationFn: () => {
      const input = {
        agentId: draft.agentId,
        name: draft.name.trim(),
        cron: draft.cron.trim(),
        timezone: draft.timezone,
        prompt: draft.prompt.trim(),
        enabled: draft.enabled,
        reuseConversation: draft.reuseConversation,
      };
      return routine ? api.routines.update(routine.id, input) : api.routines.create(input);
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: qk.routines });
      toast.success(editing ? "Routine updated" : "Routine scheduled", { description: r.name });
      onOpenChange(false);
    },
    onError: (err) => toast.error(editing ? "Couldn't update routine" : "Couldn't create routine", { description: errorMessage(err) }),
  });

  const submit = () => {
    setTouched(true);
    if (!invalid && !save.isPending) save.mutate();
  };

  const selectableAgents = agents.filter((a) => a.enabled || a.id === draft.agentId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-xl bg-gradient-brand text-white shadow-md shadow-glow-a/25">
              <CalendarClock className="size-5" />
            </div>
            <div>
              <DialogTitle>{editing ? "Edit routine" : "New routine"}</DialogTitle>
              <DialogDescription>Runs the prompt on a schedule — even while you're away.</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          className="space-y-5"
          noValidate
        >
          <div className="grid gap-4 sm:grid-cols-2">
            {!agentId && (
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="routine-agent">Agent</Label>
                <Select value={draft.agentId} onValueChange={(v) => set("agentId", v)} disabled={editing}>
                  <SelectTrigger id="routine-agent" className="w-full" aria-invalid={touched && !!problems.agentId}>
                    <SelectValue placeholder="Choose who runs it" />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    {selectableAgents.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        <span>{a.avatar}</span> {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {touched && problems.agentId && <p className="text-xs text-destructive">{problems.agentId}</p>}
              </div>
            )}
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="routine-name">Name</Label>
              <Input
                id="routine-name"
                value={draft.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="Monthly invoice download"
                aria-invalid={touched && !!problems.name}
                autoFocus
              />
              {touched && problems.name && <p className="text-xs text-destructive">{problems.name}</p>}
            </div>
          </div>

          <fieldset className="space-y-3 rounded-xl border bg-muted/20 p-4">
            <legend className="px-1 text-sm font-medium">Schedule</legend>
            <CronBuilder value={draft.cron} onChange={(c) => set("cron", c)} idPrefix="routine-cron" />
            <div className="space-y-1.5">
              <Label htmlFor="routine-tz" className="text-xs text-muted-foreground">
                Timezone
              </Label>
              <TimezoneSelect id="routine-tz" value={draft.timezone} onChange={(tz) => set("timezone", tz)} />
            </div>
          </fieldset>

          <div className="space-y-1.5">
            <Label htmlFor="routine-prompt">What should it do?</Label>
            <Textarea
              id="routine-prompt"
              value={draft.prompt}
              onChange={(e) => set("prompt", e.target.value)}
              placeholder="Log into my accounts, download any new invoices from last month, save them to workspace/invoices and send me a summary."
              aria-invalid={touched && !!problems.prompt}
              className="min-h-28 text-sm leading-relaxed"
            />
            {touched && problems.prompt && <p className="text-xs text-destructive">{problems.prompt}</p>}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <SwitchCard
              id="routine-reuse"
              title="Keep one conversation"
              description="Every run continues the same thread, so it remembers previous runs."
              checked={draft.reuseConversation}
              onChange={(v) => set("reuseConversation", v)}
            />
            <SwitchCard
              id="routine-enabled"
              title="Enabled"
              description="Paused routines keep their settings but don't run."
              checked={draft.enabled}
              onChange={(v) => set("enabled", v)}
            />
          </div>

          <DialogFooter className="items-center sm:justify-between">
            <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
              <Kbd>{modKey}</Kbd>
              <Kbd>↵</Kbd> to save
            </span>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={save.isPending || (touched && invalid)}
                className="bg-gradient-brand text-white hover:opacity-95"
              >
                {save.isPending && <Spinner />}
                {editing ? "Save changes" : "Create routine"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SwitchCard({
  id,
  title,
  description,
  checked,
  onChange,
}: {
  id: string;
  title: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border bg-background/40 p-3">
      <div className="min-w-0 flex-1">
        <Label htmlFor={id} className="cursor-pointer text-sm">
          {title}
        </Label>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
