import { router, Stack, useLocalSearchParams } from "expo-router";
import { ActivityIndicator, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  HEARTBEAT_INTERVALS,
  MAX_AGENT_ROLE_LENGTH,
  MAX_HEARTBEAT_CHECKLIST_LENGTH,
  PERSONALITY_PRESETS,
  personalityText,
  findModel,
  heartbeatIntervalLabel,
  type Effort,
} from "@godmode/shared";
import { CharacterAvatar } from "@/components/character";
import { CloseButton } from "@/components/close-button";
import { Group, LinkRow, PickerRow, SegmentRow, SwitchRow, TextEditor } from "@/components/form";
import { Badge, EmptyState, Row, SectionTitle } from "@/components/ui";
import { useEffectiveModel, NO_CHOICE } from "@/lib/composer";
import { useAgents } from "@/lib/hooks";
import { EFFORT_SHORT, patchAgent, useEditable } from "@/lib/setup";
import { space, useColors } from "@/lib/theme";
import { useWorkspace } from "@/lib/workspace";
import { currentLanguage } from "@/lib/i18n";

const DEFAULT = "default";
const NONE = "none";

const HOURS = [
  { value: "any", labelKey: "agent.hours.any", hours: null },
  { value: "9-18", labelKey: "agent.hours.work", hours: { from: 9, to: 18 } },
  { value: "8-22", labelKey: "agent.hours.day", hours: { from: 8, to: 22 } },
  { value: "22-7", labelKey: "agent.hours.night", hours: { from: 22, to: 7 } },
] as const;

