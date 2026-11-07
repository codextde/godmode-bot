import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_CRON,
  findModel,
  validateCron,
  type Agent,
  type AppTriggerEvent,
  type ComposioConnection,
  type Routine,
  type RoutineInput,
  type RoutineNotify,
  type RoutineTrigger,
  type RoutineTriggerType,
} from "@godmode/shared";
import { useFullAccess } from "@/components/admin";
import { AppTriggerFields } from "@/components/app-trigger-fields";
import { CharacterAvatar } from "@/components/character";
import { CronBuilder, StartWindowField, startWindowProblem } from "@/components/cron-builder";
import { Group, PickerRow, SwitchRow, Tile, type Option } from "@/components/form";
import { Icon, type IconName } from "@/components/icon";
import { phoneTimezone, triggerText, TRIGGER_TITLES } from "@/components/routine-row";
import { TimezoneRow } from "@/components/timezone-picker";
import { ErrorState, LoadingState, T, tap } from "@/components/ui";
import { WebhookPanel } from "@/components/webhook-panel";
import { api, errorText } from "@/lib/api";
import { appTriggerProblems, automationAdmin, connectionUsableBy, EMPTY_APP_TRIGGER, useAppTriggerSchema, type AppTriggerDraft } from "@/lib/automation-admin";
import { usePlaces, type Place } from "@/lib/chat-extras";
import { useModelCatalog } from "@/lib/composer";
import { useAgents } from "@/lib/hooks";
import { ik } from "@/lib/integrations";
import { qk, queryClient } from "@/lib/query";
import { configValue } from "@/lib/schema-form";
import { isCancelled, withGrant } from "@/lib/secrets";
import { radius, space, useColors } from "@/lib/theme";

/** Conditions are checked hourly unless the human picks otherwise. */
const DEFAULT_CHECK_CRON = "0 * * * *";
const AGENT_MODEL = "__agent";
const MAX_MORE_APPS = 9;

const NAME_PLACEHOLDERS = {
  schedule: "edit.namePlaceholder.schedule",
  app: "edit.namePlaceholder.app",
  condition: "edit.namePlaceholder.condition",
  webhook: "edit.namePlaceholder.webhook",
} as const satisfies Record<RoutineTriggerType, string>;

const PROMPT_PLACEHOLDERS = {
  schedule: "edit.promptPlaceholder.schedule",
  app: "edit.promptPlaceholder.app",
  condition: "edit.promptPlaceholder.condition",
  webhook: "edit.promptPlaceholder.webhook",
} as const satisfies Record<RoutineTriggerType, string>;

const FILTER_PLACEHOLDERS = {
  app: "edit.filterPlaceholder.app",
  webhook: "edit.filterPlaceholder.webhook",
} as const satisfies Partial<Record<RoutineTriggerType, string>>;

const TRIGGER_OPTIONS = [
  { type: "schedule", icon: "clock" },
  { type: "app", icon: "layers" },
  { type: "condition", icon: "eye" },
  { type: "webhook", icon: "link" },
] as const satisfies readonly { type: RoutineTriggerType; icon: IconName }[];

/** A limited phone sets up schedules and conditions; app accounts and secret URLs need full access. */
const LIMITED_TRIGGERS: readonly RoutineTriggerType[] = ["schedule", "condition"];

const NOTIFY_VALUES: RoutineNotify[] = ["failures", "always", "never"];

const NOTIFY_FOOTERS = {
  never: "edit.notifyFooter.never",
  always: "edit.notifyFooter.always",
  failures: "edit.notifyFooter.failures",
} as const satisfies Record<RoutineNotify, string>;

/** A full-access phone's automations aren't limited to filling in logins. */
const NOTIFY_FOOTERS_FULL = {
  never: "edit.notifyFooterFull.never",
  always: "edit.notifyFooterFull.always",
  failures: "edit.notifyFooterFull.failures",
} as const satisfies Record<RoutineNotify, string>;

