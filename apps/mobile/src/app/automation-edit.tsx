import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import {
  cronToHuman,
  DEFAULT_CRON,
  validateCron,
  type Agent,
  type Routine,
  type RoutineInput,
  type RoutineNotify,
  type RoutineTrigger,
  type RoutineTriggerType,
} from "@godmode/shared";
import { CharacterAvatar } from "@/components/character";
import { CronBuilder, StartWindowField, startWindowProblem } from "@/components/cron-builder";
import { Group, PickerRow, SwitchRow, Tile, type Option } from "@/components/form";
import { Icon, type IconName } from "@/components/icon";
import { phoneTimezone, triggerText, TRIGGER_TITLES } from "@/components/routine-row";
import { ErrorState, LoadingState, T, tap } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { qk, queryClient } from "@/lib/query";
import { radius, space, useColors } from "@/lib/theme";

type PhoneTrigger = "schedule" | "condition";

/** Conditions are checked hourly unless the human picks otherwise. */
const DEFAULT_CHECK_CRON = "0 * * * *";
const CHECK_EVERY = ["*/5 * * * *", "*/15 * * * *", "*/30 * * * *", "0 * * * *", "0 9 * * *"];

const NAME_PLACEHOLDERS: Record<RoutineTriggerType, string> = {
  schedule: "Weekly numbers report",
  app: "Invoice emails to Drive",
  condition: "Competitor pricing watch",
  webhook: "Abandoned checkout recovery",
};

const PROMPT_PLACEHOLDERS: Record<RoutineTriggerType, string> = {
  schedule: "Collect last week's numbers from Stripe and Google Analytics, write a short report and send it to me.",
  app: "Save the invoice PDF to Drive and log sender, amount and due date in my Invoices sheet. The event details are passed along.",
  condition: "Compare their new plans with ours and update the pricing battlecard in Notion. What the check found is passed along.",
  webhook: "Check whether the order qualifies for a recovery offer and draft a friendly email. The request body is passed along.",
};

const FILTER_PLACEHOLDERS: Partial<Record<RoutineTriggerType, string>> = {
  app: "the sender is a customer, or the subject mentions an invoice",
  webhook: "the order total is over $100",
};

const TRIGGER_OPTIONS: { type: PhoneTrigger; icon: IconName; hint: string }[] = [
  { type: "schedule", icon: "clock", hint: "Every morning, each Monday, on the 1st…" },
  { type: "condition", icon: "eye", hint: "Checked regularly, in plain language" },
];

const NOTIFY_OPTIONS: Option<RoutineNotify>[] = [
  { value: "failures", label: "When a run fails" },
  { value: "always", label: "After every run" },
  { value: "never", label: "Never" },
];

const NOTIFY_HINTS: Record<RoutineNotify, string> = {
  never: "No notifications. A failing automation still shows under Needs you.",
  always: "A notification after every run, with what it did.",
  failures: "A failure is told once, until a run works again.",
};

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
  /** App/webhook triggers: only act on matching events. */
  filter: string;
  prompt: string;
  enabled: boolean;
  reuseConversation: boolean;
  notify: RoutineNotify;
}

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
    filter: routine?.filter ?? "",
    prompt: routine?.prompt ?? "",
    enabled: routine?.enabled ?? true,
    reuseConversation: routine?.reuseConversation ?? true,
    notify: routine?.notify ?? "failures",
  };
}

