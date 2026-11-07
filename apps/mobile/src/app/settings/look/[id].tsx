import { router, Stack, useLocalSearchParams, useNavigation } from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  AGENT_COLORS,
  CHARACTER_BODIES,
  CHARACTER_EYES,
  CHARACTER_FACES,
  CHARACTER_MOUTHS,
  CHARACTER_NECKS,
  CHARACTER_PALETTE,
  CHARACTER_TOPS,
  randomCharacter,
  type Agent,
  type AgentCharacter,
} from "@godmode/shared";
import { Character, agentCharacter } from "@/components/character";
import { CloseButton } from "@/components/close-button";
import { Segmented } from "@/components/form";
import { HeaderActions } from "@/components/header-actions";
import { Button, EmptyState, SectionTitle, T, tap } from "@/components/ui";
import { useAgents } from "@/lib/hooks";
import { patchAgent } from "@/lib/setup";
import { radius, space, useColors } from "@/lib/theme";

type Part = keyof AgentCharacter;

const PARTS: { part: Part; options: readonly string[]; zoom?: number }[] = [
  { part: "body", options: CHARACTER_BODIES },
  { part: "eyes", options: CHARACTER_EYES, zoom: 1.3 },
  { part: "mouth", options: CHARACTER_MOUTHS, zoom: 1.3 },
  { part: "top", options: CHARACTER_TOPS },
  { part: "face", options: CHARACTER_FACES, zoom: 1.15 },
  { part: "neck", options: CHARACTER_NECKS },
];

/** The emoji an agent signs with where only text fits (chat apps, its CLAUDE.md), the desktop's choice. */
const AGENT_EMOJIS = [
  "🤖", "🧠", "⚡️", "🦾", "🛰️", "🧭", "🚀", "✨",
  "📬", "📨", "🧾", "💸", "💰", "🏦", "📈", "📊",
  "🗂️", "📅", "⏰", "📝", "✍️", "📚", "🔍", "🕵️",
  "🧪", "🛠️", "🧰", "💻", "🌐", "🔐", "🛡️", "🧹",
  "🎯", "💡", "🎨", "🎬", "🎧", "📣", "🤝", "💬",
  "🛒", "✈️", "🏠", "🌱", "☕️", "🐙", "🦉", "🦊",
];

interface Look {
  character: AgentCharacter;
  color: string;
  avatar: string;
}

/** The desktop's character studio: body, eyes, mouth, hat, face and neck, its colour and its emoji. */
export default function LookEditor() {
  const { t } = useTranslation(["agents", "settings"]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const { byId, isPending } = useAgents();
  const agent = byId.get(id);
  if (!agent) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic">
        <Stack.Screen options={{ title: t("look.title") }} />
        <CloseButton />
        {isPending ? <ActivityIndicator style={{ marginTop: 80 }} /> : <EmptyState icon="agents" title={t("settings:agent.notFound.title")} body={t("settings:agent.notFound.body")} />}
      </ScrollView>
    );
  }
  return <Studio agent={agent} />;
}

