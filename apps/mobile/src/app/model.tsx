import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Switch, View } from "react-native";
import { useTranslation } from "react-i18next";
import { effortLabel, ULTRACODE_HINT, ULTRACODE_HINT_DE, type ClaudeModel, type ConversationWithMessages, type Effort } from "@godmode/shared";
import { Icon } from "@/components/icon";
import { Card, Hairline, T, tap } from "@/components/ui";
import { api, errorText, type ModelChoicePatch } from "@/lib/api";
import { fetchConversation } from "@/lib/chat-cache";
import { NO_CHOICE, useEffectiveModel, useNewChatChoice, type ModelChoice } from "@/lib/composer";
import { useAgents } from "@/lib/hooks";
import { qk, queryClient } from "@/lib/query";
import { radius, space, useColors } from "@/lib/theme";
import { currentLanguage } from "@/lib/i18n";

/** The model and effort of a chat (or of the next new chat): applies right away, like the picker on the computer. */
export default function ModelSheet() {
  const c = useColors();
  const { t } = useTranslation("settings");
  const { conversationId, agentId } = useLocalSearchParams<{ conversationId?: string; agentId?: string }>();
  const { byId } = useAgents();
  const conversation = useQuery({
    queryKey: qk.conversation(conversationId ?? ""),
    queryFn: () => fetchConversation(conversationId!),
    enabled: !!conversationId,
    // The chat it was opened from has it: the sheet only reads the model from it.
    staleTime: Infinity,
  });
  const newChoice = useNewChatChoice((s) => s.choice);
  const agent = byId.get(conversation.data?.agentId ?? agentId ?? "");
  const choice: ModelChoice = conversationId
    ? { model: conversation.data?.model ?? null, effort: conversation.data?.effort ?? null, ultracode: conversation.data?.ultracode ?? null }
    : newChoice;
  const { catalog, base, baseEffort, baseUltracode, anyUltracode, current, effort, ultracode } = useEffectiveModel(agent, choice);
  const [showOlder, setShowOlder] = useState(!current.latest);

  const models = catalog.data?.models ?? [];
  const listed = models.some((m) => m.id === current.id) ? models : [current, ...models];
  const latest = listed.filter((m) => m.latest && !m.provider);
  const older = listed.filter((m) => !m.latest && !m.provider);
  const special = listed.filter((m) => m.provider);
  const overridden = choice.model !== null || choice.effort !== null || choice.ultracode !== null;

  const change = (patch: ModelChoicePatch) => {
    tap();
    if (!conversationId) {
      useNewChatChoice.getState().set(patch);
      return;
    }
    const key = qk.conversation(conversationId);
    const prev = queryClient.getQueryData<ConversationWithMessages>(key);
    queryClient.setQueryData<ConversationWithMessages>(key, (old) => (old ? { ...old, ...patch } : old));
    api.conversations.update(conversationId, patch).catch((err) => {
      if (prev) queryClient.setQueryData<ConversationWithMessages>(key, (old) => (old ? { ...old, model: prev.model, effort: prev.effort, ultracode: prev.ultracode } : old));
      Alert.alert(t("model.switchFailed"), errorText(err));
    });
  };

  const pickModel = (m: ClaudeModel) => change({ model: m.id === base.id ? null : m.id });
  const pickEffort = (e: Effort) => change({ effort: e === baseEffort ? null : e });
  const pickUltracode = (on: boolean) => change({ ultracode: on === baseUltracode ? null : on });

  return (
    <ScrollView contentContainerStyle={styles.content} style={{ backgroundColor: c.background }}>
      <View style={{ gap: 4 }}>
        <T variant="title">{t("ai.defaultModel.model")}</T>
        <T variant="subhead" muted>
          {conversationId ? t("model.appliesNext") : t("model.forNewChat")}
        </T>
      </View>

      <Card style={{ paddingVertical: 4 }}>
        {latest.map((m, i) => (
          <View key={m.id}>
            {i > 0 ? <Hairline inset={space.lg} /> : null}
            <Option model={m} selected={m.id === current.id} isDefault={m.id === base.id} onPress={() => pickModel(m)} />
          </View>
        ))}
        {older.length > 0 ? (
          <>
            <Hairline inset={space.lg} />
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: showOlder }}
              onPress={() => {
                tap();
                setShowOlder((v) => !v);
              }}
              style={({ pressed }) => [styles.older, pressed && { backgroundColor: c.sunken }]}
            >
              <T variant="subhead" muted style={{ flex: 1 }}>
                {t("model.older")}
              </T>
              <T variant="footnote" color={c.textFaint}>
                {older.length}
              </T>
              <Icon name="down" size={12} weight="semibold" color={c.textFaint} style={{ transform: [{ rotate: showOlder ? "180deg" : "0deg" }] }} />
            </Pressable>
            {showOlder
              ? older.map((m) => (
                  <View key={m.id}>
                    <Hairline inset={space.lg} />
                    <Option model={m} compact selected={m.id === current.id} isDefault={m.id === base.id} onPress={() => pickModel(m)} />
                  </View>
                ))
              : null}
          </>
        ) : null}
        {special.length > 0 ? (
          <>
            <Hairline inset={space.lg} />
            <T variant="footnote" muted style={{ paddingHorizontal: space.lg, paddingTop: space.md }}>
              {t("model.special")}
            </T>
            {special.map((m) => (
              <Option key={m.id} model={m} selected={m.id === current.id} isDefault={m.id === base.id} onPress={() => pickModel(m)} />
            ))}
          </>
        ) : null}
        {catalog.isLoading && models.length === 0 ? (
          <T variant="footnote" muted style={{ padding: space.lg }}>
            {t("model.loading")}
          </T>
        ) : null}
      </Card>

      <Card style={styles.effortCard}>
        {effort ? (
          <EffortMeter levels={current.efforts} value={effort} onChange={pickEffort} />
        ) : (
          <T variant="footnote" muted>
            {t("model.noEffort", { model: current.label })}
          </T>
        )}
      </Card>

      {current.ultracode ? (
        <Card style={styles.effortCard}>
          <View style={styles.ultracodeHead}>
            <Icon name="workflow" size={15} color={c.textMuted} />
            <T variant="headline" style={{ fontSize: 15, flex: 1 }}>
              Ultracode
            </T>
            <Switch value={ultracode} onValueChange={pickUltracode} accessibilityLabel="Ultracode" />
          </View>
          <T variant="footnote" muted style={{ marginTop: space.sm }}>
            {currentLanguage() === "de" ? ULTRACODE_HINT_DE : ULTRACODE_HINT}
          </T>
        </Card>
      ) : anyUltracode ? (
        <T variant="footnote" muted style={{ paddingHorizontal: 4 }}>
          {t("model.noUltracode", { model: current.label })}
        </T>
      ) : null}

      <View style={styles.footer}>
        <View style={[styles.dot, { backgroundColor: catalog.data?.source === "claude" ? c.brand : c.warning }]} />
        <T variant="caption" muted style={{ flex: 1 }} numberOfLines={1}>
          {catalog.data?.source === "claude" ? `Claude Code ${catalog.data.claudeVersion ?? ""}`.trim() : t("model.builtIn")}
        </T>
        {overridden ? (
          <Pressable accessibilityRole="button" hitSlop={8} onPress={() => change(NO_CHOICE)}>
            <T variant="footnote" style={{ fontWeight: "600" }}>
              {agent ? t("model.useAgentDefault", { name: agent.name }) : t("model.useDefault")}
            </T>
          </Pressable>
        ) : null}
      </View>
    </ScrollView>
  );
}