/** Create (`agentId` preselects the agent) or edit (`id`) an automation that runs on a schedule or when a condition is met. */
export default function AutomationEdit() {
  const { id, agentId } = useLocalSearchParams<{ id?: string; agentId?: string }>();
  const list = useQuery({ queryKey: qk.allRoutines, queryFn: () => api.routines.list(), enabled: !!id });
  const agents = useAgents();
  const routine = id ? list.data?.find((r) => r.id === id) : undefined;

  if ((id && !routine) || !agents.data) {
    const loading = (!!id && list.isLoading) || agents.isLoading;
    const error = id && list.isError ? list.error : agents.isError ? agents.error : null;
    return (
      <View style={{ flex: 1 }}>
        <Header title={id ? "Edit automation" : "New automation"} />
        <View style={{ flex: 1, justifyContent: "center" }}>
          {loading ? (
            <LoadingState />
          ) : (
            <ErrorState
              title={error ? "Couldn't load the automation" : "Automation not found"}
              error={error ? errorText(error) : "It may have been deleted."}
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
  const editing = !!routine;
  const [draft, setDraft] = useState(() => initialDraft(routine, defaultAgentId));
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const type = draft.triggerType;
  // App and webhook triggers need connections and secret URLs that live on the computer.
  const phoneTrigger = type === "schedule" || type === "condition";
  const eventTrigger = !phoneTrigger;
  const timezone = routine?.timezone || phoneTimezone() || "UTC";
  const zone = timezone !== phoneTimezone() ? timezone.replace(/_/g, " ") : null;
  const windowProblem = type === "schedule" ? startWindowProblem(draft.cron, draft.startWindow) : null;
  const cronError = type === "schedule" ? (validateCron(draft.cron) ?? windowProblem) : type === "condition" ? validateCron(draft.checkCron) : null;
  const problems = {
    agentId: !draft.agentId ? "Pick an agent" : null,
    name: !draft.name.trim() ? "Name your automation" : null,
    condition: type === "condition" && !draft.condition.trim() ? "Describe what to watch for" : null,
    prompt: !draft.prompt.trim() ? (eventTrigger ? "Tell the agent what to do with each event" : "Tell the agent what to do each time") : null,
  };
  const firstProblem = Object.values(problems).find(Boolean) ?? cronError;
  const choosable = agents.filter((a) => a.enabled || a.id === draft.agentId);
  const agent = agents.find((a) => a.id === draft.agentId);
  const checkOptions: Option<string>[] = [...new Set([...CHECK_EVERY, draft.checkCron])].map((cron) => ({ value: cron, label: cronToHuman(cron) }));

  const buildTrigger = (): RoutineTrigger => {
    if (type === "condition") {
      const before = routine?.trigger.type === "condition" ? routine.trigger.checkModel : null;
      return { type: "condition", condition: draft.condition.trim(), checkModel: before };
    }
    if (!draft.startWindow) return { type: "schedule" };
    return draft.runs > 1
      ? { type: "schedule", startWindowMinutes: draft.startWindow, runsPerWindow: draft.runs }
      : { type: "schedule", startWindowMinutes: draft.startWindow };
  };

  const save = async () => {
    setTouched(true);
    if (saving) return;
    if (firstProblem) {
      Alert.alert(editing ? "Couldn't update automation" : "Couldn't create automation", firstProblem);
      return;
    }
    const common = {
      name: draft.name.trim(),
      prompt: draft.prompt.trim(),
      enabled: draft.enabled,
      reuseConversation: draft.reuseConversation,
      notify: draft.notify,
    };
    // An app or webhook trigger is never sent from the phone: only what it does and how it reports changes.
    const input: Partial<RoutineInput> = phoneTrigger
      ? { ...common, trigger: buildTrigger(), cron: (type === "schedule" ? draft.cron : draft.checkCron).trim(), timezone, filter: "" }
      : { ...common, filter: draft.filter.trim() };
    setSaving(true);
    try {
      if (routine) await api.routines.update(routine.id, input);
      else await api.routines.create({ ...input, agentId: draft.agentId } as RoutineInput);
      void queryClient.invalidateQueries({ queryKey: qk.routines });
      tap();
      router.back();
    } catch (err) {
      Alert.alert(editing ? "Couldn't update automation" : "Couldn't create automation", errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <Header title={editing ? "Edit automation" : "New automation"} action={editing ? "Save" : "Create"} saving={saving} onSave={() => void save()} />
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        automaticallyAdjustKeyboardInsets
      >
        <T variant="subhead" muted>
          When it happens, the agent gets to work — even while you&apos;re away.
        </T>

        <View style={{ gap: space.sm }}>
          <View style={[styles.fields, { backgroundColor: c.surface, borderColor: touched && problems.name ? c.danger : c.border }]}>
            <TextInput
              accessibilityLabel="Name"
              value={draft.name}
              onChangeText={(v) => set("name", v)}
              placeholder={NAME_PLACEHOLDERS[type]}
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
            Agent
          </T>
          {editing ? (
            <View style={styles.chips}>
              <AgentChip agent={agent} active />
            </View>
          ) : (
            <View style={styles.chips}>
              {choosable.map((a) => (
                <AgentChip key={a.id} agent={a} active={a.id === draft.agentId} onPress={() => set("agentId", a.id)} />
              ))}
            </View>
          )}
          <Problem text={touched ? problems.agentId : null} />
        </View>

        <View style={{ gap: space.sm }}>
          <T variant="eyebrow" muted>
            When should it run?
          </T>
          {phoneTrigger ? (
            <Group>
              {TRIGGER_OPTIONS.map((o) => (
                <TriggerOption key={o.type} icon={o.icon} title={TRIGGER_TITLES[o.type]} hint={o.hint} active={type === o.type} onPress={() => set("triggerType", o.type)} />
              ))}
            </Group>
          ) : (
            <Group footer="Change the trigger in Godmode on your computer.">
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
            <StartWindowField cron={draft.cron} value={draft.startWindow} onChange={(m) => setDraft((d) => ({ ...d, startWindow: m, runs: 1 }))} />
          </View>
        ) : null}

        {type === "condition" ? (
          <View style={{ gap: space.md }}>
            <View style={{ gap: space.sm }}>
              <T variant="eyebrow" muted>
                When…
              </T>
              <TextInput
                accessibilityLabel="Condition"
                value={draft.condition}
                onChangeText={(v) => set("condition", v)}
                placeholder="a competitor changes the price of their Pro plan (acme.com/pricing)"
                placeholderTextColor={c.textFaint}
                multiline
                style={[styles.area, { minHeight: 76, color: c.text, backgroundColor: c.surface, borderColor: touched && problems.condition ? c.danger : c.border }]}
              />
              <Problem text={touched ? problems.condition : null} />
              <T variant="footnote" muted>
                In plain language. The agent checks it on the schedule below and gets to work once it&apos;s true.
              </T>
            </View>
            <Group footer={zone ? `Checked in ${zone} time.` : undefined}>
              <PickerRow title="How often to check" value={draft.checkCron} options={checkOptions} onChange={(cron) => set("checkCron", cron)} />
            </Group>
          </View>
        ) : null}

        {eventTrigger ? (
          <View style={{ gap: space.sm }}>
            <T variant="eyebrow" muted>
              Only when… (optional)
            </T>
            <TextInput
              accessibilityLabel="Only when"
              value={draft.filter}
              onChangeText={(v) => set("filter", v)}
              placeholder={FILTER_PLACEHOLDERS[type]}
              placeholderTextColor={c.textFaint}
              multiline
              style={[styles.area, { minHeight: 52, color: c.text, backgroundColor: c.surface, borderColor: c.border }]}
            />
            <T variant="footnote" muted>
              In plain language. Events that don&apos;t match are skipped; leave empty to act on every event.
            </T>
          </View>
        ) : null}

        <View style={{ gap: space.sm }}>
          <T variant="eyebrow" muted>
            What should it do?
          </T>
          <TextInput
            accessibilityLabel="What should it do?"
            value={draft.prompt}
            onChangeText={(v) => set("prompt", v)}
            placeholder={PROMPT_PLACEHOLDERS[type]}
            placeholderTextColor={c.textFaint}
            multiline
            style={[styles.area, { minHeight: 130, color: c.text, backgroundColor: c.surface, borderColor: touched && problems.prompt ? c.danger : c.border }]}
          />
          <Problem text={touched ? problems.prompt : null} />
        </View>

        <Group footer={NOTIFY_HINTS[draft.notify]}>
          <SwitchRow
            title="Keep one chat"
            detail={
              eventTrigger
                ? "Every event continues the same chat. Off: each event gets its own chat, named after it."
                : "Every run continues the same chat, so it remembers previous runs."
            }
            value={draft.reuseConversation}
            onChange={(v) => set("reuseConversation", v)}
          />
          <SwitchRow
            title="Enabled"
            detail={eventTrigger ? "Paused automations keep their settings and ignore new events." : "Paused automations keep their settings but don't run."}
            value={draft.enabled}
            onChange={(v) => set("enabled", v)}
          />
          <PickerRow title="Tell me" value={draft.notify} options={NOTIFY_OPTIONS} onChange={(v) => set("notify", v)} />
        </Group>
      </ScrollView>
    </View>
  );
}

/** The sheet's bar: Cancel, the title and Save. */
function Header({ title, action, saving, onSave }: { title: string; action?: string; saving?: boolean; onSave?: () => void }) {
  const c = useColors();
  return (
    <View style={[styles.header, { borderBottomColor: c.border }]}>
      <Pressable accessibilityRole="button" hitSlop={8} onPress={() => router.back()} style={styles.headerSide}>
        <T variant="callout" color={c.textMuted}>
          Cancel
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

function TriggerOption({ icon, title, hint, active, onPress }: { icon: IconName; title: string; hint: string; active: boolean; onPress: () => void }) {
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
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <T variant="callout" style={{ fontWeight: "500" }}>
          {title}
        </T>
        <T variant="footnote" muted>
          {hint}
        </T>
      </View>
      {active ? <Icon name="check" size={15} color={c.brandStrong} weight="bold" /> : null}
    </Pressable>
  );
}

function AgentChip({ agent, active, onPress }: { agent: Agent | undefined; active: boolean; onPress?: () => void }) {
  const c = useColors();
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
        {agent?.name ?? "Agent"}
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
