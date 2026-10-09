import { router, Stack } from "expo-router";
import { ScrollView, StyleSheet, View } from "react-native";
import { MAX_INSTRUCTIONS_LENGTH } from "@godmode/shared";
import { CharacterAvatar } from "@/components/character";
import { CloseButton } from "@/components/close-button";
import { Group, LinkRow, TextEditor, Tile } from "@/components/form";
import { Icon, type IconName } from "@/components/icon";
import { SectionTitle, T } from "@/components/ui";
import { useAgents } from "@/lib/hooks";
import { firstLine, lineCount, patchSettings, useSettings } from "@/lib/setup";
import { radius, space, useColors } from "@/lib/theme";
import { useWorkspace } from "@/lib/workspace";

const LAYERS: { icon: IconName; label: string }[] = [
  { icon: "globe", label: "Everyone" },
  { icon: "layers", label: "Workspace" },
  { icon: "folder", label: "Project" },
  { icon: "personCircle", label: "Agent" },
  { icon: "chats", label: "Chat" },
];

const EXAMPLE = `1. Commit as me only, never add an AI co-author.
2. Keep code comments to a minimum.
3. Merge main into your branch before opening a pull request.
4. For UI changes, attach screenshots.`;

function summary(text: string, empty: string): string {
  if (!text.trim()) return empty;
  const n = lineCount(text);
  return `${firstLine(text)}${n > 1 ? ` · ${n} lines` : ""}`;
}

export default function Instructions() {
  const c = useColors();
  const settings = useSettings();
  const { workspaces } = useWorkspace();
  const { data: agents } = useAgents();

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={styles.content}
    >
      <Stack.Screen options={{ title: "Instructions" }} />
      <CloseButton />

      <View style={{ gap: space.md }}>
        <T variant="subhead" muted>
          Rules your agents follow on every run. Set them once for everyone, then refine them per workspace, project or agent.
        </T>
        <View style={styles.layers}>
          {LAYERS.map((l, i) => (
            <View key={l.label} style={styles.layerWrap}>
              <View style={[styles.layer, { backgroundColor: c.surface, borderColor: c.border }]}>
                <Icon name={l.icon} size={13} color={c.textMuted} />
                <T variant="caption" style={{ fontWeight: "600" }}>
                  {l.label}
                </T>
              </View>
              {i < LAYERS.length - 1 ? <Icon name="chevron" size={9} color={c.textFaint} weight="bold" /> : null}
            </View>
          ))}
        </View>
        <T variant="footnote" muted>
          All of them go into every run. When two disagree, the more specific one wins.
        </T>
      </View>

      <View>
        <SectionTitle title="Every agent" />
        {settings.data ? (
          <TextEditor
            label="Instructions for every agent"
            value={settings.data.runner.appendSystemPrompt}
            placeholder={EXAMPLE}
            maxLength={MAX_INSTRUCTIONS_LENGTH}
            minHeight={180}
            onSave={(appendSystemPrompt) => patchSettings({ runner: { appendSystemPrompt } }, { quiet: true })}
          />
        ) : (
          <View style={[styles.placeholder, { backgroundColor: c.surface, borderColor: c.border }]}>
            <T variant="subhead" muted>
              {settings.isError ? "Couldn't load the instructions." : "Loading…"}
            </T>
          </View>
        )}
      </View>

      {workspaces.length ? (
        <Group title="Workspaces and projects" footer="Agent context: given to every agent working in the workspace or project.">
          {workspaces.flatMap((w) => [
            <LinkRow
              key={w.id}
              emoji={w.icon || "🗂️"}
              title={w.name}
              detail={summary(w.instructions, "No agent context yet")}
              onPress={() => router.push({ pathname: "/settings/workspace/[id]", params: { id: w.id } })}
            />,
            ...w.projects.map((p) => (
              <LinkRow
                key={p.id}
                lead={
                  <View style={styles.nested}>
                    <Tile emoji={p.icon || "📁"} size={24} />
                  </View>
                }
                title={p.name}
                detail={summary(p.instructions, "No project context yet")}
                onPress={() => router.push({ pathname: "/settings/project/[id]", params: { id: p.id } })}
              />
            )),
          ])}
        </Group>
      ) : (
        <Group title="Workspaces and projects">
          <LinkRow icon="plus" title="Create a workspace" detail="Give a client or product its own agents and context." tone="brand" onPress={() => router.push({ pathname: "/settings/new", params: { kind: "workspace" } })} />
        </Group>
      )}

      {agents?.length ? (
        <Group title="Agents" footer="Each agent's own role and standing orders.">
          {agents.map((a) => (
            <LinkRow
              key={a.id}
              lead={<CharacterAvatar agent={a} size={30} />}
              title={a.name}
              detail={summary(a.instructions, "Works from your messages alone")}
              onPress={() => router.push({ pathname: "/settings/agent/[id]", params: { id: a.id } })}
            />
          ))}
        </Group>
      ) : null}

      <View style={[styles.tip, { borderColor: c.borderStrong }]}>
        <Icon name="chats" size={15} color={c.textMuted} />
        <T variant="footnote" muted style={{ flex: 1 }}>
          Just one chat? Write it into the chat. It only applies there and wins over everything above.
        </T>
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
  layers: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    rowGap: space.sm,
  },
  layerWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginRight: 4,
  },
  layer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    height: 28,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  placeholder: {
    padding: space.lg,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  nested: {
    width: 30,
    paddingLeft: 10,
  },
  tip: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: 1,
    borderStyle: "dashed",
  },
});
