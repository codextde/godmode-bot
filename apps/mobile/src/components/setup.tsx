import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, TextInput, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import type { WorkspaceSource } from "@godmode/shared";
import { EmojiGrid, Group, LinkRow } from "./form";
import { Icon } from "./icon";
import { Badge, Button, T, tap } from "./ui";
import type { SourceInput } from "@/lib/api";
import { useEditable } from "@/lib/setup";
import { radius, space, useColors } from "@/lib/theme";

/** Picture, name and one line about a workspace or project; each saves when you're done with it. */
export function Identity({
  icon,
  name,
  description,
  fallbackIcon,
  onChange,
}: {
  icon: string;
  name: string;
  description: string;
  fallbackIcon: string;
  onChange: (patch: { icon?: string; name?: string; description?: string }) => void;
}) {
  const c = useColors();
  const [picking, setPicking] = useState(false);
  const title = useEditable(name);
  const about = useEditable(description);

  return (
    <View style={{ gap: space.md }}>
      <View style={styles.identity}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Change the picture"
          onPress={() => {
            tap();
            setPicking((v) => !v);
          }}
          style={({ pressed }) => [styles.bigTile, { backgroundColor: c.sunken, borderColor: picking ? c.brand : c.border, opacity: pressed ? 0.75 : 1 }]}
        >
          <T style={{ fontSize: 34 }}>{icon || fallbackIcon}</T>
          <View style={[styles.editBadge, { backgroundColor: c.surface, borderColor: c.border }]}>
            <Icon name="pencil" size={10} color={c.text} weight="bold" />
          </View>
        </Pressable>
        <View style={{ flex: 1, minWidth: 0 }}>
          <TextInput
            accessibilityLabel="Name"
            value={title.text}
            onChangeText={title.setText}
            onBlur={() => {
              const next = title.done();
              if (next) onChange({ name: next });
            }}
            placeholder="Name"
            placeholderTextColor={c.textFaint}
            maxLength={80}
            returnKeyType="done"
            submitBehavior="blurAndSubmit"
            style={[styles.name, { color: c.text }]}
          />
          <TextInput
            accessibilityLabel="Description"
            value={about.text}
            onChangeText={about.setText}
            onBlur={() => {
              const next = about.done();
              if (next !== null) onChange({ description: next });
            }}
            placeholder="Add a short description"
            placeholderTextColor={c.textFaint}
            maxLength={2000}
            returnKeyType="done"
            submitBehavior="blurAndSubmit"
            style={[styles.about, { color: c.textMuted }]}
          />
        </View>
      </View>
      {picking ? (
        <EmojiGrid
          value={icon}
          onPick={(next) => {
            setPicking(false);
            if (next !== icon) onChange({ icon: next });
          }}
        />
      ) : null}
    </View>
  );
}

const STATUS: Record<WorkspaceSource["status"], { label: string; tone: "neutral" | "brand" | "warning" | "danger"; live?: boolean }> = {
  ready: { label: "Ready", tone: "brand" },
  cloning: { label: "Cloning", tone: "neutral", live: true },
  syncing: { label: "Updating", tone: "neutral", live: true },
  missing: { label: "Not cloned", tone: "warning" },
  error: { label: "Failed", tone: "danger" },
};

export function inputsOf(sources: WorkspaceSource[]): SourceInput[] {
  return sources.map((s) => (s.kind === "folder" ? { kind: "folder", path: s.path } : { kind: "git", url: s.url ?? "", branch: s.branch }));
}

