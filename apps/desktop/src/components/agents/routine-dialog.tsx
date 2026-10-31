import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ChevronRight, CircleCheck } from "lucide-react";
import type { ComposioConnection, GroupDevice, Routine, RoutineInput, RoutineTrigger, RoutineTriggerType, RoutineNotify } from "@godmode/shared";
import { findModel } from "@godmode/shared";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useAllAgents, useDeviceGroup, useModelCatalog } from "@/lib/hooks";
import { modKey } from "@/lib/desktop";
import { useEasyMode } from "@/lib/mode";
import { clearDraft, useDraft } from "@/lib/drafts";
import { AgentAvatar, DraftStatus, Kbd } from "@/components/common";
import { isGrantCancelled, withGrant } from "@/components/vault/grant";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AppTriggerFields,
  appTriggerProblems,
  connectionUsableBy,
  EMPTY_APP_TRIGGER,
  useAppTriggerSchema,
  type AppTriggerDraft,
} from "@/components/automations/app-trigger-fields";
import { configValue } from "@/components/automations/json-schema-form";
import { EASY_TRIGGER_TEXT, isEventTrigger, TRIGGER_TYPES } from "@/components/automations/trigger-meta";
import { TriggerPicker } from "@/components/automations/trigger-picker";
import { WebhookPanel } from "@/components/automations/webhook-panel";
import { CronBuilder } from "./cron-builder";
import { DEFAULT_CRON, localTimezone, startWindowProblem, validateCron } from "./cron";
import { ModelOptions } from "./model-options";
import { StartWindowField } from "./start-window-field";
import { TimezoneSelect } from "./timezone-select";

/** Conditions are checked hourly unless the human picks otherwise. */
const DEFAULT_CHECK_CRON = "0 * * * *";

const FILTER_PLACEHOLDER_KEYS = {
  app: "routineDialog.filterPlaceholder.app",
  webhook: "routineDialog.filterPlaceholder.webhook",
} as const;

export interface RoutineDraft {
  agentId: string;
  name: string;
  triggerType: RoutineTriggerType;
  /** Schedule triggers: when to run. */
  cron: string;
  /** Schedule triggers: random start window in minutes, 0 = on time. */
  startWindow: number;
  /** Schedule triggers: runs spread over the start window, 1 = once. */
  runs: number;
  /** Condition triggers: how often to check. */
  checkCron: string;
  timezone: string;
  condition: string;
  /** Model for condition checks; null = the agent's. */
  checkModel: string | null;
  app: AppTriggerDraft;
  /** App/webhook triggers: only act on matching events. */
  filter: string;
  prompt: string;
  enabled: boolean;
  reuseConversation: boolean;
  notify: RoutineNotify;
  /** Device groups: "primary" or a device id; null = any. */
  runOn: string | null;
}

/** Like the core: events get a conversation each (named after the event); schedules and conditions keep one. */
function defaultReuse(type: RoutineTriggerType): boolean {
  return !isEventTrigger(type);
}

function initialDraft(routine: Routine | null | undefined, agentId: string | undefined, initial: Partial<RoutineDraft> | undefined): RoutineDraft {
  const t = routine?.trigger;
  const triggerType = t?.type ?? initial?.triggerType ?? "schedule";
  return {
    agentId: routine?.agentId ?? agentId ?? initial?.agentId ?? "",
    name: routine?.name ?? initial?.name ?? "",
    triggerType,
    cron: t?.type === "schedule" ? routine!.cron : (initial?.cron ?? DEFAULT_CRON),
    startWindow: t?.type === "schedule" ? (t.startWindowMinutes ?? 0) : (initial?.startWindow ?? 0),
    runs: t?.type === "schedule" ? (t.runsPerWindow ?? 1) : (initial?.runs ?? 1),
    checkCron: t?.type === "condition" ? routine!.cron : (initial?.checkCron ?? DEFAULT_CHECK_CRON),
    timezone: routine?.timezone || initial?.timezone || localTimezone(),
    condition: t?.type === "condition" ? t.condition : (initial?.condition ?? ""),
    checkModel: t?.type === "condition" ? t.checkModel : (initial?.checkModel ?? null),
    app:
      t?.type === "app"
        ? { connectionId: t.connectionId, toolkit: t.toolkit, triggerSlug: t.triggerSlug, triggerName: t.triggerName, config: { values: t.config ?? {}, json: {} } }
        : (initial?.app ?? EMPTY_APP_TRIGGER),
    filter: routine?.filter ?? initial?.filter ?? "",
    prompt: routine?.prompt ?? initial?.prompt ?? "",
    enabled: routine?.enabled ?? initial?.enabled ?? true,
    reuseConversation: routine?.reuseConversation ?? initial?.reuseConversation ?? defaultReuse(triggerType),
    notify: routine?.notify ?? "failures",
    runOn: routine?.runOn ?? initial?.runOn ?? null,
  };
}