export default function AgentSettings() {
  const c = useColors();
  const { t } = useTranslation(["settings", "common"]);
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
        <Stack.Screen options={{ title: t("common:words.agent") }} />
        <CloseButton />
        {isPending ? <ActivityIndicator style={{ marginTop: 80 }} /> : <EmptyState icon="agents" title={t("agent.notFound.title")} body={t("agent.notFound.body")} />}
      </ScrollView>
    );
  }

  const save = (patch: Parameters<typeof patchAgent>[1]) => void patchAgent(agent.id, patch);
  const models = catalog.data?.models ?? [];
  const projects = workspaces.find((w) => w.id === agent.workspaceId)?.projects ?? [];
  const preset = PERSONALITY_PRESETS.find((p) => p.id === agent.personality);
  const personalities = [
    { value: NONE, label: t("agent.personality.none") },
    ...PERSONALITY_PRESETS.map((p) => ({ value: p.id, label: personalityText(p, currentLanguage()).label, detail: personalityText(p, currentLanguage()).blurb })),
    ...(agent.personality && !preset ? [{ value: agent.personality, label: t("agent.personality.custom"), detail: agent.personality }] : []),
  ];
  const hb = agent.heartbeat;
  const hours = HOURS.find((h) => (h.hours === null ? hb.hours === null : hb.hours?.from === h.hours.from && hb.hours?.to === h.hours.to));
  const hourOptions = [
    ...(hours ? [] : [{ value: "custom", label: t("agent.hours.custom", { from: hb.hours?.from, to: hb.hours?.to }) }]),
    ...HOURS.map((h) => ({ value: h.value as string, label: t(h.labelKey) })),
  ];
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
            accessibilityLabel={t("common:words.name")}
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
            accessibilityLabel={t("agent.role")}
            value={role.text}
            onChangeText={role.setText}
            onBlur={() => {
              const next = role.done();
              if (next !== null) save({ role: next });
            }}
            placeholder={t("agent.rolePlaceholder")}
            placeholderTextColor={c.textFaint}
            maxLength={MAX_AGENT_ROLE_LENGTH}
            returnKeyType="done"
            submitBehavior="blurAndSubmit"
            style={[styles.role, { color: c.textMuted }]}
          />
          <Row style={{ gap: 6, marginTop: 4 }}>
            {agent.isDefault ? <Badge label={t("agent.builtIn")} /> : null}
            {!agent.workspaceId ? <Badge label={t("agents.global")} /> : null}
          </Row>
        </View>
      </View>

      {!agent.isDefault ? (
        <Group>
          <SwitchRow icon="power" title={t("agent.active")} detail={agent.enabled ? t("agent.activeOn") : t("agent.activeOff")} value={agent.enabled} onChange={(enabled) => save({ enabled })} />
        </Group>
      ) : null}

      <View>
        <SectionTitle title={t("overview.links.instructions")} />
        <TextEditor
          label={t("agent.instructionsLabel", { name: agent.name })}
          value={agent.instructions}
          placeholder={t("agent.instructionsPlaceholder")}
          maxLength={50_000}
          minHeight={180}
          onSave={(instructions) => patchAgent(agent.id, { instructions }, { quiet: true })}
        />
      </View>

      <View>
        <SectionTitle title={t("agent.about")} />
        <TextEditor
          label={t("agent.descriptionLabel", { name: agent.name })}
          value={agent.description}
          placeholder={t("agent.descriptionPlaceholder")}
          maxLength={2000}
          minHeight={64}
          hint={t("agent.descriptionHint")}
          onSave={(description) => patchAgent(agent.id, { description }, { quiet: true })}
        />
      </View>

      <Group footer={t("agent.memoryFooter")}>
        <LinkRow icon="brain" title={t("overview.links.memory")} detail="MEMORY.md" onPress={() => router.push({ pathname: "/memory/[id]", params: { id: agent.id } })} />
      </Group>

      <Group title={t("agent.personality.title")}>
        <PickerRow
          icon="sparkles"
          title={t("agent.personality.tone")}
          detail={preset ? personalityText(preset, currentLanguage()).blurb : undefined}
          value={agent.personality || NONE}
          options={personalities}
          onChange={(v) => save({ personality: v === NONE ? "" : v })}
        />
      </Group>

      <Group title={t("agent.thinking.title")} footer={t("agent.thinking.footer")}>
        <PickerRow
          icon="cpu"
          title={t("ai.defaultModel.model")}
          value={agent.model ? (findModel(models, agent.model)?.id ?? agent.model) : DEFAULT}
          options={[
            { value: DEFAULT, label: t("agent.thinking.default") },
            ...(agent.model && !findModel(models, agent.model) ? [{ value: agent.model, label: agent.model }] : []),
            ...models.map((m) => ({ value: m.id, label: m.provider ? t("agent.thinking.special", { model: m.label }) : m.label, detail: m.description })),
          ]}
          onChange={(v) => save({ model: v === DEFAULT ? "" : v })}
        />
        {efforts.length ? (
          <SegmentRow
            title={t("ai.defaultModel.effort")}
            value={agent.effort ?? DEFAULT}
            options={[{ value: DEFAULT, label: t("agent.thinking.default") }, ...efforts.map((e) => ({ value: e, label: EFFORT_SHORT[e] }))]}
            onChange={(v) => save({ effort: v === DEFAULT ? null : (v as Effort) })}
          />
        ) : null}
        {current.ultracode ? (
          <PickerRow
            icon="workflow"
            title="Ultracode"
            value={agent.ultracode === null ? DEFAULT : agent.ultracode ? "on" : "off"}
            options={[
              { value: DEFAULT, label: t("agent.thinking.default") },
              { value: "on", label: t("common:status.on") },
              { value: "off", label: t("common:status.off") },
            ]}
            onChange={(v) => save({ ultracode: v === DEFAULT ? null : v === "on" })}
          />
        ) : null}
        {projects.length ? (
          <PickerRow
            icon="folder"
            title={t("agent.project")}
            value={agent.projectId ?? NONE}
            options={[{ value: NONE, label: t("common:status.none") }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
            onChange={(v) => save({ projectId: v === NONE ? null : v })}
          />
        ) : null}
      </Group>

      <Group title={t("agents.heartbeat")} footer={t("agent.heartbeat.footer")}>
        <SwitchRow icon="pulse" title={t("agents.heartbeat")} value={hb.enabled} onChange={(enabled) => save({ heartbeat: { enabled } })} />
        <PickerRow
          icon="clock"
          title={t("agent.heartbeat.every")}
          value={String(hb.intervalMinutes)}
          options={HEARTBEAT_INTERVALS.map((m) => ({ value: String(m), label: heartbeatIntervalLabel(m, currentLanguage()) }))}
          onChange={(v) => save({ heartbeat: { intervalMinutes: Number(v) } })}
        />
        <PickerRow
          icon="moon"
          title={t("memory.dreaming.when")}
          value={hours?.value ?? "custom"}
          options={hourOptions}
          onChange={(v) => {
            const next = HOURS.find((h) => h.value === v);
            if (next) save({ heartbeat: { hours: next.hours ? { ...next.hours } : null } });
          }}
        />
        <SwitchRow icon="tasks" title={t("agent.heartbeat.weekdays")} value={hb.weekdays} onChange={(weekdays) => save({ heartbeat: { weekdays } })} />
      </Group>

      {hb.enabled ? (
        <View>
          <SectionTitle title={t("agent.heartbeat.checklist")} />
          <TextEditor
            label={t("agent.heartbeat.checklistLabel")}
            value={hb.checklist}
            placeholder={t("agent.heartbeat.checklistPlaceholder")}
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
