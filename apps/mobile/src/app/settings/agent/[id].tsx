import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  HEARTBEAT_INTERVALS,
  MAX_AGENT_ROLE_LENGTH,
  MAX_HEARTBEAT_CHECKLIST_LENGTH,
  PERSONALITY_PRESETS,
  personalityPreset,
  personalityText,
  findModel,
  heartbeatIntervalLabel,
  type Agent,
  type Effort,
} from "@godmode/shared";
import { useLeaveSettings } from "@/components/agent-actions";
import { AgentAccess, AgentTeam } from "@/components/agent-setup";
import { CharacterAvatar } from "@/components/character";
import { CloseButton } from "@/components/close-button";
import { useFullAccess } from "@/components/full-access";
import { Group, LinkRow, PickerRow, SegmentRow, StepperRow, SwitchRow, TextEditor } from "@/components/form";
import { hourLabel } from "@/components/heartbeat-card";
import { Icon } from "@/components/icon";
import { InheritedInstructions } from "@/components/inherited-instructions";
import { Badge, EmptyState, Row, SectionTitle, tap } from "@/components/ui";
import { useEffectiveModel, NO_CHOICE } from "@/lib/composer";
import { useAgents } from "@/lib/hooks";
import { EFFORT_SHORT, patchAgent, useEditable } from "@/lib/setup";
import { space, useColors } from "@/lib/theme";
import { useWorkspace } from "@/lib/workspace";
import { currentLanguage } from "@/lib/i18n";

const DEFAULT = "default";
const NONE = "none";
const CUSTOM = "custom";
const MAX_CUSTOM_PERSONALITY = 600;

const WORKING_HOURS = { from: 8, to: 18 };
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

export default function AgentSettings() {
  const leave = useLeaveSettings();
  const c = useColors();
  const { t } = useTranslation(["settings", "common", "agents"]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const { byId, isPending } = useAgents();
  const { workspaces } = useWorkspace();
  const agent = byId.get(id);
  const { catalog, current } = useEffectiveModel(agent, NO_CHOICE);
  const name = useEditable(agent?.name ?? "");
  const role = useEditable(agent?.role ?? "");
  // An agent that reads raw secrets keeps what it is told as the computer wrote it, unless this phone has full access.
  const fullAccess = useFullAccess().fullAccess;
  const locked = fullAccess === false && agent?.permissions.secretAccess === "reveal";
  const { t: tc } = useTranslation("components");
  const lockedHint = locked ? tc("fullAccess.title") : undefined;

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
  const hb = agent.heartbeat;
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
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("agents:actions.look")}
          onPress={() => {
            tap();
            router.push({ pathname: "/settings/look/[id]", params: { id: agent.id } });
          }}
          style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
        >
          <CharacterAvatar agent={agent} size={72} />
          <View style={[styles.edit, { backgroundColor: c.surface, borderColor: c.border }]}>
            <Icon name="palette" size={12} color={c.text} />
          </View>
        </Pressable>
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
          <SwitchRow icon="power" title={t("agent.active")} value={agent.enabled} onChange={(enabled) => save({ enabled })} />
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
          readOnly={locked}
          hint={lockedHint}
          onSave={(instructions) => patchAgent(agent.id, { instructions }, { quiet: true })}
        />
        <InheritedInstructions workspaceId={agent.workspaceId} />
      </View>

      <View>
        <SectionTitle title={t("agent.about")} />
        <TextEditor
          label={t("agent.descriptionLabel", { name: agent.name })}
          value={agent.description}
          placeholder={t("agent.descriptionPlaceholder")}
          maxLength={2000}
          minHeight={64}
          readOnly={locked}
          hint={lockedHint}
          onSave={(description) => patchAgent(agent.id, { description }, { quiet: true })}
        />
      </View>

      <Group>
        <LinkRow icon="brain" title={t("overview.links.memory")} detail="MEMORY.md" onPress={() => leave(() => router.push({ pathname: "/memory/[id]", params: { id: agent.id } }))} />
      </Group>

      <PersonalityGroup agent={agent} locked={locked} hint={lockedHint} />

      <AgentTeam agent={agent} />

      <Group title={t("agent.thinking.title")}>
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

      <Group title={t("agents.heartbeat")}>
        <SwitchRow icon="pulse" title={t("agents.heartbeat")} value={hb.enabled} onChange={(enabled) => save({ heartbeat: { enabled } })} />
        <PickerRow
          icon="clock"
          title={t("agent.heartbeat.every")}
          value={String(hb.intervalMinutes)}
          options={HEARTBEAT_INTERVALS.map((m) => ({ value: String(m), label: heartbeatIntervalLabel(m, currentLanguage()) }))}
          onChange={(v) => save({ heartbeat: { intervalMinutes: Number(v) } })}
        />
        <SegmentRow
          title={t("memory.dreaming.when")}
          value={hb.hours ? "hours" : "any"}
          options={[
            { value: "any", label: t("agent.hours.any") },
            { value: "hours", label: t("agent.hours.working") },
          ]}
          onChange={(v) => save({ heartbeat: { hours: v === "hours" ? WORKING_HOURS : null } })}
        />
        {hb.hours ? (
          <StepperRow
            title={t("agent.hours.from")}
            value={hb.hours.from}
            min={0}
            max={23}
            steps={range(0, 23).filter((h) => h !== hb.hours!.to % 24)}
            format={hourLabel}
            onChange={(from) => save({ heartbeat: { hours: { ...hb.hours!, from } } })}
          />
        ) : null}
        {hb.hours ? (
          <StepperRow
            title={t("agent.hours.to")}
            value={hb.hours.to}
            min={1}
            max={24}
            steps={range(1, 24).filter((h) => h % 24 !== hb.hours!.from)}
            format={hourLabel}
            onChange={(to) => save({ heartbeat: { hours: { ...hb.hours!, to } } })}
          />
        ) : null}
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
            readOnly={locked}
            hint={lockedHint}
            onSave={(checklist) => patchAgent(agent.id, { heartbeat: { checklist } }, { quiet: true })}
          />
        </View>
      ) : null}

      <AgentAccess agent={agent} />
    </ScrollView>
  );
}

