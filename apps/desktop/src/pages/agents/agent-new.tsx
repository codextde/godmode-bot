import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, Bot, CalendarClock, Plus, Sparkles, Wand2, X } from "lucide-react";
import type { Agent, AgentInput, AgentTemplate } from "@godmode/shared";
import { api, errorMessage } from "@/lib/api";
import { isGrantCancelled, withGrant } from "@/components/vault/grant";
import { qk } from "@/lib/queryKeys";
import { clearDraft, draftKeys, loadDraft, useDraft } from "@/lib/drafts";
import { useAgentTemplates, useBootstrap } from "@/lib/hooks";
import { modKey } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import { AgentAvatar, EmptyState, Kbd, PageBody, PageHeader } from "@/components/common";
import { Backdrop } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentForm, agentToValues, type AgentFormValues } from "@/components/agents/agent-form";
import { cronToHuman, localTimezone } from "@/components/agents/cron";

const EXAMPLES = [
  "Download my invoices from all vendor portals on the 1st of every month",
  "Check my GitHub notifications every morning and summarize what needs me",
  "Watch competitor pricing pages weekly and report changes",
  "Triage my inbox twice a day and draft replies for anything urgent",
];

const FORM_DRAFTS = "agent-new:template:";

export default function AgentNewPage() {
  const [params, setParams] = useSearchParams();
  const templateId = params.get("template");
  return templateId ? (
    <FormStep templateId={templateId} onBack={() => setParams({})} />
  ) : (
    <ChooseStep onPick={(id) => setParams({ template: id })} />
  );
}

/* ------------------------------------------------------------------ */
/* Step 1: describe it, or pick a template                              */
/* ------------------------------------------------------------------ */