/** Folders and repositories every agent in the workspace or project works with. */
export function Sources({
  sources,
  onSave,
  onSync,
  footer,
}: {
  sources: WorkspaceSource[];
  onSave: (next: SourceInput[]) => Promise<boolean>;
  onSync: (sourceId: string) => Promise<unknown>;
  footer: string;
}) {
  const c = useColors();
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (!url.trim()) return;
    setBusy(true);
    const ok = await onSave([...inputsOf(sources), { kind: "git", url: url.trim(), branch: branch.trim() || null }]);
    setBusy(false);
    if (!ok) return;
    setUrl("");
    setBranch("");
    setAdding(false);
  };

  const remove = (source: WorkspaceSource) =>
    Alert.alert(`Remove ${source.name}?`, source.kind === "git" ? "Agents stop working with it and its clone goes to the trash." : "Agents stop working with this folder. The folder itself stays.", [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => void onSave(inputsOf(sources.filter((s) => s.id !== source.id))) },
    ]);

  return (
    <Group title="Repositories and folders" footer={footer}>
      {sources.map((s) => {
        const status = STATUS[s.status];
        const where = s.kind === "git" ? [s.headBranch ?? s.branch ?? "Default branch", s.commit?.slice(0, 7)].filter(Boolean).join(" · ") : s.path;
        return (
          <View key={s.id} style={styles.source}>
            <View style={[styles.sourceIcon, { backgroundColor: c.sunken }]}>
              <Icon name={s.kind === "git" ? "branch" : "folder"} size={15} color={c.text} />
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
              <T variant="callout" numberOfLines={1} style={{ fontWeight: "500" }}>
                {s.name}
              </T>
              <T variant="caption" muted numberOfLines={1}>
                {where}
              </T>
              {s.kind === "git" ? <Badge label={status.label} tone={status.tone} live={status.live} /> : null}
              {s.error ? (
                <T variant="caption" color={c.danger} numberOfLines={3}>
                  {s.error}
                </T>
              ) : null}
            </View>
            {s.kind === "git" ? (
              <Pressable
                accessibilityLabel={`Update ${s.name}`}
                hitSlop={6}
                disabled={s.status === "cloning" || s.status === "syncing"}
                onPress={() => {
                  tap();
                  onSync(s.id).catch((err: unknown) => Alert.alert("Couldn't update it", err instanceof Error ? err.message : String(err)));
                }}
                style={({ pressed }) => [styles.iconBtn, { backgroundColor: c.sunken, opacity: pressed ? 0.6 : 1 }]}
              >
                {s.status === "cloning" || s.status === "syncing" ? <ActivityIndicator size="small" /> : <Icon name="refresh" size={13} color={c.text} />}
              </Pressable>
            ) : null}
            <Pressable
              accessibilityLabel={`Remove ${s.name}`}
              hitSlop={6}
              onPress={() => {
                tap();
                remove(s);
              }}
              style={({ pressed }) => [styles.iconBtn, { backgroundColor: c.sunken, opacity: pressed ? 0.6 : 1 }]}
            >
              <Icon name="trash" size={13} color={c.danger} />
            </Pressable>
          </View>
        );
      })}
      {adding ? (
        <Animated.View entering={FadeIn.duration(160)} style={{ padding: space.lg, gap: space.sm }}>
          <TextInput
            accessibilityLabel="Repository URL"
            value={url}
            onChangeText={setUrl}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="https://github.com/you/repo"
            placeholderTextColor={c.textFaint}
            style={[styles.input, { color: c.text, backgroundColor: c.sunken }]}
          />
          <TextInput
            accessibilityLabel="Branch"
            value={branch}
            onChangeText={setBranch}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Branch (optional)"
            placeholderTextColor={c.textFaint}
            style={[styles.input, { color: c.text, backgroundColor: c.sunken }]}
          />
          <View style={{ flexDirection: "row", gap: space.sm, marginTop: 4 }}>
            <Button title="Cancel" variant="secondary" onPress={() => setAdding(false)} style={{ flex: 1 }} />
            <Button title="Add" icon="plus" loading={busy} disabled={!url.trim()} onPress={() => void add()} style={{ flex: 1 }} />
          </View>
        </Animated.View>
      ) : (
        <LinkRow icon="plus" title="Add a git repository" tone="brand" chevron={false} onPress={() => setAdding(true)} />
      )}
    </Group>
  );
}

const styles = StyleSheet.create({
  identity: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.lg,
  },
  bigTile: {
    width: 72,
    height: 72,
    borderRadius: 22,
    borderCurve: "continuous",
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  editBadge: {
    position: "absolute",
    right: -4,
    bottom: -4,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  name: {
    fontSize: 24,
    fontWeight: "700",
    letterSpacing: -0.5,
    paddingVertical: 2,
  },
  about: {
    fontSize: 15,
    paddingVertical: 2,
  },
  source: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 12,
  },
  sourceIcon: {
    width: 30,
    height: 30,
    borderRadius: 9,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
  iconBtn: {
    width: 32,
    height: 32,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  input: {
    fontSize: 15,
    height: 44,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    borderCurve: "continuous",
  },
});
