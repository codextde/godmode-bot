import { Stack, useLocalSearchParams } from "expo-router";
import { ActivityIndicator, ScrollView, StyleSheet, TextInput, View } from "react-native";
import {
  HEARTBEAT_INTERVALS,
  MAX_AGENT_ROLE_LENGTH,
  MAX_HEARTBEAT_CHECKLIST_LENGTH,
  PERSONALITY_PRESETS,
  findModel,
  heartbeatIntervalLabel,
  type Effort,
} from "@godmode/shared";
import { CharacterAvatar } from "@/components/character";
import { CloseButton } from "@/components/close-button";
import { Group, PickerRow, SegmentRow, SwitchRow, TextEditor } from "@/components/form";
import { Badge, EmptyState, Row, SectionTitle } from "@/components/ui";
import { useEffectiveModel, NO_CHOICE } from "@/lib/composer";
import { useAgents } from "@/lib/hooks";
import { EFFORT_SHORT, patchAgent, useEditable } from "@/lib/setup";
import { space, useColors } from "@/lib/theme";
import { useWorkspace } from "@/lib/workspace";

const DEFAULT = "default";
const NONE = "none";

const HOURS = [
  { value: "any", label: "Any time", hours: null },
  { value: "9-18", label: "Working hours, 9 to 18", hours: { from: 9, to: 18 } },
  { value: "8-22", label: "Daytime, 8 to 22", hours: { from: 8, to: 22 } },
  { value: "22-7", label: "At night, 22 to 7", hours: { from: 22, to: 7 } },
] as const;