function ChooseStep({ onPick }: { onPick: (templateId: string) => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: boot } = useBootstrap();
  const templates = useAgentTemplates();
  const [description, setDescription, descriptionDraft] = useDraft("agent-new:describe", "");
  const [focused, setFocused] = useState(false);
  const [draftList, setDraftList] = useState(() => draftKeys(FORM_DRAFTS));
  const drafts = draftList
    .map((key) => ({ key, templateId: key.slice(FORM_DRAFTS.length), values: loadDraft<Partial<AgentFormValues> | null>(key, null) }))
    .filter((d) => d.values !== null)
    .map((d) => ({ ...d, values: { ...agentToValues(undefined), ...d.values } }));

  const describe = useMutation({
    mutationFn: () =>
      api.chat.start({
        agentId: boot?.defaultAgentId ?? undefined,
        content: `Create a new agent for me: ${description.trim()}. Configure sensible instructions and an automation if it should work on its own (on a schedule or when something happens).`,
      }),
    onSuccess: (res) => {
      descriptionDraft.discard();
      qc.invalidateQueries({ queryKey: qk.conversationsAll });
      navigate(`/chat/${res.conversation.id}`);
    },
    onError: (err) => toast.error("Couldn't reach Godmode", { description: errorMessage(err) }),
  });
  const canDescribe = description.trim().length > 3 && !describe.isPending;

  return (
    <>
      <PageHeader
        icon={<Bot />}
        title="New agent"
        description="Describe what you need in plain words, or start from a template."
        actions={
          <Button variant="ghost" asChild>
            <Link to="/agents">
              <ArrowLeft /> Agents
            </Link>
          </Button>
        }
      />
      <PageBody className="space-y-10">
        {drafts.length > 0 && (
          <section aria-labelledby="agent-drafts-title">
            <h2 id="agent-drafts-title" className="eyebrow mb-3">
              Pick up where you left off
            </h2>
            <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3">
              {drafts.map((d, i) => (
                <DraftCard
                  key={d.key}
                  values={d.values}
                  source={d.templateId === "scratch" ? "From scratch" : `From ${templates.data?.find((t) => t.id === d.templateId)?.name ?? "a template"}`}
                  index={i}
                  onOpen={() => onPick(d.templateId)}
                  onDiscard={() => {
                    clearDraft(d.key);
                    setDraftList((keys) => keys.filter((k) => k !== d.key));
                  }}
                />
              ))}
            </div>
          </section>
        )}

        <section className="relative overflow-hidden rounded-2xl border bg-paper-2 p-4 @md:p-6 @2xl:p-8">
          <Backdrop className="opacity-60" />
          <div className="relative mx-auto max-w-3xl">
            <div className="mb-4 flex items-center gap-2 text-sm font-medium">
              <span className="grid size-7 place-items-center rounded-md border bg-card text-foreground shadow-card">
                <Wand2 className="size-4" />
              </span>
              <span className="text-base font-medium tracking-[-0.01em]">Describe it</span>
              <span className="text-muted-foreground">— Godmode sets it up for you</span>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (canDescribe) describe.mutate();
              }}
              className={cn(
                "rounded-xl border bg-card p-2 shadow-card transition",
                focused && "border-foreground/20 shadow-float",
                describe.isPending && "glow-border",
              )}
            >
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    if (canDescribe) describe.mutate();
                  }
                }}
                rows={4}
                placeholder="An agent that logs into my utility and phone provider accounts on the 3rd of each month, downloads the latest bills as PDF and tells me the totals…"
                aria-label="Describe your agent"
                className="block w-full resize-none bg-transparent px-3 py-2.5 text-[15px] leading-relaxed outline-none placeholder:text-muted-foreground/70"
              />
              <div className="flex flex-wrap items-center gap-2 px-2 pb-1">
                <span className="hidden items-center gap-1 text-xs text-muted-foreground @xl:flex">
                  <Kbd>{modKey}</Kbd>
                  <Kbd>↵</Kbd>
                </span>
                <Button
                  type="submit"
                  disabled={!canDescribe}
                  className="ml-auto"
                >
                  {describe.isPending ? <Spinner /> : <Sparkles />}
                  Create with Godmode
                </Button>
              </div>
            </form>
            <div className="mt-4 flex flex-wrap gap-2">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => setDescription(ex)}
                  className="rounded-md border bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-card transition hover:border-foreground/20 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section>
          <div className="mb-4 flex items-end justify-between gap-4">
            <div>
              <h2 className="text-lg font-medium tracking-[-0.02em]">Or pick a starting point</h2>
              <p className="text-sm text-muted-foreground">Templates come with instructions and, where it makes sense, a schedule.</p>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-2 @5xl:grid-cols-3">
            <motion.button
              type="button"
              onClick={() => onPick("scratch")}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="group flex min-h-44 flex-col items-start justify-between rounded-xl border border-dashed p-5 text-left transition hover:border-foreground/25 hover:bg-card focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <span className="grid size-10 place-items-center rounded-lg border bg-card text-foreground shadow-card">
                <Plus className="size-5" />
              </span>
              <span>
                <span className="block font-medium tracking-[-0.01em]">Start from scratch</span>
                <span className="mt-1 block text-sm text-muted-foreground">Blank agent — you write the instructions.</span>
              </span>
            </motion.button>

            {templates.isLoading &&
              Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="min-h-44 rounded-xl border bg-card p-5 shadow-card">
                  <Skeleton className="size-12 rounded-xl" />
                  <Skeleton className="mt-4 h-4 w-40" />
                  <Skeleton className="mt-2 h-3 w-full" />
                  <Skeleton className="mt-1.5 h-3 w-2/3" />
                </div>
              ))}

            {(templates.data ?? []).map((t, i) => (
              <TemplateCard key={t.id} template={t} index={i} onPick={() => onPick(t.id)} />
            ))}
          </div>
          {templates.isError && (
            <p className="mt-3 text-sm text-muted-foreground">Templates are unavailable right now ({errorMessage(templates.error)}).</p>
          )}
        </section>
      </PageBody>
    </>
  );
}

