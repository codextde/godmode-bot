import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { MAX_AGENT_ROLE_LENGTH, MAX_INSTRUCTIONS_LENGTH } from "@godmode/shared";
import { CloseButton } from "@/components/close-button";
import { EmojiGrid } from "@/components/form";
import { Icon } from "@/components/icon";
import { Button, T, tap } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { qk, queryClient } from "@/lib/query";
import { radius, space, useColors } from "@/lib/theme";
import { useWorkspace } from "@/lib/workspace";

type Kind = "workspace" | "project" | "agent";

const COPY: Record<Kind, { title: string; name: string; context: string; placeholder: string; icon: string }> = {
  workspace: {
    title: "New workspace",
    name: "Client, company or product",
    context: "Agent context",
    placeholder: "Who it's for, what it does, links, tone and rules. Every agent in the workspace gets it.",
    icon: "🚀",
  },
  project: {
    title: "New project",
    name: "Project name",
    context: "Project context",
    placeholder: "Goals, scope and conventions. Added to the workspace's context.",
    icon: "📁",
  },
  agent: {
    title: "New agent",
    name: "Name, like Inbox Keeper",
    context: "Instructions",
    placeholder: "What it does, how, and when it asks you.",
    icon: "",
  },
};

const GLOBAL = "";

export default function New() {
  const c = useColors();
  const params = useLocalSearchParams<{ kind?: string; workspaceId?: string }>();
  const kind: Kind = params.kind === "project" || params.kind === "agent" ? params.kind : "workspace";
  const copy = COPY[kind];
  const { workspaces } = useWorkspace();
  const [icon, setIcon] = useState(copy.icon);
  const [picking, setPicking] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [instructions, setInstructions] = useState("");
  const [workspaceId, setWorkspaceId] = useState(params.workspaceId ?? GLOBAL);
  const [saving, setSaving] = useState(false);
  const parent = workspaces.find((w) => w.id === workspaceId);

  const create = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const text = instructions.trim() || undefined;
      if (kind === "workspace") {
        const w = await api.workspace.create({ name: name.trim(), icon, instructions: text });
        await queryClient.invalidateQueries({ queryKey: qk.workspaces });
        router.replace({ pathname: "/settings/workspace/[id]", params: { id: w.id } });
      } else if (kind === "project") {
        const p = await api.projects.create({ workspaceId, name: name.trim(), icon, instructions: text });
        await queryClient.invalidateQueries({ queryKey: qk.workspaces });
        router.replace({ pathname: "/settings/project/[id]", params: { id: p.id } });
      } else {
        const a = await api.agents.create({ name: name.trim(), role: role.trim() || undefined, instructions: text, workspaceId: workspaceId || null });
        await queryClient.invalidateQueries({ queryKey: qk.agents });
        router.replace({ pathname: "/settings/agent/[id]", params: { id: a.id } });
      }
    } catch (err) {
      Alert.alert("Couldn't create it", errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={styles.content}
    >
      <Stack.Screen options={{ title: copy.title }} />
      <CloseButton />

      {kind === "project" && parent ? (
        <T variant="subhead" muted>
          In {parent.icon || "🗂️"} {parent.name}
        </T>
      ) : null}

      <View style={[styles.fields, { backgroundColor: c.surface, borderColor: c.border }]}>
        <View style={styles.nameRow}>
          {kind !== "agent" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Pick a picture"
              onPress={() => {
                tap();
                setPicking((v) => !v);
              }}
              style={[styles.tile, { backgroundColor: c.sunken, borderColor: picking ? c.brand : "transparent" }]}
            >
              <T style={{ fontSize: 22 }}>{icon}</T>
            </Pressable>
          ) : null}
          <TextInput
            accessibilityLabel="Name"
            value={name}
            onChangeText={setName}
            placeholder={copy.name}
            placeholderTextColor={c.textFaint}
            maxLength={80}
            autoFocus
            returnKeyType="next"
            style={[styles.name, { color: c.text }]}
          />
        </View>
        {kind === "agent" ? (
          <>
            <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border }} />
            <TextInput
              accessibilityLabel="Role"
              value={role}
              onChangeText={setRole}
              placeholder="Role, like Bookkeeper (optional)"
              placeholderTextColor={c.textFaint}
              maxLength={MAX_AGENT_ROLE_LENGTH}
              style={[styles.line, { color: c.text }]}
            />
          </>
        ) : null}
        <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border }} />
        <TextInput
          accessibilityLabel={copy.context}
          value={instructions}
          onChangeText={setInstructions}
          placeholder={`${copy.context} (optional). ${copy.placeholder}`}
          placeholderTextColor={c.textFaint}
          maxLength={kind === "agent" ? 50_000 : MAX_INSTRUCTIONS_LENGTH}
          multiline
          style={[styles.context, { color: c.text }]}
        />
      </View>

      {picking ? (
        <EmojiGrid
          value={icon}
          onPick={(e) => {
            setIcon(e);
            setPicking(false);
          }}
        />
      ) : null}

      {kind === "agent" ? (
        <View style={{ gap: space.sm }}>
          <T variant="eyebrow" muted>
            Works in
          </T>
          <View style={styles.chips}>
            <Chip active={!workspaceId} label="Every workspace" onPress={() => setWorkspaceId(GLOBAL)} />
            {workspaces.map((w) => (
              <Chip key={w.id} active={w.id === workspaceId} label={`${w.icon || "🗂️"} ${w.name}`} onPress={() => setWorkspaceId(w.id)} />
            ))}
          </View>
          <T variant="footnote" muted>
            {parent ? `It gets ${parent.name}'s context, repositories and logins.` : "It can work in any workspace you start it in."}
          </T>
        </View>
      ) : null}

      <Button title={`Create ${kind}`} icon="plus" size="lg" loading={saving} disabled={!name.trim() || (kind === "project" && !parent)} onPress={() => void create()} />
      {kind === "agent" ? (
        <View style={styles.hint}>
          <Icon name="lock" size={13} color={c.textMuted} />
          <T variant="footnote" muted style={{ flex: 1 }}>
            Logins, tools and folders for new agents are set on your computer.
          </T>
        </View>
      ) : null}
    </ScrollView>
  );
}

function Chip({ active, label, onPress }: { active: boolean; label: string; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={() => {
        tap();
        onPress();
      }}
      style={[styles.chip, { backgroundColor: active ? c.primary : c.sunken }]}
    >
      <T variant="subhead" color={active ? c.onPrimary : c.text} style={{ fontWeight: "600" }} numberOfLines={1}>
        {label}
      </T>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
  fields: {
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingLeft: space.md,
  },
  tile: {
    width: 44,
    height: 44,
    borderRadius: 13,
    borderCurve: "continuous",
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  name: {
    flex: 1,
    fontSize: 18,
    fontWeight: "600",
    paddingHorizontal: space.sm,
    paddingVertical: 16,
  },
  line: {
    fontSize: 15,
    paddingHorizontal: space.lg,
    paddingVertical: 14,
  },
  context: {
    fontSize: 15,
    lineHeight: 20,
    minHeight: 140,
    paddingHorizontal: space.lg,
    paddingTop: 14,
    paddingBottom: 14,
    textAlignVertical: "top",
  },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.sm,
  },
  chip: {
    height: 36,
    justifyContent: "center",
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    maxWidth: "100%",
  },
  hint: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: 4,
  },
});
