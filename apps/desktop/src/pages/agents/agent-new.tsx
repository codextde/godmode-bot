import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, Bot, Plus, Sparkles, Wand2, X } from "lucide-react";
import type { Agent, AgentInput } from "@godmode/shared";
import { api, errorMessage, isLicenseRequired } from "@/lib/api";
import { isGrantCancelled, withGrant } from "@/components/vault/grant";
import { qk } from "@/lib/queryKeys";
import { clearDraft, draftKeys, loadDraft, useDraft } from "@/lib/drafts";
import { useAgentTemplates, useBootstrap, useScopeWorkspace } from "@/lib/hooks";
import { templateText } from "@/lib/templates";
import { modKey } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import { useEasyMode } from "@/lib/mode";
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
import { randomLook } from "@/components/agents/character-studio";
import { TeamTemplates } from "@/components/agents/team-templates";
import { RoleTemplates } from "@/components/agents/role-templates";

const EXAMPLES = ["agentNew.examples.invoices", "agentNew.examples.github", "agentNew.examples.pricing", "agentNew.examples.inbox"] as const;

const FORM_DRAFTS = "agent-new:template:";

export default function AgentNewPage() {
  const [params, setParams] = useSearchParams();
  const templateId = params.get("template");
  return templateId ? (
    <FormStep templateId={templateId} onBack={() => setParams({})} />
  ) : (
    <ChooseStep onPick={(id) => setParams({ template: id })} focusStructures={params.get("start") === "structures"} />
  );
}

/* ------------------------------------------------------------------ */
/* Step 1: describe it, or pick a template                              */
/* ------------------------------------------------------------------ */