interface Draft {
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
  condition: string;
  /** Model for condition checks; null = the agent's. */
  checkModel: string | null;
  app: AppTriggerDraft;
  /** More app events that start the same automation. */
  moreApps: MoreAppDraft[];
  /** App/webhook triggers: only act on matching events. */
  filter: string;
  prompt: string;
  enabled: boolean;
  reuseConversation: boolean;
  notify: RoutineNotify;
  /** Schedules and conditions. */
  timezone: string;
  /** Device groups: the one computer that runs it; null = wherever schedules run. */
  runOn: string | null;
}

type MoreAppDraft = AppTriggerDraft & { key: string };

const newKey = () => Math.random().toString(36).slice(2, 10);

function appDraftOf(e: AppTriggerEvent): AppTriggerDraft {
  return { connectionId: e.connectionId, toolkit: e.toolkit, triggerSlug: e.triggerSlug, triggerName: e.triggerName, config: { values: e.config ?? {}, json: {} } };
}

/** Like the core: events get a chat each (named after the event); schedules and conditions keep one. */
const defaultReuse = (type: RoutineTriggerType) => type === "schedule" || type === "condition";

function initialDraft(routine: Routine | null, agentId: string): Draft {
  const t = routine?.trigger;
  return {
    agentId: routine?.agentId ?? agentId,
    name: routine?.name ?? "",
    triggerType: t?.type ?? "schedule",
    cron: t?.type === "schedule" ? routine!.cron : DEFAULT_CRON,
    startWindow: t?.type === "schedule" ? (t.startWindowMinutes ?? 0) : 0,
    runs: t?.type === "schedule" ? (t.runsPerWindow ?? 1) : 1,
    checkCron: t?.type === "condition" ? routine!.cron : DEFAULT_CHECK_CRON,
    condition: t?.type === "condition" ? t.condition : "",
    checkModel: t?.type === "condition" ? t.checkModel : null,
    app: t?.type === "app" ? appDraftOf(t) : EMPTY_APP_TRIGGER,
    moreApps: t?.type === "app" ? (t.moreEvents ?? []).map((e) => ({ ...appDraftOf(e), key: newKey() })) : [],
    filter: routine?.filter ?? "",
    prompt: routine?.prompt ?? "",
    enabled: routine?.enabled ?? true,
    reuseConversation: routine?.reuseConversation ?? true,
    notify: routine?.notify ?? "failures",
    timezone: routine?.timezone || phoneTimezone() || "UTC",
    runOn: routine?.runOn ?? null,
  };
}

/**
 * Create (`agentId` preselects the agent) or edit (`id`) an automation, like the desktop's routine dialog: a schedule, an
 * app event, a condition or a webhook. A limited phone sets up schedules and conditions only.
 */
export default function AutomationEdit() {
  const { t } = useTranslation(["automations", "common"]);
  const { id, agentId } = useLocalSearchParams<{ id?: string; agentId?: string }>();
  const list = useQuery({ queryKey: qk.allRoutines, queryFn: () => api.routines.list(), enabled: !!id });
  const agents = useAgents();
  const routine = id ? list.data?.find((r) => r.id === id) : undefined;

  if ((id && !routine) || !agents.data) {
    const loading = (!!id && list.isLoading) || agents.isLoading;
    const error = id && list.isError ? list.error : agents.isError ? agents.error : null;
    return (
      <View style={{ flex: 1 }}>
        <Header title={id ? t("edit.titleEdit") : t("edit.titleNew")} />
        <View style={{ flex: 1, justifyContent: "center" }}>
          {loading ? (
            <LoadingState />
          ) : (
            <ErrorState
              title={error ? t("edit.loadFailed") : t("automation.notFound")}
              error={error ? errorText(error) : t("automation.maybeDeleted")}
              onRetry={error ? () => void (id && list.isError ? list.refetch() : agents.refetch()) : undefined}
            />
          )}
        </View>
      </View>
    );
  }
  const preset = agents.data.find((a) => a.id === agentId && a.enabled) ?? agents.data.find((a) => a.isDefault && a.enabled) ?? agents.data.find((a) => a.enabled);
  return <AutomationForm routine={routine ?? null} agents={agents.data} defaultAgentId={preset?.id ?? ""} />;
}