function Option({ model, selected, isDefault, compact, onPress }: { model: ClaudeModel; selected: boolean; isDefault: boolean; compact?: boolean; onPress: () => void }) {
  const c = useColors();
  const { t } = useTranslation("settings");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.option, { paddingVertical: compact ? 10 : space.md }, pressed && { backgroundColor: c.sunken }]}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={styles.optionTitle}>
          <T variant="headline" numberOfLines={1} style={{ fontSize: compact ? 15 : 16, fontWeight: selected ? "600" : "500", flexShrink: 1 }}>
            {model.label}
          </T>
          {isDefault ? (
            <View style={[styles.tag, { borderColor: c.borderStrong }]}>
              <T variant="caption" muted style={{ fontSize: 10.5 }}>
                {t("agent.thinking.default")}
              </T>
            </View>
          ) : null}
        </View>
        {!compact && model.description ? (
          <T variant="footnote" muted numberOfLines={2}>
            {model.description}
          </T>
        ) : null}
      </View>
      {selected ? <Icon name="check" size={16} color={c.brandStrong} weight="bold" /> : null}
    </Pressable>
  );
}

function EffortMeter({ levels, value, onChange }: { levels: readonly Effort[]; value: Effort; onChange: (e: Effort) => void }) {
  const c = useColors();
  const { t } = useTranslation("settings");
  const active = levels.indexOf(value);
  return (
    <View>
      <View style={styles.effortHead}>
        <T variant="headline" style={{ fontSize: 15 }}>
          {t("ai.defaultModel.effort")}
        </T>
        <T variant="subhead">{effortLabel(value, currentLanguage())}</T>
      </View>
      <View style={styles.bars} accessibilityRole="adjustable" accessibilityLabel={t("ai.defaultModel.effort")} accessibilityValue={{ text: effortLabel(value, currentLanguage()) }}>
        {levels.map((level, i) => (
          <Pressable
            key={level}
            accessibilityRole="button"
            accessibilityLabel={effortLabel(level, currentLanguage())}
            accessibilityState={{ selected: i === active }}
            onPress={() => level !== value && onChange(level)}
            style={styles.barHit}
          >
            <View style={[styles.bar, { backgroundColor: i <= active ? c.text : c.sunken }]} />
          </Pressable>
        ))}
      </View>
      <View style={styles.effortHead}>
        <T variant="caption" color={c.textFaint}>
          {t("model.faster")}
        </T>
        <T variant="caption" color={c.textFaint}>
          {t("model.deeper")}
        </T>
      </View>
      <T variant="footnote" muted style={{ marginTop: space.sm }}>
        {t(`model.effortHint.${value}`)}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingTop: 28,
    paddingHorizontal: space.xl,
    paddingBottom: 40,
    gap: space.lg,
  },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
  optionTitle: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  tag: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 5,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  older: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingVertical: 12,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
  },
  effortCard: {
    padding: space.lg,
  },
  ultracodeHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  effortHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  bars: {
    flexDirection: "row",
    marginHorizontal: -2,
    marginTop: space.sm,
  },
  barHit: {
    flex: 1,
    height: 32,
    justifyContent: "center",
    paddingHorizontal: 2,
  },
  bar: {
    height: 8,
    borderRadius: 4,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: 4,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});