function DraftCard({
  values,
  source,
  index,
  onOpen,
  onDiscard,
}: {
  values: AgentFormValues;
  source: string;
  index: number;
  onOpen: () => void;
  onDiscard: () => void;
}) {
  const name = values.name.trim() || "Unnamed agent";
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index, 6) * 0.04 }}
      className="group relative flex items-center gap-3 rounded-xl border bg-card p-3 pr-2 shadow-card transition hover:border-foreground/15 hover:shadow-float has-[button:focus-visible]:ring-2 has-[button:focus-visible]:ring-ring/50"
    >
      <AgentAvatar agent={{ avatar: values.avatar, color: values.color }} size="md" />
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Continue ${name}`}
        className="min-w-0 flex-1 text-left outline-none after:absolute after:inset-0 after:rounded-xl"
      >
        <span className="block truncate text-sm font-medium tracking-[-0.01em]">{name}</span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-brand" />
          <span className="truncate">Draft · {source}</span>
        </span>
      </button>
      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground transition group-hover:text-foreground">
        Continue <ArrowRight className="size-3.5 transition group-hover:translate-x-0.5" />
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="button" variant="ghost" size="icon" onClick={onDiscard} aria-label={`Discard draft ${name}`} className="relative z-10 size-7 text-muted-foreground">
            <X />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Discard draft</TooltipContent>
      </Tooltip>
    </motion.div>
  );
}

function TemplateCard({ template, index, onPick }: { template: AgentTemplate; index: number; onPick: () => void }) {
  return (
    <motion.button
      type="button"
      onClick={onPick}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index + 1, 10) * 0.04 }}
      className="group flex min-h-44 flex-col rounded-xl border bg-card p-5 text-left shadow-card transition hover:border-foreground/15 hover:shadow-float focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <AgentAvatar agent={{ avatar: template.avatar, color: template.color }} size="lg" />
      <span className="mt-4 block font-medium tracking-[-0.01em]">{template.name}</span>
      <span className="mt-1 line-clamp-3 block flex-1 text-sm text-muted-foreground">{template.description}</span>
      {template.routine && (
        <span className="mt-3 inline-flex max-w-full items-center gap-1.5 self-start rounded-[5px] border bg-secondary px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
          <CalendarClock className="size-3 shrink-0" />
          <span className="truncate">{cronToHuman(template.routine.cron)}</span>
        </span>
      )}
    </motion.button>
  );
}

/* ------------------------------------------------------------------ */
/* Step 2: the form                                                     */
/* ------------------------------------------------------------------ */

function FormStep({ templateId, onBack }: { templateId: string; onBack: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const templates = useAgentTemplates();
  const isScratch = templateId === "scratch";
  const draftKey = FORM_DRAFTS + templateId;
  const template = isScratch ? null : (templates.data?.find((t) => t.id === templateId) ?? null);
  const [withRoutine, setWithRoutine] = useState(true);

  const initial = useMemo<Partial<Agent> | undefined>(
    () =>
      template
        ? {
            name: template.name,
            avatar: template.avatar,
            color: template.color,
            description: template.description,
            instructions: template.instructions,
          }
        : undefined,
    [template],
  );

  const create = useMutation({
    mutationFn: async (input: AgentInput) => {
      const agent = await withGrant((grant) => api.agents.create(input, grant));
      let routineError: unknown = null;
      if (template?.routine && withRoutine) {
        try {
          await api.routines.create({
            agentId: agent.id,
            name: template.routine.name,
            cron: template.routine.cron,
            prompt: template.routine.prompt,
            timezone: localTimezone(),
            enabled: true,
          });
        } catch (err) {
          routineError = err;
        }
      }
      return { agent, routineError };
    },
    onSuccess: ({ agent, routineError }) => {
      clearDraft(draftKey);
      qc.invalidateQueries({ queryKey: qk.agents });
      qc.invalidateQueries({ queryKey: qk.routines });
      qc.invalidateQueries({ queryKey: qk.bootstrap });
      toast.success(`${agent.avatar} ${agent.name} is ready`, { description: "Say hi or give it a first task." });
      if (routineError) toast.error("The automation couldn't be created", { description: errorMessage(routineError) });
      navigate(`/agents/${agent.id}`);
    },
    onError: (err) => !isGrantCancelled(err) && toast.error("Couldn't create agent", { description: errorMessage(err) }),
  });

  if (!isScratch && templates.isLoading) {
    return (
      <PageBody className="space-y-4 pt-8">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full rounded-xl" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </PageBody>
    );
  }

  if (!isScratch && !template) {
    return (
      <PageBody className="pt-8">
        <EmptyState
          icon={<Bot />}
          title="Template not found"
          description="It may have been removed. Start from scratch or pick another one."
          action={
            <Button variant="outline" onClick={onBack}>
              <ArrowLeft /> Back to templates
            </Button>
          }
        />
      </PageBody>
    );
  }

  return (
    <>
      <PageHeader
        icon={template ? <span className="text-xl">{template.avatar}</span> : <Plus />}
        title={template ? `New agent from “${template.name}”` : "Start from scratch"}
        description="Fine-tune it now or later — everything can be changed in the agent's settings."
        actions={
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft /> Back
          </Button>
        }
      />
      <PageBody>
        <AgentForm
          key={templateId}
          mode="create"
          initial={initial}
          draftKey={draftKey}
          submitLabel="Create agent"
          pending={create.isPending}
          onSubmit={(input) => create.mutate(input)}
          onCancel={onBack}
          footerExtra={
            template?.routine ? (
              <div className="flex items-start gap-2.5">
                <Checkbox id="template-routine" checked={withRoutine} onCheckedChange={(v) => setWithRoutine(v === true)} className="mt-0.5" />
                <Label htmlFor="template-routine" className="block cursor-pointer text-sm leading-snug font-normal">
                  Also create automation <span className="font-medium">{template.routine.name}</span>{" "}
                  <span className="text-muted-foreground">({cronToHuman(template.routine.cron)})</span>
                </Label>
              </div>
            ) : undefined
          }
        />
      </PageBody>
    </>
  );
}