function Studio({ agent }: { agent: Agent }) {
  const c = useColors();
  const { t } = useTranslation(["agents", "common"]);
  const navigation = useNavigation();
  const [start] = useState<Look>(() => ({ character: agentCharacter(agent), color: agent.color, avatar: agent.avatar || "🤖" }));
  const [look, setLook] = useState<Look>(start);
  const [ownEmoji, setOwnEmoji] = useState(() => (AGENT_EMOJIS.includes(start.avatar) ? "" : start.avatar));
  const [part, setPart] = useState<Part>("body");
  const [saving, setSaving] = useState(false);
  const [cheer, setCheer] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const dirty = !leaving && JSON.stringify(look) !== JSON.stringify(start);
  const options = PARTS.find((p) => p.part === part)!;

  // A little hop whenever the look changes.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setCheer(true);
    const timer = setTimeout(() => setCheer(false), 1100);
    return () => clearTimeout(timer);
  }, [look]);

  useEffect(() => {
    if (leaving) router.back();
  }, [leaving]);

  usePreventRemove(dirty, ({ data }) => {
    Alert.alert(t("look.discardTitle"), undefined, [
      { text: t("look.keepEditing"), style: "cancel" },
      { text: t("look.discard"), style: "destructive", onPress: () => navigation.dispatch(data.action) },
    ]);
  });

  const save = async () => {
    if (saving) return;
    setSaving(true);
    const ok = await patchAgent(agent.id, look);
    setSaving(false);
    if (ok) setLeaving(true);
  };

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" automaticallyAdjustKeyboardInsets contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: t("look.title"), headerLargeTitleEnabled: false }} />
      <CloseButton />
      {dirty ? <HeaderActions actions={[{ icon: "check", label: t("common:actions.save"), prominent: true, onPress: () => void save() }]} /> : null}

      <View style={[styles.stage, { backgroundColor: c.surfaceAlt, borderColor: c.border }]}>
        <Character character={look.character} color={look.color} mood={cheer ? "happy" : "idle"} size={116} seed={agent.id} />
        <T variant="headline" numberOfLines={1}>
          {`${look.avatar} ${agent.name}`}
        </T>
        <Button title={t("look.surprise")} icon="dice" variant="secondary" onPress={() => setLook((l) => ({ ...l, character: randomCharacter(), color: AGENT_COLORS[Math.floor(Math.random() * AGENT_COLORS.length)]! }))} />
      </View>

      <View>
        <SectionTitle title={t("look.color")} />
        <View style={styles.swatches} accessibilityRole="radiogroup">
          {AGENT_COLORS.map((color) => {
            const selected = look.color === color;
            return (
              <Pressable
                key={color}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                accessibilityLabel={t(`look.colors.${color}`)}
                onPress={() => {
                  tap();
                  setLook((l) => ({ ...l, color }));
                }}
                style={[styles.swatchRing, { borderColor: selected ? c.text : "transparent" }]}
              >
                <View style={[styles.swatch, { backgroundColor: CHARACTER_PALETTE[color]!.fill }]} />
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={{ gap: space.md }}>
        <Segmented options={PARTS.map((p) => ({ value: p.part, label: t(`look.parts.${p.part}`) }))} value={part} onChange={setPart} />
        <View style={styles.grid} accessibilityRole="radiogroup" accessibilityLabel={t(`look.parts.${part}`)}>
          {options.options.map((option) => {
            const selected = look.character[part] === option;
            const label = t(`look.options.${part}.${option}` as never);
            return (
              <Pressable
                key={option}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                accessibilityLabel={label}
                onPress={() => {
                  tap();
                  setLook((l) => ({ ...l, character: { ...l.character, [part]: option } }));
                }}
                style={({ pressed }) => [
                  styles.option,
                  { backgroundColor: selected ? c.sunken : pressed ? c.surfaceAlt : c.surface, borderColor: selected ? c.text : c.border },
                ]}
              >
                <Character character={{ ...look.character, [part]: option }} color={look.color} size={48} faceScale={options.zoom} seed={`${part}-${option}`} />
                <T variant="caption" muted={!selected} numberOfLines={1}>
                  {label}
                </T>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View>
        <SectionTitle title={t("look.emoji")} />
        <View style={[styles.emojiCard, { backgroundColor: c.surface, borderColor: c.border }]}>
          <View style={styles.emojis}>
            {AGENT_EMOJIS.map((e) => (
              <Pressable
                key={e}
                accessibilityRole="radio"
                accessibilityState={{ checked: e === look.avatar }}
                accessibilityLabel={e}
                onPress={() => {
                  tap();
                  setOwnEmoji("");
                  setLook((l) => ({ ...l, avatar: e }));
                }}
                style={({ pressed }) => [styles.emoji, { backgroundColor: e === look.avatar ? c.brandSoft : pressed ? c.sunken : "transparent" }]}
              >
                <T style={{ fontSize: 24 }}>{e}</T>
              </Pressable>
            ))}
          </View>
          <TextInput
            accessibilityLabel={t("look.customEmoji")}
            value={ownEmoji}
            onChangeText={(text) => {
              setOwnEmoji(text);
              const emoji = [...text.trim()].slice(0, 2).join("");
              if (emoji) setLook((l) => ({ ...l, avatar: emoji }));
            }}
            placeholder={t("look.customEmojiPlaceholder")}
            placeholderTextColor={c.textFaint}
            maxLength={8}
            autoCorrect={false}
            returnKeyType="done"
            style={[styles.ownEmoji, { color: c.text, borderTopColor: c.border }]}
          />
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
  stage: {
    alignItems: "center",
    gap: space.md,
    paddingTop: space.xxl,
    paddingBottom: space.lg,
    borderRadius: radius.xl,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  swatches: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  swatchRing: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  swatch: {
    width: 26,
    height: 26,
    borderRadius: 13,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.sm,
  },
  option: {
    width: "31.5%",
    alignItems: "center",
    gap: 4,
    paddingTop: space.md,
    paddingBottom: space.sm,
    borderRadius: radius.md,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  emojiCard: {
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  emojis: {
    flexDirection: "row",
    flexWrap: "wrap",
    padding: space.sm,
  },
  ownEmoji: {
    fontSize: 15,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  emoji: {
    width: "12.5%",
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
  },
});