function AutomationForm({ routine, agents, defaultAgentId }: { routine: Routine | null; agents: Agent[]; defaultAgentId: string }) {
  const c = useColors();
  const { t } = useTranslation(["automations", "common"]);
  const admin = useFullAccess().fullAccess === true;
  const catalog = useModelCatalog();
  const editing = !!routine;
  const [draft, setDraft] = useState(() => initialDraft(routine, defaultAgentId));
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  // Until the human sets "Keep one chat" on a new automation, it follows the trigger's default.
  const [reuseChosen, setReuseChosen] = useState(editing);
  const [moreResolved, setMoreResolved] = useState<Record<string, AppTriggerEvent | null>>({});
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const type = draft.triggerType;
  // A limited phone keeps an app or webhook trigger as it is: accounts and secret URLs need full access.
  const triggerEditable = admin || LIMITED_TRIGGERS.includes(type);
  const eventTrigger = type === "app" || type === "webhook";
  // A limited phone can't ask for app events; it keeps the trigger as it is anyway.
  const appSchema = useAppTriggerSchema(admin ? draft.app : EMPTY_APP_TRIGGER);
  const timezone = draft.timezone;
  const zone = timezone !== phoneTimezone() ? timezone.replace(/_/g, " ") : null;
  const windowProblem = type === "schedule" ? startWindowProblem(draft.cron, timezone, draft.startWindow) : null;
  const cronError = type === "schedule" ? (validateCron(draft.cron) ?? windowProblem) : type === "condition" ? validateCron(draft.checkCron) : null;
  const appProblems = type === "app" && admin ? appTriggerProblems(draft.app, appSchema) : null;
  const problems = {
    agentId: !draft.agentId ? t("edit.problem.agent") : null,
    name: !draft.name.trim() ? t("edit.problem.name") : null,
    condition: type === "condition" && !draft.condition.trim() ? t("edit.problem.condition") : null,
    prompt: !draft.prompt.trim() ? (eventTrigger ? t("edit.problem.promptEvent") : t("edit.problem.prompt")) : null,
  };
  const appProblem = appProblems
    ? (appProblems.connection ??
      appProblems.trigger ??
      appProblems.schema ??
      Object.values(appProblems.config)[0] ??
      (draft.moreApps.some((m) => !moreResolved[m.key]) ? t("edit.problem.moreApps") : null))
    : null;
  const firstProblem = Object.values(problems).find(Boolean) ?? cronError ?? appProblem;
  const choosable = agents.filter((a) => a.enabled || a.id === draft.agentId);
  const agent = agents.find((a) => a.id === draft.agentId);
  const notifyOptions: Option<RoutineNotify>[] = NOTIFY_VALUES.map((value) => ({ value, label: t(`notify.${value}`) }));
  const models = catalog.data?.models ?? [];
  const checkModel = findModel(models, draft.checkModel)?.id ?? draft.checkModel ?? AGENT_MODEL;
  const modelOptions: Option<string>[] = [
    { value: AGENT_MODEL, label: t("edit.agentModel") },
    ...models.map((m) => ({ value: m.id, label: m.label, detail: m.description || undefined })),
    ...(draft.checkModel && !findModel(models, draft.checkModel) ? [{ value: draft.checkModel, label: draft.checkModel }] : []),
  ];
  const triggers = TRIGGER_OPTIONS.filter((o) => admin || LIMITED_TRIGGERS.includes(o.type));
  const places = usePlaces(admin);
  const pinnable = admin && places.length > 0 && !eventTrigger;
  // An agent set it up, so its runs only fill logins in; lifting that takes a grant, and only for an agent that may read secrets.
  const [reveal, setReveal] = useState(false);
  const canReveal = admin && !!routine?.fillOnly && agent?.permissions.secretAccess === "reveal";

  const setType = (next: RoutineTriggerType) => setDraft((d) => ({ ...d, triggerType: next, reuseConversation: reuseChosen ? d.reuseConversation : defaultReuse(next) }));
  /** Another agent may not reach the chosen account: then it is dropped (the account picker offers only reachable ones). */
  const setAgent = (id: string) =>
    setDraft((d) => {
      const next = agents.find((a) => a.id === id);
      const connections = queryClient.getQueryData<ComposioConnection[]>(ik.composioConnections) ?? [];
      const keep = (app: AppTriggerDraft) => {
        const connection = connections.find((x) => x.id === app.connectionId);
        return !app.connectionId || (!!next && !!connection && connectionUsableBy(connection, next));
      };
      return { ...d, agentId: id, app: keep(d.app) ? d.app : EMPTY_APP_TRIGGER, moreApps: d.moreApps.filter(keep) };
    });
  const setMoreApp = (key: string, app: AppTriggerDraft) => set("moreApps", draft.moreApps.map((m) => (m.key === key ? { ...app, key } : m)));
  const addMoreApp = () => set("moreApps", [...draft.moreApps, { ...EMPTY_APP_TRIGGER, connectionId: draft.app.connectionId, toolkit: draft.app.toolkit, key: newKey() }]);

  const buildTrigger = (): RoutineTrigger => {
    switch (type) {
      case "condition":
        return { type: "condition", condition: draft.condition.trim(), checkModel: draft.checkModel };
      case "app": {
        const { connectionId, toolkit, triggerSlug, triggerName, config } = draft.app;
        const more = draft.moreApps.map((m) => moreResolved[m.key]).filter((e): e is AppTriggerEvent => !!e);
        return {
          type: "app",
          connectionId,
          toolkit,
          triggerSlug,
          triggerName: appSchema.triggerType?.name ?? triggerName,
          config: configValue(appSchema.fields, config),
          ...(more.length ? { moreEvents: more } : {}),
        };
      }
      case "webhook":
        return { type: "webhook" };
      default:
        if (!draft.startWindow) return { type: "schedule" };
        return draft.runs > 1
          ? { type: "schedule", startWindowMinutes: draft.startWindow, runsPerWindow: draft.runs }
          : { type: "schedule", startWindowMinutes: draft.startWindow };
    }
  };

  const save = async () => {
    setTouched(true);
    if (saving) return;
    if (firstProblem) {
      Alert.alert(editing ? t("edit.updateFailed") : t("edit.createFailed"), firstProblem);
      return;
    }
    const common = {
      name: draft.name.trim(),
      prompt: draft.prompt.trim(),
      enabled: draft.enabled,
      reuseConversation: draft.reuseConversation,
      notify: draft.notify,
    };
    const cron = type === "schedule" ? draft.cron.trim() : type === "condition" ? draft.checkCron.trim() : undefined;
    // A limited phone never sends an app or webhook trigger: only what it does and how it reports changes.
    const input: Partial<RoutineInput> = triggerEditable
      ? { ...common, trigger: buildTrigger(), cron, timezone, filter: eventTrigger ? draft.filter.trim() : "", ...(pinnable ? { runOn: draft.runOn } : {}) }
      : { ...common, filter: draft.filter.trim() };
    setSaving(true);
    try {
      const saved = !routine
        ? await api.routines.create({ ...input, agentId: draft.agentId } as RoutineInput)
        : canReveal && reveal
          ? await withGrant((grant) => automationAdmin.updateWithGrant(routine.id, { ...input, fillOnly: false }, grant))
          : await api.routines.update(routine.id, input);
      void queryClient.invalidateQueries({ queryKey: qk.routines });
      tap();
      router.back();
      // A new webhook: its secret URL is on the automation's page.
      if (!routine && saved.trigger.type === "webhook") router.push({ pathname: "/automation/[id]", params: { id: saved.id } });
    } catch (err) {
      if (!isCancelled(err)) Alert.alert(editing ? t("edit.updateFailed") : t("edit.createFailed"), errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      stickyHeaderIndices={[0]}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
    >
      <Header title={editing ? t("edit.titleEdit") : t("edit.titleNew")} action={editing ? t("common:actions.save") : t("common:actions.create")} saving={saving} onSave={() => void save()} />
      <View style={styles.content}>
        <View style={{ gap: space.sm }}>
          <View style={[styles.fields, { backgroundColor: c.surface, borderColor: touched && problems.name ? c.danger : c.border }]}>
            <TextInput
              accessibilityLabel={t("common:words.name")}
              value={draft.name}
              onChangeText={(v) => set("name", v)}
              placeholder={t(NAME_PLACEHOLDERS[type])}
              placeholderTextColor={c.textFaint}
              maxLength={120}
              autoFocus={!editing}
              returnKeyType="done"
              submitBehavior="blurAndSubmit"
              style={[styles.name, { color: c.text }]}
            />
          </View>
          <Problem text={touched ? problems.name : null} />
        </View>

        <View style={{ gap: space.sm }}>
          <T variant="eyebrow" muted>
            {t("common:words.agent")}
          </T>
          {editing ? (
            <View style={styles.chips}>
              <AgentChip agent={agent} active />
            </View>
          ) : (
            <View style={styles.chips}>
              {choosable.map((a) => (
                <AgentChip key={a.id} agent={a} active={a.id === draft.agentId} onPress={() => setAgent(a.id)} />
              ))}
            </View>
          )}
          <Problem text={touched ? problems.agentId : null} />
        </View>

        <View style={{ gap: space.sm }}>
          <T variant="eyebrow" muted>
            {t("edit.whenRun")}
          </T>
          {triggerEditable ? (
            <Group>
              {triggers.map((o) => (
                <TriggerOption key={o.type} icon={o.icon} title={TRIGGER_TITLES[o.type]} active={type === o.type} onPress={() => setType(o.type)} />
              ))}
            </Group>
          ) : (
            <Group footer={t("automation.changeTriggerOnComputer")}>
              <View style={styles.row}>
                <Tile icon={type === "webhook" ? "link" : "layers"} />
                <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                  <T variant="callout" style={{ fontWeight: "500" }}>
                    {TRIGGER_TITLES[type]}
                  </T>
                  {routine ? (
                    <T variant="footnote" muted numberOfLines={2}>
                      {triggerText(routine)}
                    </T>
                  ) : null}
                </View>
                <Icon name="lock" size={13} color={c.textFaint} />
              </View>
            </Group>
          )}
        </View>

        {type === "schedule" ? (
          <View style={{ gap: space.md }}>
            <CronBuilder
              value={draft.cron}
              onChange={(cron) => set("cron", cron)}
              startWindowMinutes={draft.startWindow}
              runsPerWindow={draft.runs}
              zone={zone}
              problem={windowProblem}
            />
            <StartWindowField cron={draft.cron} timezone={timezone} value={draft.startWindow} onChange={(m) => setDraft((d) => ({ ...d, startWindow: m, runs: 1 }))} />
            <Group>
              <TimezoneRow title={t("edit.timezone")} value={timezone} onChange={(v) => set("timezone", v)} />
            </Group>
          </View>
        ) : null}

        {type === "app" && admin ? (
          <View style={{ gap: space.lg }}>
            <AppTriggerFields value={draft.app} onChange={(app) => set("app", app)} agent={agent} showProblems={touched} />
            {draft.moreApps.map((m) => (
              <MoreAppEvent
                key={m.key}
                value={m}
                agent={agent}
                showProblems={touched}
                onChange={(app) => setMoreApp(m.key, app)}
                onRemove={() => set("moreApps", draft.moreApps.filter((x) => x.key !== m.key))}
                onResolved={(event) => setMoreResolved((prev) => (JSON.stringify(prev[m.key] ?? null) === JSON.stringify(event) ? prev : { ...prev, [m.key]: event }))}
              />
            ))}
            {draft.app.connectionId && draft.moreApps.length < MAX_MORE_APPS ? (
              <Pressable accessibilityRole="button" onPress={addMoreApp} style={({ pressed }) => [styles.addEvent, pressed && { opacity: 0.6 }]}>
                <Icon name="plus" size={14} color={c.brandStrong} />
                <T variant="subhead" color={c.brandStrong} style={{ fontWeight: "600" }}>
                  {t("edit.addAppEvent")}
                </T>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {type === "condition" ? (
          <View style={{ gap: space.md }}>
            <View style={{ gap: space.sm }}>
              <T variant="eyebrow" muted>
                {t("edit.when")}
              </T>
              <TextInput
                accessibilityLabel={t("automation.condition")}
                value={draft.condition}
                onChangeText={(v) => set("condition", v)}
                placeholder={t("edit.conditionPlaceholder")}
                placeholderTextColor={c.textFaint}
                multiline
                style={[styles.area, { minHeight: 76, color: c.text, backgroundColor: c.surface, borderColor: touched && problems.condition ? c.danger : c.border }]}
              />
              <Problem text={touched ? problems.condition : null} />
              <T variant="footnote" muted>
                {t("edit.conditionHint")}
              </T>
            </View>
            <View style={{ gap: space.sm }}>
              <T variant="eyebrow" muted>
                {t("edit.howOften")}
              </T>
              <CronBuilder value={draft.checkCron} onChange={(cron) => set("checkCron", cron)} zone={zone} />
            </View>
            <Group footer={t("edit.checkModelHint")}>
              <TimezoneRow title={t("edit.timezone")} value={timezone} onChange={(v) => set("timezone", v)} />
              <PickerRow icon="sparkles" title={t("edit.checkModel")} value={checkModel} options={modelOptions} onChange={(v) => set("checkModel", v === AGENT_MODEL ? null : v)} />
            </Group>
          </View>
        ) : null}

        {type === "webhook" && admin ? (
          routine?.trigger.type === "webhook" ? (
            <WebhookPanel routine={routine} />
          ) : (
            <T variant="footnote" muted>
              {editing ? t("edit.webhookAfterSave") : t("edit.webhookAfterCreate")}
            </T>
          )
        ) : null}

        {eventTrigger ? (
          <View style={{ gap: space.sm }}>
            <T variant="eyebrow" muted>
              {t("edit.onlyWhenOptional")}
            </T>
            <TextInput
              accessibilityLabel={t("edit.onlyWhen")}
              value={draft.filter}
              onChangeText={(v) => set("filter", v)}
              placeholder={type === "app" || type === "webhook" ? t(FILTER_PLACEHOLDERS[type]) : undefined}
              placeholderTextColor={c.textFaint}
              multiline
              style={[styles.area, { minHeight: 52, color: c.text, backgroundColor: c.surface, borderColor: c.border }]}
            />
            <T variant="footnote" muted>
              {t("edit.filterHint")}
            </T>
          </View>
        ) : null}

        <View style={{ gap: space.sm }}>
          <T variant="eyebrow" muted>
            {t("edit.whatToDo")}
          </T>
          <TextInput
            accessibilityLabel={t("edit.whatToDo")}
            value={draft.prompt}
            onChangeText={(v) => set("prompt", v)}
            placeholder={t(PROMPT_PLACEHOLDERS[type])}
            placeholderTextColor={c.textFaint}
            multiline
            style={[styles.area, { minHeight: 130, color: c.text, backgroundColor: c.surface, borderColor: touched && problems.prompt ? c.danger : c.border }]}
          />
          <Problem text={touched ? problems.prompt : null} />
        </View>

        <Group footer={t(admin ? NOTIFY_FOOTERS_FULL[draft.notify] : NOTIFY_FOOTERS[draft.notify])}>
          <SwitchRow
            title={t("automation.keepOneChat")}
            detail={eventTrigger ? t("edit.keepOneChatEvent") : t("edit.keepOneChat")}
            value={draft.reuseConversation}
            onChange={(v) => {
              setReuseChosen(true);
              set("reuseConversation", v);
            }}
          />
          <SwitchRow
            title={t("automation.enabled")}
            detail={eventTrigger ? t("automation.enabledHintEvents") : t("automation.enabledHint")}
            value={draft.enabled}
            onChange={(v) => set("enabled", v)}
          />
          <PickerRow title={t("automation.tellMe")} value={draft.notify} options={notifyOptions} onChange={(v) => set("notify", v)} />
        </Group>

        {pinnable ? <RunOnGroup places={places} value={draft.runOn} onChange={(v) => set("runOn", v)} /> : null}

        {canReveal ? (
          <Group footer={t("edit.reveal.footer")}>
            <SwitchRow icon="key" title={t("edit.reveal.title")} value={reveal} onChange={setReveal} />
          </Group>
        ) : null}
      </View>
    </ScrollView>
  );
}

const ANY_DEVICE = "__any";

/** Device groups: the one computer that runs a schedule or check (one with its files and browser profiles). */
function RunOnGroup({ places, value, onChange }: { places: Place[]; value: string | null; onChange: (runOn: string | null) => void }) {
  const { t } = useTranslation("automations");
  const devices = places.map((p) => ({ value: p.runnerId ?? "primary", name: p.name, primary: !p.runnerId, self: p.self, online: p.state === "online" }));
  const picked = value ? devices.find((d) => d.value === value) : null;
  const options: Option<string>[] = [
    { value: ANY_DEVICE, label: t("edit.runOn.any") },
    ...devices.map((d) => ({
      value: d.value,
      label: d.name,
      detail: [d.primary ? t("edit.runOn.primary") : null, d.self ? t("edit.runOn.thisComputer") : null].filter(Boolean).join(", ") || undefined,
    })),
    ...(value && !picked ? [{ value, label: t("edit.runOn.another") }] : []),
  ];
  const footer = !value ? t("edit.runOn.anyHint") : !picked ? t("edit.runOn.unlistedHint") : picked.online ? t("edit.runOn.pickedHint", { name: picked.name }) : t("edit.runOn.pickedOfflineHint", { name: picked.name });
  return (
    <Group footer={footer}>
      <PickerRow icon="laptop" title={t("edit.runOn.label")} value={value ?? ANY_DEVICE} options={options} onChange={(v) => onChange(v === ANY_DEVICE ? null : v)} />
    </Group>
  );
}

/** One more app event of the same automation; it says what it resolves to once its settings are known and valid. */
function MoreAppEvent({
  value,
  agent,
  showProblems,
  onChange,
  onRemove,
  onResolved,
}: {
  value: AppTriggerDraft;
  agent: Agent | undefined;
  showProblems: boolean;
  onChange: (value: AppTriggerDraft) => void;
  onRemove: () => void;
  onResolved: (event: AppTriggerEvent | null) => void;
}) {
  const { t } = useTranslation("automations");
  const schema = useAppTriggerSchema(value);
  const problems = appTriggerProblems(value, schema);
  const invalid = !!problems.connection || !!problems.trigger || !!problems.schema || Object.keys(problems.config).length > 0;
  const signature = invalid
    ? "null"
    : JSON.stringify({
        connectionId: value.connectionId,
        toolkit: value.toolkit,
        triggerSlug: value.triggerSlug,
        triggerName: schema.triggerType?.name ?? value.triggerName,
        config: configValue(schema.fields, value.config),
      });
  useEffect(() => {
    onResolved(JSON.parse(signature) as AppTriggerEvent | null);
    // Only a new signature is news; the callback changes with every render of the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  return <AppTriggerFields title={t("edit.moreAppEvent")} value={value} onChange={onChange} agent={agent} showProblems={showProblems} onRemove={onRemove} />;
}

/** The sheet's bar: Cancel, the title and Save. */
function Header({ title, action, saving, onSave }: { title: string; action?: string; saving?: boolean; onSave?: () => void }) {
  const c = useColors();
  const { t } = useTranslation("common");
  return (
    <View style={[styles.header, { borderBottomColor: c.border, backgroundColor: c.background }]}>
      <Pressable accessibilityRole="button" hitSlop={8} onPress={() => router.back()} style={styles.headerSide}>
        <T variant="callout" color={c.textMuted}>
          {t("actions.cancel")}
        </T>
      </Pressable>
      <T variant="headline" numberOfLines={1} style={{ flex: 1, textAlign: "center" }}>
        {title}
      </T>
      <View style={[styles.headerSide, { alignItems: "flex-end" }]}>
        {action && onSave ? (
          saving ? (
            <ActivityIndicator color={c.textMuted} />
          ) : (
            <Pressable accessibilityRole="button" hitSlop={8} onPress={onSave}>
              <T variant="callout" color={c.brandStrong} style={{ fontWeight: "600" }}>
                {action}
              </T>
            </Pressable>
          )
        ) : null}
      </View>
    </View>
  );
}

function TriggerOption({ icon, title, active, onPress }: { icon: IconName; title: string; active: boolean; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: active }}
      onPress={() => {
        if (active) return;
        tap();
        onPress();
      }}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
    >
      <Tile icon={icon} tint={active ? c.brandStrong : undefined} />
      <T variant="callout" style={{ flex: 1, minWidth: 0, fontWeight: "500" }}>
        {title}
      </T>
      {active ? <Icon name="check" size={15} color={c.brandStrong} weight="bold" /> : null}
    </Pressable>
  );
}

function AgentChip({ agent, active, onPress }: { agent: Agent | undefined; active: boolean; onPress?: () => void }) {
  const c = useColors();
  const { t } = useTranslation("common");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      disabled={!onPress}
      onPress={() => {
        tap();
        onPress?.();
      }}
      style={[styles.chip, { backgroundColor: active ? c.primary : c.sunken }]}
    >
      <CharacterAvatar agent={agent} size={24} />
      <T variant="subhead" color={active ? c.onPrimary : c.text} style={{ fontWeight: "600" }} numberOfLines={1}>
        {agent?.name ?? t("words.agent")}
      </T>
    </Pressable>
  );
}

function Problem({ text }: { text: string | null }) {
  const c = useColors();
  if (!text) return null;
  return (
    <T variant="footnote" color={c.danger}>
      {text}
    </T>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.xl,
    paddingBottom: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerSide: {
    minWidth: 64,
  },
  content: {
    paddingTop: space.lg,
    paddingHorizontal: space.xl,
    paddingBottom: 60,
    gap: space.xl,
  },
  fields: {
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  name: {
    fontSize: 17,
    fontWeight: "600",
    paddingHorizontal: space.lg,
    paddingVertical: 14,
  },
  area: {
    fontSize: 15,
    lineHeight: 20,
    maxHeight: 260,
    paddingHorizontal: space.lg,
    paddingTop: 12,
    paddingBottom: 12,
    textAlignVertical: "top",
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 52,
    paddingHorizontal: space.lg,
    paddingVertical: 11,
  },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.sm,
  },
  addEvent: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    paddingVertical: space.xs,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 36,
    paddingLeft: 8,
    paddingRight: 14,
    borderRadius: radius.pill,
    maxWidth: "100%",
  },
});