/** How the agent talks: a preset voice, none, or the human's own words (desktop: PersonalityPicker). */
function PersonalityGroup({ agent, locked, hint }: { agent: Agent; locked: boolean; hint?: string }) {
  const { t } = useTranslation("settings");
  const language = currentLanguage();
  const value = agent.personality ?? "";
  const preset = personalityPreset(value);
  const written = !!value.trim() && !preset;
  const [picked, setPicked] = useState(written);
  const last = useRef(written ? value : "");
  // Text still waiting to save must not win over the voice just picked instead.
  const left = useRef(false);
  useEffect(() => {
    if (written) last.current = value;
  }, [written, value]);
  const custom = picked || written;
  const save = (personality: string) => void patchAgent(agent.id, { personality });
  const options = [
    { value: NONE, label: t("agent.personality.none") },
    ...PERSONALITY_PRESETS.map((p) => ({ value: p.id as string, label: personalityText(p, language).label, detail: personalityText(p, language).blurb })),
    // Text an agent that reads raw secrets follows stays as the computer wrote it.
    ...(locked && !custom ? [] : [{ value: CUSTOM, label: t("agent.personality.custom"), detail: t("agent.personality.customDetail") }]),
  ];
  return (
    <View style={{ gap: space.sm }}>
      <Group title={t("agent.personality.title")}>
        <PickerRow
          icon="sparkles"
          title={t("agent.personality.tone")}
          detail={preset ? personalityText(preset, language).blurb : undefined}
          value={custom ? CUSTOM : value || NONE}
          options={options}
          onChange={(v) => {
            left.current = v !== CUSTOM;
            setPicked(v === CUSTOM);
            save(v === CUSTOM ? last.current : v === NONE ? "" : v);
          }}
        />
      </Group>
      {custom ? (
        <TextEditor
          label={t("agent.personality.customLabel")}
          value={written ? value : ""}
          placeholder={t("agent.personality.customPlaceholder")}
          maxLength={MAX_CUSTOM_PERSONALITY}
          minHeight={84}
          readOnly={locked}
          hint={hint}
          onSave={async (personality) => left.current || (await patchAgent(agent.id, { personality }, { quiet: true }))}
        />
      ) : null}
    </View>
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
  edit: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
});