function ChooseStep({ onPick, focusStructures }: { onPick: (templateId: string) => void; focusStructures: boolean }) {
  const { t } = useTranslation(["agents", "common"]);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: boot } = useBootstrap();
  const workspace = useScopeWorkspace();
  const templates = useAgentTemplates();
  const easy = useEasyMode();
  const [description, setDescription, descriptionDraft] = useDraft("agent-new:describe", "");
  const [focused, setFocused] = useState(false);
  const [draftList, setDraftList] = useState(() => draftKeys(FORM_DRAFTS));
  const drafts = draftList
    .map((key) => ({ key, templateId: key.slice(FORM_DRAFTS.length), values: loadDraft<Partial<AgentFormValues> | null>(key, null) }))
    .filter((d) => d.values !== null)
    .map((d) => ({ ...d, values: { ...agentToValues(undefined), ...d.values } }));
  const draftTemplateName = (id: string) => {
    const tpl = templates.data?.find((x) => x.id === id);
    return tpl ? templateText(tpl).name : t("agentNew.drafts.aTemplate");
  };

  const describe = useMutation({
    mutationFn: () =>
      api.chat.start({
        agentId: boot?.defaultAgentId ?? undefined,
        workspaceId: workspace?.id,
        content: `Create a new agent for me: ${description.trim()}. Configure sensible instructions and an automation if it should work on its own (on a schedule or when something happens).`,
      }),
    onSuccess: (res) => {
      descriptionDraft.discard();
      qc.invalidateQueries({ queryKey: qk.conversationsAll });
      navigate(`/chat/${res.conversation.id}`);
    },
    onError: (err) => !isLicenseRequired(err) && toast.error(t("agentNew.describeError"), { description: errorMessage(err) }),
  });
  const canDescribe = description.trim().length > 3 && !describe.isPending;
  const describeRef = useRef<HTMLTextAreaElement>(null);
  const structuresRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focusStructures) structuresRef.current?.scrollIntoView({ block: "start" });
  }, [focusStructures]);

  const describeSection = (
    <section className="relative overflow-hidden rounded-2xl border bg-paper-2 p-4 @md:p-6 @2xl:p-8">
      <Backdrop className="opacity-60" />
      <div className="relative mx-auto max-w-3xl">
        <div className="mb-4 flex items-center gap-2 text-sm font-medium">
          <span className="grid size-7 place-items-center rounded-md border bg-card text-foreground shadow-card">
            <Wand2 className="size-4" />
          </span>
          <span className="text-base font-medium tracking-[-0.01em]">{easy ? t("agentNew.describe.titleEasy") : t("agentNew.describe.title")}</span>
          <span className="text-muted-foreground">{t("agentNew.describe.subtitle")}</span>
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
            ref={describeRef}
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
            placeholder={t("agentNew.describe.placeholder")}
            aria-label={t("agentNew.describe.label")}
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
              {t("agentNew.describe.submit")}
            </Button>
          </div>
        </form>
        <div className="mt-4 flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => setDescription(t(ex))}
              className="rounded-md border bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-card transition hover:border-foreground/20 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              {t(ex)}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
  const structuresSection = (
    <section ref={structuresRef} className="scroll-mt-6" aria-labelledby="structures-title">
      <div className="mb-4">
        <h2 id="structures-title" className="text-lg font-medium tracking-[-0.02em]">
          {easy ? t("agentNew.structures.titleEasy") : t("agentNew.structures.title")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {easy ? t("agentNew.structures.descriptionEasy") : t("agentNew.structures.description")}
        </p>
      </div>
      <TeamTemplates />
    </section>
  );
  const rolesSection = (
    <RoleTemplates
      title={easy ? t("agentNew.roles.titleEasy") : undefined}
      description={easy ? t("agentNew.roles.descriptionEasy") : undefined}
      blankLabel={easy ? t("agentNew.roles.blankEasy") : undefined}
      templates={templates.data ?? []}
      loading={templates.isLoading}
      onPick={onPick}
      onDescribe={(text) => {
        if (text) setDescription(text);
        describeRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
        describeRef.current?.focus({ preventScroll: true });
      }}
    />
  );

  return (
    <>
      <PageHeader
        icon={<Bot />}
        title={t("agentNew.title")}
        description={easy ? t("agentNew.descriptionEasy") : t("agentNew.description")}
        actions={
          <Button variant="ghost" asChild>
            <Link to="/agents">
              <ArrowLeft /> {t("common:words.agents")}
            </Link>
          </Button>
        }
      />
      <PageBody className="space-y-10">
        {drafts.length > 0 && (
          <section aria-labelledby="agent-drafts-title">
            <h2 id="agent-drafts-title" className="eyebrow mb-3">
              {t("agentNew.drafts.title")}
            </h2>
            <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3">
              {drafts.map((d, i) => (
                <DraftCard
                  key={d.key}
                  values={d.values}
                  source={d.templateId === "scratch" ? t("agentNew.drafts.fromScratch") : t("agentNew.drafts.fromTemplate", { name: draftTemplateName(d.templateId) })}
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

        {easy ? (
          <>
            {rolesSection}
            {describeSection}
            {structuresSection}
          </>
        ) : (
          <>
            {describeSection}
            {structuresSection}
            {rolesSection}
          </>
        )}
        {templates.isError && <p className="text-sm text-muted-foreground">{t("agentNew.templatesUnavailable", { error: errorMessage(templates.error) })}</p>}
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
  const { t } = useTranslation("agents");
  const name = values.name.trim() || t("agentNew.drafts.unnamed");
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index, 6) * 0.04 }}
      className="group relative flex items-center gap-3 rounded-xl border bg-card p-3 pr-2 shadow-card transition hover:border-foreground/15 hover:shadow-float has-[button:focus-visible]:ring-2 has-[button:focus-visible]:ring-ring/50"
    >
      <AgentAvatar agent={{ name, avatar: values.avatar, color: values.color, character: values.character }} size="md" />
      <button
        type="button"
        onClick={onOpen}
        aria-label={t("agentNew.drafts.continueLabel", { name })}
        className="min-w-0 flex-1 text-left outline-none after:absolute after:inset-0 after:rounded-xl"
      >
        <span className="block truncate text-sm font-medium tracking-[-0.01em]">{name}</span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-brand" />
          <span className="truncate">{t("agentNew.drafts.draftSource", { source })}</span>
        </span>
      </button>
      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground transition group-hover:text-foreground">
        {t("agentNew.drafts.continue")} <ArrowRight className="size-3.5 transition group-hover:translate-x-0.5" />
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="button" variant="ghost" size="icon" onClick={onDiscard} aria-label={t("agentNew.drafts.discardLabel", { name })} className="relative z-10 size-7 text-muted-foreground">
            <X />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("agentNew.drafts.discard")}</TooltipContent>
      </Tooltip>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* Step 2: the form                                                     */
/* ------------------------------------------------------------------ */

function FormStep({ templateId, onBack }: { templateId: string; onBack: () => void }) {
  const { t } = useTranslation(["agents", "common"]);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const templates = useAgentTemplates();
  const isScratch = templateId === "scratch";
  const draftKey = FORM_DRAFTS + templateId;
  const template = isScratch ? null : (templates.data?.find((tpl) => tpl.id === templateId) ?? null);
  const [withRoutine, setWithRoutine] = useState(true);

  // Scratch agents get a fresh random look (once per visit); templates bring their own.
  const initial = useMemo<Partial<Agent> | undefined>(
    () =>
      template
        ? {
            name: templateText(template).name,
            avatar: template.avatar,
            color: template.color,
            character: template.character,
            personality: template.personality,
            description: templateText(template).description,
            instructions: template.instructions,
            role: templateText(template).role,
          }
        : isScratch
          ? { ...randomLook(), personality: "buddy" }
          : undefined,
    [template, isScratch],
  );

  const create = useMutation({
    mutationFn: async (input: AgentInput) => {
      const agent = await withGrant((grant) => api.agents.create(input, grant));
      let routineError: unknown = null;
      if (template?.routine && withRoutine) {
        try {
          await api.routines.create({
            agentId: agent.id,
            name: templateText(template).routine!.name,
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
      toast.success(t("agentNew.form.ready", { name: agent.name }), { description: t("agentNew.form.readyDescription") });
      if (routineError) toast.error(t("agentNew.form.routineError"), { description: errorMessage(routineError) });
      navigate(`/agents/${agent.id}`);
    },
    onError: (err) => !isGrantCancelled(err) && toast.error(t("agentNew.form.createError"), { description: errorMessage(err) }),
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
          title={t("agentNew.form.notFound")}
          description={t("agentNew.form.notFoundDescription")}
          action={
            <Button variant="outline" onClick={onBack}>
              <ArrowLeft /> {t("agentNew.form.backToTemplates")}
            </Button>
          }
        />
      </PageBody>
    );
  }

  return (
    <>
      <PageHeader
        icon={
          template ? (
            <AgentAvatar agent={{ id: template.id, avatar: template.avatar, color: template.color, character: template.character }} className="size-8 [&_svg]:size-full!" />
          ) : (
            <Plus />
          )
        }
        title={template ? t("agentNew.form.titleFromTemplate", { name: templateText(template).name }) : t("agentNew.form.titleScratch")}
        description={t("agentNew.form.description")}
        actions={
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft /> {t("common:actions.back")}
          </Button>
        }
      />
      <PageBody>
        <AgentForm
          key={templateId}
          mode="create"
          initial={initial}
          draftKey={draftKey}
          submitLabel={t("agentNew.form.submit")}
          pending={create.isPending}
          onSubmit={(input) => create.mutate(input)}
          onCancel={onBack}
          footerExtra={
            template?.routine ? (
              <div className="flex items-start gap-2.5">
                <Checkbox id="template-routine" checked={withRoutine} onCheckedChange={(v) => setWithRoutine(v === true)} className="mt-0.5" />
                <Label htmlFor="template-routine" className="block cursor-pointer text-sm leading-snug font-normal">
                  <Trans
                    t={t}
                    i18nKey="agentNew.form.alsoRoutine"
                    values={{ name: templateText(template).routine!.name, schedule: cronToHuman(template.routine.cron) }}
                    components={{ b: <span className="font-medium" />, muted: <span className="text-muted-foreground" /> }}
                  />
                </Label>
              </div>
            ) : undefined
          }
        />
      </PageBody>
    </>
  );
}