/**
 * Create / edit an automation. Pass `routine` to edit; `agentId` to lock the agent when creating.
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
  const { t } = useTranslation(["agents", "common"]);
  const qc = useQueryClient();
  const { data: agents = [] } = useAllAgents();
  const { catalog } = useModelCatalog();
  const editing = !!routine;
  const [draftKey] = useState(() => (routine ? `routine:${routine.id}` : `routine:new:${agentId ?? "any"}:${JSON.stringify(initial ?? {})}`));
  const [base] = useState(() => initialDraft(routine, agentId, initial));
  const [draft, setDraft, kept] = useDraft(draftKey, base);
  const [touched, setTouched] = useState(false);
  /** Not part of the draft: a switch left on must not outlive the prompt it was meant for. */
  const [reveal, setReveal] = useState(false);
  /** Until the human sets "Keep one conversation" on a new automation, it follows the trigger type's default. */
  const reusePreset = editing || initial?.reuseConversation !== undefined;
  const [reuseChosen, setReuseChosen] = useState(reusePreset || draft.reuseConversation !== defaultReuse(draft.triggerType));
  /** An automation that just became a webhook: its URL is shown before the dialog closes. */
  const [created, setCreated] = useState<Routine | null>(null);
  const easy = useEasyMode();
  /** Easy mode: the cron expression, start window and check model wait behind "Advanced". */
  const [advanced, setAdvanced] = useState(false);
  /** Bumped when the expression is typed by hand, so the friendly picker reads it again. */
  const [cronKey, setCronKey] = useState(0);
  const set = <K extends keyof RoutineDraft>(k: K, v: RoutineDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const setTriggerType = (t: RoutineTriggerType) =>
    setDraft((d) => ({ ...d, triggerType: t, reuseConversation: reuseChosen ? d.reuseConversation : defaultReuse(t) }));
  const setReuse = (v: boolean) => {
    setReuseChosen(true);
    set("reuseConversation", v);
  };
  /** Another agent may not reach the chosen account; drop it then (the account picker only offers reachable ones). */
  const setAgent = (id: string) =>
    setDraft((d) => {
      const next = agents.find((a) => a.id === id);
      const connection = qc.getQueryData<ComposioConnection[]>(qk.composioConnections)?.find((c) => c.id === d.app.connectionId);
      const keep = !d.app.connectionId || (!!next && !!connection && connectionUsableBy(connection, next));
      return { ...d, agentId: id, app: keep ? d.app : EMPTY_APP_TRIGGER };
    });

  const type = draft.triggerType;
  const meta = TRIGGER_TYPES[type];
  const eventTrigger = isEventTrigger(type);
  const { data: group } = useDeviceGroup();
  const pinnable = !!group?.role && !eventTrigger;
  const appSchema = useAppTriggerSchema(draft.app);

  const windowProblem = useMemo(
    () => (type === "schedule" ? startWindowProblem(draft.cron, draft.timezone, draft.startWindow) : null),
    [type, draft.cron, draft.timezone, draft.startWindow],
  );
  const [scheduleProblem, setScheduleProblem] = useState<string | null>(null);
  const [checkProblem, setCheckProblem] = useState<string | null>(null);
  const cronError =
    type === "schedule"
      ? (validateCron(draft.cron) ?? scheduleProblem ?? windowProblem)
      : type === "condition"
        ? (validateCron(draft.checkCron) ?? checkProblem)
        : null;
  const advancedProblem = type === "schedule" ? (validateCron(draft.cron) ?? windowProblem) : type === "condition" ? validateCron(draft.checkCron) : null;
  const appProblems = type === "app" ? appTriggerProblems(draft.app, appSchema) : null;
  /** The event's settings can't be checked until its schema is known: no saving meanwhile (the fields say why). */
  const schemaBlocked = !!appProblems?.schema;
  const problems = {
    agentId: !draft.agentId ? t("routineDialog.problems.agent") : null,
    name: !draft.name.trim() ? t("routineDialog.problems.name") : null,
    condition: type === "condition" && !draft.condition.trim() ? t("routineDialog.problems.condition") : null,
    prompt: !draft.prompt.trim() ? (eventTrigger ? t("routineDialog.problems.promptEvent") : t("routineDialog.problems.prompt")) : null,
  };
  const appInvalid =
    !!appProblems && (!!appProblems.connection || !!appProblems.trigger || schemaBlocked || Object.keys(appProblems.config).length > 0);
  const invalid = !!cronError || appInvalid || Object.values(problems).some(Boolean);

  const buildTrigger = (): RoutineTrigger => {
    switch (type) {
      case "schedule":
        if (!draft.startWindow) return { type: "schedule" };
        return draft.runs > 1
          ? { type: "schedule", startWindowMinutes: draft.startWindow, runsPerWindow: draft.runs }
          : { type: "schedule", startWindowMinutes: draft.startWindow };
      case "app": {
        const { connectionId, toolkit, triggerSlug, triggerName, config } = draft.app;
        return {
          type: "app",
          connectionId,
          toolkit,
          triggerSlug,
          triggerName: appSchema.triggerType?.name ?? triggerName,
          config: configValue(appSchema.fields, config),
        };
      }
      case "condition":
        return { type: "condition", condition: draft.condition.trim(), checkModel: draft.checkModel };
      case "webhook":
        return { type: "webhook" };
    }
  };

  const save = useMutation({
    mutationFn: () => {
      const input: RoutineInput = {
        agentId: draft.agentId,
        name: draft.name.trim(),
        trigger: buildTrigger(),
        cron: type === "schedule" ? draft.cron.trim() : type === "condition" ? draft.checkCron.trim() : undefined,
        timezone: draft.timezone,
        prompt: draft.prompt.trim(),
        filter: eventTrigger ? draft.filter.trim() : "",
        enabled: draft.enabled,
        reuseConversation: draft.reuseConversation,
        notify: draft.notify,
        runOn: pinnable ? draft.runOn : undefined,
      };
      if (!routine) return api.routines.create(input);
      if (!routine.fillOnly || !reveal) return api.routines.update(routine.id, input);
      return withGrant((grant) => api.routines.update(routine.id, { ...input, fillOnly: false }, grant), t("routineDialog.revealGrant"));
    },
    onSuccess: (r) => {
      clearDraft(draftKey);
      qc.invalidateQueries({ queryKey: qk.routines });
      if (editing) toast.success(t("routineDialog.toast.updated"), { description: r.name });
      else if (r.trigger.type === "schedule") toast.success(t("routineDialog.toast.scheduled"), { description: r.name });
      else toast.success(t("routineDialog.toast.created"), { description: r.name });
      // A new webhook (created, or switched to from another trigger): show its URL before closing.
      if (r.trigger.type === "webhook" && routine?.trigger.type !== "webhook") setCreated(r);
      else onOpenChange(false);
    },
    onError: (err) => {
      if (!isGrantCancelled(err)) toast.error(editing ? t("routineDialog.toast.updateError") : t("routineDialog.toast.createError"), { description: errorMessage(err) });
    },
  });

  const submit = () => {
    setTouched(true);
    if (easy && advancedProblem) setAdvanced(true);
    if (!invalid && !save.isPending) save.mutate();
  };

  const checkModelField = (
    <div className="space-y-1.5">
      <Label htmlFor="routine-check-model" className="text-xs text-muted-foreground">
        {t("routineDialog.checkModel")}
      </Label>
      <Select
        value={findModel(catalog.models, draft.checkModel)?.id ?? (draft.checkModel || "__agent")}
        onValueChange={(v) => set("checkModel", v === "__agent" ? null : v)}
      >
        <SelectTrigger id="routine-check-model" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value="__agent">{t("routineDialog.agentModel")}</SelectItem>
          <SelectSeparator />
          <ModelOptions models={catalog.models} current={draft.checkModel ?? undefined} />
        </SelectContent>
      </Select>
    </div>
  );
  const checkModelHint = <p className="text-xs text-muted-foreground">{t("routineDialog.checkModelHint")}</p>;
  const startWindowField = (
    <StartWindowField cron={draft.cron} timezone={draft.timezone} value={draft.startWindow} onChange={(m) => setDraft((d) => ({ ...d, startWindow: m, runs: 1 }))} />
  );
  const typeCron = (c: string) => {
    set(type === "condition" ? "checkCron" : "cron", c);
    setCronKey((k) => k + 1);
  };
  const advancedSummary =
    type === "schedule"
      ? draft.runs <= 1
        ? t("routineDialog.advancedSummary.scheduleWindow")
        : t("routineDialog.advancedSummary.schedule")
      : type === "condition"
        ? t("routineDialog.advancedSummary.condition")
        : null;

  const selectableAgents = agents.filter((a) => a.enabled || a.id === draft.agentId);
  const Icon = created ? CircleCheck : meta.icon;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg border bg-card text-foreground shadow-card">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={created ? "created" : type}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.18 }}
                  className="grid place-items-center"
                >
                  <Icon className={created ? "size-5 text-success" : "size-5"} />
                </motion.span>
              </AnimatePresence>
            </div>
            <div className="min-w-0">
              <DialogTitle>{created ? (easy ? t("routineDialog.title.linkReady") : t("routineDialog.title.webhookReady")) : editing ? t("routineDialog.title.edit") : t("routineDialog.title.new")}</DialogTitle>
              <DialogDescription>
                {created
                  ? easy
                    ? t("routineDialog.description.linkReady", { name: created.name })
                    : t("routineDialog.description.webhookReady", { name: created.name })
                  : t("routineDialog.description.default")}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {created ? (
          <div className="space-y-5">
            <WebhookPanel routine={created} />
            <DialogFooter>
              <Button type="button" onClick={() => onOpenChange(false)}>
                {t("common:actions.done")}
              </Button>
            </DialogFooter>
          </div>
        ) : (
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
                  <Label htmlFor="routine-agent">{t("common:words.agent")}</Label>
                  <Select value={draft.agentId} onValueChange={setAgent} disabled={editing}>
                    <SelectTrigger
                      id="routine-agent"
                      className="w-full"
                      aria-invalid={touched && !!problems.agentId}
                      aria-describedby={touched && problems.agentId ? "routine-agent-error" : undefined}
                    >
                      <SelectValue placeholder={t("routineDialog.agentPlaceholder")} />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      {selectableAgents.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          <AgentAvatar agent={a} size="sm" still className="size-4" /> {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {touched && problems.agentId && (
                    <p id="routine-agent-error" className="text-xs text-destructive">
                      {problems.agentId}
                    </p>
                  )}
                </div>
              )}
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="routine-name">{t("common:words.name")}</Label>
                <Input
                  id="routine-name"
                  value={draft.name}
                  onChange={(e) => set("name", e.target.value)}
                  placeholder={t(`routineDialog.namePlaceholder.${type}`)}
                  aria-invalid={touched && !!problems.name}
                  aria-describedby={touched && problems.name ? "routine-name-error" : undefined}
                  autoFocus
                />
                {touched && problems.name && (
                  <p id="routine-name-error" className="text-xs text-destructive">
                    {problems.name}
                  </p>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <div className="eyebrow">{t("routineDialog.whenToRun")}</div>
              <TriggerPicker value={type} onChange={setTriggerType} />
            </div>

            <fieldset className="space-y-3 rounded-xl border bg-paper-2 p-4">
              <legend className="eyebrow px-1">{easy ? EASY_TRIGGER_TEXT[type].title : meta.label}</legend>
              <motion.div key={type} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className="space-y-3">
                {type === "schedule" && (
                  <>
                    <CronBuilder
                      key={cronKey}
                      value={draft.cron}
                      onChange={(c) => set("cron", c)}
                      idPrefix="routine-cron"
                      startWindowMinutes={draft.startWindow}
                      runsPerWindow={draft.runs}
                      onWindowChange={(w) => setDraft((d) => ({ ...d, startWindow: w.startWindowMinutes, runs: w.runsPerWindow }))}
                      onProblemChange={setScheduleProblem}
                      problem={windowProblem}
                      simple={easy}
                    >
                      {!easy && startWindowField}
                    </CronBuilder>
                    <TimezoneField value={draft.timezone} onChange={(tz) => set("timezone", tz)} />
                  </>
                )}

                {type === "app" && (
                  <AppTriggerFields
                    value={draft.app}
                    onChange={(app) => set("app", app)}
                    agent={agents.find((a) => a.id === draft.agentId)}
                    showProblems={touched}
                  />
                )}

                {type === "condition" && (
                  <>
                    <div className="space-y-1.5">
                      <Label htmlFor="routine-condition" className="text-xs text-muted-foreground">
                        {t("routineDialog.conditionLabel")}
                      </Label>
                      <Textarea
                        id="routine-condition"
                        value={draft.condition}
                        onChange={(e) => set("condition", e.target.value)}
                        placeholder={t("routineDialog.conditionPlaceholder")}
                        aria-invalid={touched && !!problems.condition}
                        aria-describedby={touched && problems.condition ? "routine-condition-error routine-condition-hint" : "routine-condition-hint"}
                        className="min-h-16 text-sm leading-relaxed"
                      />
                      {touched && problems.condition && (
                        <p id="routine-condition-error" className="text-xs text-destructive">
                          {problems.condition}
                        </p>
                      )}
                      <p id="routine-condition-hint" className="text-xs text-muted-foreground">
                        {t("routineDialog.conditionHint")}
                      </p>
                    </div>
                    <div className="space-y-2">
                      <div className="text-xs font-medium">{t("routineDialog.checkFrequency")}</div>
                      <CronBuilder
                        key={cronKey}
                        value={draft.checkCron}
                        onChange={(c) => set("checkCron", c)}
                        idPrefix="routine-check"
                        onProblemChange={setCheckProblem}
                        simple={easy}
                      />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <TimezoneField value={draft.timezone} onChange={(tz) => set("timezone", tz)} />
                      {!easy && checkModelField}
                    </div>
                    {!easy && checkModelHint}
                  </>
                )}

                {type === "webhook" && (
                  <>
                    <p className="text-sm text-muted-foreground">
                      {easy
                        ? t("routineDialog.webhookIntroEasy")
                        : t("routineDialog.webhookIntroPro")}
                    </p>
                    {routine?.trigger.type === "webhook" ? (
                      <WebhookPanel routine={routine} />
                    ) : (
                      <p className="rounded-lg border border-dashed bg-card/60 px-3 py-2.5 text-xs text-muted-foreground">
                        {easy
                          ? editing
                            ? t("routineDialog.webhookAfter.linkSave")
                            : t("routineDialog.webhookAfter.linkCreate")
                          : editing
                            ? t("routineDialog.webhookAfter.urlSave")
                            : t("routineDialog.webhookAfter.urlCreate")}
                      </p>
                    )}
                  </>
                )}

                {eventTrigger && (
                  <div className="space-y-1.5">
                    <Label htmlFor="routine-filter" className="text-xs text-muted-foreground">
                      {t("routineDialog.filterLabel")} <span className="font-normal">{t("common:words.optional")}</span>
                    </Label>
                    <Input
                      id="routine-filter"
                      value={draft.filter}
                      onChange={(e) => set("filter", e.target.value)}
                      placeholder={type === "app" || type === "webhook" ? t(FILTER_PLACEHOLDER_KEYS[type]) : undefined}
                      aria-describedby="routine-filter-hint"
                    />
                    <p id="routine-filter-hint" className="text-xs text-muted-foreground">
                      {t("routineDialog.filterHint")}
                    </p>
                  </div>
                )}

                {easy && advancedSummary && (
                  <Collapsible open={advanced} onOpenChange={setAdvanced}>
                    <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
                      <ChevronRight className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-90" /> {t("routineDialog.advanced")}
                      <span className="truncate font-normal text-muted-foreground/80">· {advancedSummary}</span>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="-mx-1 overflow-hidden px-1 pb-1 data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
                      <div className="space-y-3 pt-3">
                        {type === "schedule" && draft.runs <= 1 && startWindowField}
                        <RawCronField
                          id="routine-cron-raw"
                          label={type === "condition" ? t("routineDialog.rawCron.check") : t("routineDialog.rawCron.schedule")}
                          value={type === "condition" ? draft.checkCron : draft.cron}
                          onChange={typeCron}
                        />
                        {type === "condition" && (
                          <>
                            {checkModelField}
                            {checkModelHint}
                          </>
                        )}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                )}
              </motion.div>
            </fieldset>

            <div className="space-y-1.5">
              <Label htmlFor="routine-prompt">{t("routineDialog.promptLabel")}</Label>
              <Textarea
                id="routine-prompt"
                value={draft.prompt}
                onChange={(e) => set("prompt", e.target.value)}
                placeholder={meta.promptPlaceholder}
                aria-invalid={touched && !!problems.prompt}
                aria-describedby={touched && problems.prompt ? "routine-prompt-error" : undefined}
                className="min-h-28 text-sm leading-relaxed"
              />
              {touched && problems.prompt && (
                <p id="routine-prompt-error" className="text-xs text-destructive">
                  {problems.prompt}
                </p>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <SwitchCard
                id="routine-reuse"
                title={t("routineDialog.reuse.title")}
                description={eventTrigger ? t("routineDialog.reuse.event") : t("routineDialog.reuse.schedule")}
                checked={draft.reuseConversation}
                onChange={setReuse}
              />
              <SwitchCard
                id="routine-enabled"
                title={t("routineDialog.enabled.title")}
                description={eventTrigger ? t("routineDialog.enabled.event") : t("routineDialog.enabled.schedule")}
                checked={draft.enabled}
                onChange={(v) => set("enabled", v)}
              />
              {routine?.fillOnly && agents.find((a) => a.id === routine.agentId)?.permissions.secretAccess === "reveal" && (
                <div className="sm:col-span-2">
                  <SwitchCard
                    id="routine-reveal"
                    title={t("routineDialog.reveal.title")}
                    description={t("routineDialog.reveal.description")}
                    checked={reveal}
                    onChange={setReveal}
                  />
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <Label htmlFor="routine-notify" className="shrink-0">
                {t("routineDialog.notify.label")}
              </Label>
              <Select value={draft.notify} onValueChange={(v) => set("notify", v as RoutineNotify)}>
                <SelectTrigger id="routine-notify" className="w-56" aria-describedby="routine-notify-hint">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="failures">{t("routineDialog.notify.failures")}</SelectItem>
                  <SelectItem value="always">{t("routineDialog.notify.always")}</SelectItem>
                  <SelectItem value="never">{t("common:words.never")}</SelectItem>
                </SelectContent>
              </Select>
              <p id="routine-notify-hint" className="basis-full text-xs text-muted-foreground">
                {draft.notify === "never"
                  ? t("routineDialog.notify.neverHint")
                  : draft.notify === "always"
                    ? t("routineDialog.notify.alwaysHint")
                    : t("routineDialog.notify.failuresHint")}
              </p>
            </div>

            {pinnable && <RunOnField devices={group.devices} value={draft.runOn} onChange={(v) => set("runOn", v)} />}

            <DialogFooter className="items-center sm:justify-between">
              {kept.saved ? (
                <DraftStatus
                  onDiscard={() => {
                    kept.discard();
                    setTouched(false);
                    setReuseChosen(reusePreset);
                  }}
                />
              ) : (
                <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
                  <Kbd>{modKey}</Kbd>
                  <Kbd>↵</Kbd> {t("routineDialog.toSave")}
                </span>
              )}
              <div className="flex gap-2">
                <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                  {t("common:actions.cancel")}
                </Button>
                <Button type="submit" disabled={save.isPending || schemaBlocked || (touched && invalid)}>
                  {save.isPending && <Spinner />}
                  {editing ? t("routineDialog.saveChanges") : t("routineDialog.create")}
                </Button>
              </div>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The expression behind a schedule, for the rare one the friendly picker can't express. */
const ANY_DEVICE = "__any";

/** Device groups: the one computer that runs a schedule or check (one with its files and browser profiles). */
function RunOnField({ devices: list, value, onChange }: { devices: GroupDevice[]; value: string | null; onChange: (runOn: string | null) => void }) {
  const { t } = useTranslation("agents");
  const devices = list.map((d) => ({
    value: d.id ?? "primary",
    name: d.name,
    tag: [d.role === "primary" ? t("routineDialog.runOn.primary") : null, d.self ? t("routineDialog.runOn.thisComputer") : null].filter(Boolean).join(", "),
    online: d.state === "online",
  }));
  const picked = value ? devices.find((d) => d.value === value) : null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <Label htmlFor="routine-run-on" className="shrink-0">
        {t("routineDialog.runOn.label")}
      </Label>
      <Select value={value ?? ANY_DEVICE} onValueChange={(v) => onChange(v === ANY_DEVICE ? null : v)}>
        <SelectTrigger id="routine-run-on" className="w-56" aria-describedby="routine-run-on-hint">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value={ANY_DEVICE}>{t("routineDialog.runOn.any")}</SelectItem>
          <SelectSeparator />
          {devices.map((d) => (
            <SelectItem key={d.value} value={d.value}>
              {d.name}
              {d.tag && <span className="ml-1.5 text-xs text-muted-foreground">{d.tag}</span>}
            </SelectItem>
          ))}
          {value && !picked && <SelectItem value={value}>{t("routineDialog.runOn.another")}</SelectItem>}
        </SelectContent>
      </Select>
      <p id="routine-run-on-hint" className="basis-full text-xs text-muted-foreground">
        {!value
          ? t("routineDialog.runOn.anyHint")
          : picked
            ? picked.online
              ? t("routineDialog.runOn.pickedHint", { name: picked.name })
              : t("routineDialog.runOn.pickedOfflineHint", { name: picked.name })
            : t("routineDialog.runOn.unlistedHint")}
      </p>
    </div>
  );
}

function RawCronField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (cron: string) => void }) {
  const { t } = useTranslation("agents");
  const problem = validateCron(value);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label} <span className="font-normal">{t("cronBuilder.cronFields")}</span>
      </Label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0 9 * * 1-5"
        spellCheck={false}
        aria-invalid={!!problem}
        aria-describedby={problem ? `${id}-error` : undefined}
        className="font-mono"
      />
      {problem && (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}

function TimezoneField({ value, onChange }: { value: string; onChange: (tz: string) => void }) {
  const { t } = useTranslation("agents");
  return (
    <div className="space-y-1.5">
      <Label htmlFor="routine-tz" className="text-xs text-muted-foreground">
        {t("routineDialog.timezone")}
      </Label>
      <TimezoneSelect id="routine-tz" value={value} onChange={onChange} />
    </div>
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
    <div className="flex items-start gap-3 rounded-lg border bg-card p-3 shadow-card">
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