export default function AgentSettings() {
  const c = useColors();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { byId, isPending } = useAgents();
  const { workspaces } = useWorkspace();
  const agent = byId.get(id);
  const { catalog, current } = useEffectiveModel(agent, NO_CHOICE);
  const name = useEditable(agent?.name ?? "");
  const role = useEditable(agent?.role ?? "");

  if (!agent) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic">
        <Stack.Screen options={{ title: "Agent" }} />
        <CloseButton />
        {isPending ? <ActivityIndicator style={{ marginTop: 80 }} /> : <EmptyState icon="agents" title="Agent not found" body="It may have been deleted on your computer." />}
      </ScrollView>
    );
  }

  const save = (patch: Parameters<typeof patchAgent>[1]) => void patchAgent(agent.id, patch);
  const models = catalog.data?.models ?? [];
  const projects = workspaces.find((w) => w.id === agent.workspaceId)?.projects ?? [];
  const preset = PERSONALITY_PRESETS.find((p) => p.id === agent.personality);
  const personalities = [
    { value: NONE, label: "No particular tone" },
    ...PERSONALITY_PRESETS.map((p) => ({ value: p.id, label: p.label, detail: p.blurb })),
    ...(agent.personality && !preset ? [{ value: agent.personality, label: "Custom", detail: agent.personality }] : []),
  ];
  const hb = agent.heartbeat;
  const hours = HOURS.find((h) => (h.hours === null ? hb.hours === null : hb.hours?.from === h.hours.from && hb.hours?.to === h.hours.to));
  const hourOptions = hours ? HOURS : [{ value: "custom", label: `${hb.hours?.from} to ${hb.hours?.to}`, hours: hb.hours }, ...HOURS];
  const efforts = current.efforts;

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={styles.content}
    >
      <Stack.Screen options={{ title: agent.name, headerLargeTitleEnabled: false }} />
      <CloseButton />

      <View style={styles.hero}>
        <CharacterAvatar agent={agent} size={72} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <TextInput
            accessibilityLabel="Name"
            value={name.text}
            onChangeText={name.setText}
            onBlur={() => {
              const next = name.done();
              if (next) save({ name: next });
            }}
            maxLength={80}
            returnKeyType="done"
            submitBehavior="blurAndSubmit"
            style={[styles.name, { color: c.text }]}
          />
          <TextInput
            accessibilityLabel="Role"
            value={role.text}
            onChangeText={role.setText}
            onBlur={() => {
              const next = role.done();
              if (next !== null) save({ role: next });
            }}
            placeholder="Add a role, like Bookkeeper"
            placeholderTextColor={c.textFaint}
            maxLength={MAX_AGENT_ROLE_LENGTH}
            returnKeyType="done"
            submitBehavior="blurAndSubmit"
            style={[styles.role, { color: c.textMuted }]}
          />
          <Row style={{ gap: 6, marginTop: 4 }}>
            {agent.isDefault ? <Badge label="Main assistant" /> : null}
            {!agent.workspaceId ? <Badge label="Everywhere" /> : null}
          </Row>
        </View>
      </View>

      {!agent.isDefault ? (
        <Group>
          <SwitchRow icon="power" title="Active" detail={agent.enabled ? "Takes chats, tasks and automations." : "Does nothing until you switch it on."} value={agent.enabled} onChange={(enabled) => save({ enabled })} />
        </Group>
      ) : null}

      <View>
        <SectionTitle title="Instructions" />
        <TextEditor
          label={`Instructions for ${agent.name}`}
          value={agent.instructions}
          placeholder={"What it does, how, and when it asks you.\nFor example: Check my inbox every morning and draft replies to customers."}
          maxLength={50_000}
          minHeight={180}
          onSave={(instructions) => patchAgent(agent.id, { instructions }, { quiet: true })}
        />
      </View>

      <View>
        <SectionTitle title="About" />
        <TextEditor
          label={`Description of ${agent.name}`}
          value={agent.description}
          placeholder="One or two lines your other agents see when they hand work over."
          maxLength={2000}
          minHeight={64}
          hint="Teammates see this"
          onSave={(description) => patchAgent(agent.id, { description }, { quiet: true })}
        />
      </View>

      <Group title="Personality">
        <PickerRow
          icon="sparkles"
          title="Tone"
          detail={preset?.blurb}
          value={agent.personality || NONE}
          options={personalities}
          onChange={(v) => save({ personality: v === NONE ? "" : v })}
        />
      </Group>

      <Group title="Thinking" footer="Default follows Model & limits in Settings.">
        <PickerRow
          icon="cpu"
          title="Model"
          value={agent.model ? (findModel(models, agent.model)?.id ?? agent.model) : DEFAULT}
          options={[
            { value: DEFAULT, label: "Default" },
            ...(agent.model && !findModel(models, agent.model) ? [{ value: agent.model, label: agent.model }] : []),
            ...models.map((m) => ({ value: m.id, label: m.label, detail: m.description })),
          ]}
          onChange={(v) => save({ model: v === DEFAULT ? "" : v })}
        />
        {efforts.length ? (
          <SegmentRow
            title="Effort"
            value={agent.effort ?? DEFAULT}
            options={[{ value: DEFAULT, label: "Default" }, ...efforts.map((e) => ({ value: e, label: EFFORT_SHORT[e] }))]}
            onChange={(v) => save({ effort: v === DEFAULT ? null : (v as Effort) })}
          />
        ) : null}
        {current.ultracode ? (
          <PickerRow
            icon="workflow"
            title="Ultracode"
            value={agent.ultracode === null ? DEFAULT : agent.ultracode ? "on" : "off"}
            options={[
              { value: DEFAULT, label: "Default" },
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ]}
            onChange={(v) => save({ ultracode: v === DEFAULT ? null : v === "on" })}
          />
        ) : null}
        {projects.length ? (
          <PickerRow
            icon="folder"
            title="Project"
            value={agent.projectId ?? NONE}
            options={[{ value: NONE, label: "None" }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
            onChange={(v) => save({ projectId: v === NONE ? null : v })}
          />
        ) : null}
      </Group>

      <Group title="Heartbeat" footer="Wakes up on its own to move its tickets forward and work through its checklist.">
        <SwitchRow icon="pulse" title="Heartbeat" value={hb.enabled} onChange={(enabled) => save({ heartbeat: { enabled } })} />
        <PickerRow
          icon="clock"
          title="Every"
          value={String(hb.intervalMinutes)}
          options={HEARTBEAT_INTERVALS.map((m) => ({ value: String(m), label: heartbeatIntervalLabel(m) }))}
          onChange={(v) => save({ heartbeat: { intervalMinutes: Number(v) } })}
        />
        <PickerRow
          icon="moon"
          title="When"
          value={hours?.value ?? "custom"}
          options={hourOptions.map(({ value, label }) => ({ value, label }))}
          onChange={(v) => {
            const next = HOURS.find((h) => h.value === v);
            if (next) save({ heartbeat: { hours: next.hours ? { ...next.hours } : null } });
          }}
        />
        <SwitchRow icon="tasks" title="Weekdays only" value={hb.weekdays} onChange={(weekdays) => save({ heartbeat: { weekdays } })} />
      </Group>

      {hb.enabled ? (
        <View>
          <SectionTitle title="Checklist" />
          <TextEditor
            label="Heartbeat checklist"
            value={hb.checklist}
            placeholder={"Standing duties for every beat.\nFor example: Check Stripe for unpaid orders."}
            maxLength={MAX_HEARTBEAT_CHECKLIST_LENGTH}
            minHeight={100}
            onSave={(checklist) => patchAgent(agent.id, { heartbeat: { checklist } }, { quiet: true })}
          />
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
  hero: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.lg,
  },
  name: {
    fontSize: 24,
    fontWeight: "700",
    letterSpacing: -0.5,
    paddingVertical: 2,
  },
  role: {
    fontSize: 15,
    paddingVertical: 2,
  },
});
