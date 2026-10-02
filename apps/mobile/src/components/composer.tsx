import { Button as MenuButton, Host, Image as SwiftImage, Menu } from "@expo/ui/swift-ui";
import { accessibilityLabel, background, contentShape, frame, shapes } from "@expo/ui/swift-ui/modifiers";
import { Image } from "expo-image";
import { useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import type { SlashCommand } from "@godmode/shared";
import { parseSlashCommand } from "@godmode/shared";
import { Glass } from "./glass";
import { Icon } from "./icon";
import { T, tap } from "./ui";
import {
  findCommand,
  formatBytes,
  MAX_ATTACHMENTS,
  pickAttachments,
  rankCommands,
  readAttachments,
  useDraft,
  useDrafts,
  useSlashCommands,
  type AttachSource,
  type PendingAttachment,
} from "@/lib/composer";
import { errorText } from "@/lib/api";
import { radius, space, type, useColors } from "@/lib/theme";

export interface ComposerInput {
  content: string;
  attachments: { name: string; mime: string; data: string }[];
}

export interface ComposerHandle {
  focus: () => void;
  setText: (text: string) => void;
  /** Add text below whatever is being written. */
  insert: (text: string) => void;
}

/**
 * The message field: text, files from the phone, Claude Code's slash commands and whatever the screen adds to the
 * toolbar (the model). Its button sends, queues while the agent works, or stops the agent when the field is empty.
 */
export function Composer({
  onSend,
  onStop,
  running,
  placeholder = "Message",
  autoFocus,
  disabled,
  draftKey,
  agentId,
  attachments: allowFiles,
  trailing,
  sendLabel,
  ref,
}: {
  onSend: (input: ComposerInput) => Promise<unknown> | void;
  onStop?: () => void;
  running?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  /** Keeps the unsent text and files under this key while the app runs. */
  draftKey: string;
  /** Agent whose slash commands are offered after typing "/". */
  agentId?: string;
  /** Offer files and photos from the phone. */
  attachments?: boolean;
  /** In the toolbar, before the send button (e.g. the model). */
  trailing?: ReactNode;
  /** What sending does right now, e.g. "Queue message". */
  sendLabel?: string;
  ref?: Ref<ComposerHandle>;
}) {
  const c = useColors();
  const input = useRef<TextInput>(null);
  const draft = useDraft(draftKey);
  const setDraft = useDrafts((s) => s.set);
  const { text, files } = draft;
  const setText = (t: string) => setDraft(draftKey, { text: t });
  const [sending, setSending] = useState(false);
  const [reading, setReading] = useState(false);
  const [focused, setFocused] = useState(false);
  const [menuDismissed, setMenuDismissed] = useState<string | null>(null);
  const [menuForced, setMenuForced] = useState(false);
  const commands = useSlashCommands(agentId);

  useImperativeHandle(ref, () => ({
    focus: () => input.current?.focus(),
    setText: (t: string) => {
      setDraft(draftKey, { text: t });
      input.current?.focus();
    },
    insert: (t: string) => {
      const cur = useDrafts.getState().drafts[draftKey]?.text ?? "";
      setDraft(draftKey, { text: cur.trim() ? `${cur.trimEnd()}\n\n${t}` : t });
      input.current?.focus();
    },
  }));

  const canSend = (text.trim().length > 0 || files.length > 0) && !sending && !reading && !disabled;
  const showStop = !!running && !!onStop && !canSend && !sending;

  const slashToken = /^\/([\w:.-]*)$/.exec(text)?.[1] ?? null;
  const menuQuery = slashToken ?? (menuForced ? "" : null);
  const menuItems = useMemo(() => (menuQuery === null ? [] : rankCommands(commands.data ?? [], menuQuery)), [menuQuery, commands.data]);
  const menuOpen = !!agentId && menuQuery !== null && focused && menuDismissed !== text;
  const typed = parseSlashCommand(text);
  const hint = !menuOpen && slashToken === null && typed ? findCommand(commands.data, typed.name) : undefined;

  const pickCommand = (command: SlashCommand) => {
    tap();
    setMenuForced(false);
    setText(`/${command.name} ${typed ? typed.args : text.trim()}`);
  };

  const toggleCommands = () => {
    tap();
    if (menuOpen) {
      setMenuDismissed(text);
      setMenuForced(false);
      return;
    }
    if (!text.trim()) setText("/");
    else setMenuForced(true);
    setMenuDismissed(null);
    input.current?.focus();
  };

  const attach = async (source: AttachSource) => {
    const room = MAX_ATTACHMENTS - files.length;
    if (room <= 0) {
      Alert.alert(`You can attach up to ${MAX_ATTACHMENTS} files.`);
      return;
    }
    try {
      const picked = await pickAttachments(source, room);
      if (!picked.length) return;
      setReading(true);
      const current = useDrafts.getState().drafts[draftKey]?.files ?? [];
      const read = await readAttachments(picked, current);
      if (read.files.length) setDraft(draftKey, { files: [...current, ...read.files] });
      if (read.skipped) Alert.alert("Some files weren't added", read.skipped);
    } catch (err) {
      Alert.alert("Couldn't add the file", errorText(err));
    } finally {
      setReading(false);
    }
  };

  const removeFile = (id: string) => {
    tap();
    setDraft(draftKey, { files: files.filter((f) => f.id !== id) });
  };

  const submit = async () => {
    if (!canSend) return;
    const content = text.trim();
    const sent = files;
    tap();
    setSending(true);
    setMenuForced(false);
    useDrafts.getState().clear(draftKey);
    try {
      await onSend({ content, attachments: sent.map(({ name, mime, data }) => ({ name, mime, data })) });
    } catch {
      // Nothing gets lost: the caller shows the error, the field gets its text and files back.
      const cur = useDrafts.getState().drafts[draftKey];
      setDraft(draftKey, { text: cur?.text || content, files: cur?.files.length ? cur.files : sent });
    } finally {
      setSending(false);
    }
  };

  const active = showStop || canSend;
  const label = showStop ? "Stop" : (sendLabel ?? "Send");

  return (
    <View style={styles.root}>
      {menuOpen ? <SlashMenu items={menuItems} grouped={!menuQuery} loading={commands.isLoading} error={commands.error} onPick={pickCommand} /> : null}
      <Glass style={styles.capsule} fallback={c.surface}>
        {files.length > 0 || reading ? <Files files={files} reading={reading} onRemove={removeFile} /> : null}
        {hint ? <SlashHint command={hint} /> : null}
        <TextInput
          ref={input}
          value={text}
          onChangeText={(t) => {
            setText(t);
            setMenuForced(false);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder}
          placeholderTextColor={c.textFaint}
          multiline
          autoFocus={autoFocus}
          editable={!disabled}
          style={[styles.input, { color: c.text }]}
          submitBehavior="newline"
          accessibilityLabel="Message"
        />
        <View style={styles.toolbar}>
          {allowFiles ? <AttachButton onPick={(s) => void attach(s)} disabled={disabled || files.length >= MAX_ATTACHMENTS} /> : null}
          {agentId ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Slash commands"
              accessibilityState={{ selected: menuOpen }}
              onPress={toggleCommands}
              disabled={disabled}
              hitSlop={4}
              style={({ pressed }) => [styles.tool, { backgroundColor: menuOpen ? c.sunken : "transparent", opacity: pressed ? 0.6 : 1 }]}
            >
              <T style={[styles.slash, { color: menuOpen ? c.text : c.textMuted }]}>/</T>
            </Pressable>
          ) : null}
          <View style={{ flex: 1 }} />
          {trailing}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={label}
            disabled={!active}
            onPress={() => {
              if (showStop) {
                tap();
                onStop?.();
              } else void submit();
            }}
            style={({ pressed }) => [
              styles.send,
              { backgroundColor: active ? c.primary : c.sunken, opacity: pressed ? 0.75 : 1, transform: [{ scale: pressed ? 0.94 : 1 }] },
            ]}
          >
            {sending ? (
              <ActivityIndicator size="small" color={c.textMuted} />
            ) : (
              <Icon name={showStop ? "stop" : "send"} size={showStop ? 12 : 15} weight="bold" color={active ? c.onPrimary : c.textFaint} />
            )}
          </Pressable>
        </View>
      </Glass>
    </View>
  );
}

export function ComposerDock({ children }: { children: ReactNode }) {
  return <View style={styles.dock}>{children}</View>;
}

/** Photos, camera and files: the system menu on iOS, a choice dialog on Android. */
function AttachButton({ onPick, disabled }: { onPick: (source: AttachSource) => void; disabled?: boolean }) {
  const c = useColors();
  if (process.env.EXPO_OS === "ios") {
    return (
      <View style={[styles.tool, disabled && { opacity: 0.4 }]} pointerEvents={disabled ? "none" : "auto"}>
        <Host matchContents>
          <Menu
            label={
              <SwiftImage
                systemName="plus"
                size={17}
                color={c.textMuted}
                modifiers={[frame({ width: 36, height: 36 }), background(c.sunken, shapes.circle()), contentShape(shapes.circle())]}
              />
            }
            modifiers={[accessibilityLabel("Attach")]}
          >
            <MenuButton label="Photo Library" systemImage="photo.on.rectangle" onPress={() => onPick("photos")} />
            <MenuButton label="Take Photo" systemImage="camera" onPress={() => onPick("camera")} />
            <MenuButton label="Choose Files" systemImage="folder" onPress={() => onPick("files")} />
          </Menu>
        </Host>
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Attach"
      disabled={disabled}
      onPress={() => {
        tap();
        Alert.alert("Attach", undefined, [
          { text: "Photos", onPress: () => onPick("photos") },
          { text: "Camera", onPress: () => onPick("camera") },
          { text: "Files", onPress: () => onPick("files") },
        ], { cancelable: true });
      }}
      style={({ pressed }) => [styles.tool, { backgroundColor: c.sunken, opacity: disabled ? 0.4 : pressed ? 0.6 : 1 }]}
    >
      <Icon name="attach" size={17} color={c.textMuted} weight="semibold" />
    </Pressable>
  );
}

function Files({ files, reading, onRemove }: { files: PendingAttachment[]; reading: boolean; onRemove: (id: string) => void }) {
  const c = useColors();
  return (
    <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(120)}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.files} keyboardShouldPersistTaps="always">
        {files.map((f) => (
          <Animated.View key={f.id} entering={FadeIn.duration(160)} exiting={FadeOut.duration(120)} style={styles.fileWrap}>
            {f.uri ? (
              <Image source={{ uri: f.uri }} style={[styles.thumb, { backgroundColor: c.sunken }]} contentFit="cover" accessibilityLabel={f.name} />
            ) : (
              <View style={[styles.fileChip, { backgroundColor: c.sunken }]}>
                <View style={[styles.fileIcon, { backgroundColor: c.surface }]}>
                  <Icon name="doc" size={16} color={c.textMuted} />
                </View>
                <View style={{ flexShrink: 1 }}>
                  <T variant="footnote" numberOfLines={1} style={{ fontWeight: "600" }}>
                    {f.name}
                  </T>
                  <T variant="caption" muted>
                    {formatBytes(f.size)}
                  </T>
                </View>
              </View>
            )}
            <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${f.name}`} hitSlop={8} onPress={() => onRemove(f.id)} style={styles.removeFile}>
              <View style={[styles.removeDot, { backgroundColor: c.background }]}>
                <Icon name="remove" size={20} color={c.textMuted} />
              </View>
            </Pressable>
          </Animated.View>
        ))}
        {reading ? (
          <View style={[styles.thumb, styles.center, { backgroundColor: c.sunken }]}>
            <ActivityIndicator size="small" color={c.textMuted} />
          </View>
        ) : null}
      </ScrollView>
    </Animated.View>
  );
}

function SlashHint({ command }: { command: SlashCommand }) {
  const c = useColors();
  return (
    <Animated.View entering={FadeIn.duration(140)} exiting={FadeOut.duration(100)} style={styles.hint}>
      <T style={[type.mono, { color: c.text, fontWeight: "600" }]}>/{command.name}</T>
      {command.argumentHint ? (
        <T numberOfLines={1} style={[type.mono, { color: c.textMuted, flexShrink: 0, maxWidth: "40%" }]}>
          {command.argumentHint}
        </T>
      ) : null}
      <T variant="footnote" muted numberOfLines={1} style={{ flex: 1 }}>
        {command.description}
      </T>
    </Animated.View>
  );
}

function SlashMenu({
  items,
  grouped,
  loading,
  error,
  onPick,
}: {
  items: SlashCommand[];
  grouped: boolean;
  loading: boolean;
  error: unknown;
  onPick: (command: SlashCommand) => void;
}) {
  const c = useColors();
  return (
    <Animated.View entering={FadeIn.duration(140)} exiting={FadeOut.duration(100)} style={styles.menuWrap}>
      <Glass style={styles.menu} fallback={c.surface}>
        <ScrollView keyboardShouldPersistTaps="always" style={{ maxHeight: 300 }} contentContainerStyle={{ padding: 6 }}>
          {items.map((cmd, i) => {
            const header = grouped && (i === 0 || items[i - 1]!.builtin !== cmd.builtin);
            return (
              <View key={cmd.name}>
                {header ? (
                  <T variant="eyebrow" muted style={styles.menuHeader}>
                    {cmd.builtin ? "Claude Code" : "This agent"}
                  </T>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`/${cmd.name}`}
                  accessibilityHint={cmd.description}
                  onPress={() => onPick(cmd)}
                  style={({ pressed }) => [styles.menuRow, pressed && { backgroundColor: c.sunken }]}
                >
                  <View style={styles.menuName}>
                    <T style={[type.mono, { color: c.text, fontWeight: "600", fontSize: 14 }]}>/{cmd.name}</T>
                    {cmd.argumentHint ? (
                      <T numberOfLines={1} style={[type.mono, { color: c.textFaint, flexShrink: 1, fontSize: 12 }]}>
                        {cmd.argumentHint}
                      </T>
                    ) : null}
                  </View>
                  {cmd.description ? (
                    <T variant="footnote" muted numberOfLines={1}>
                      {cmd.description}
                    </T>
                  ) : null}
                </Pressable>
              </View>
            );
          })}
          {items.length === 0 ? (
            <View style={styles.menuEmpty}>
              {loading ? <ActivityIndicator size="small" color={c.textMuted} /> : null}
              <T variant="footnote" muted style={{ flex: 1 }}>
                {loading ? "Loading Claude Code commands…" : error ? `Couldn't load commands — ${errorText(error)}` : "No matching command — it will be sent as a message."}
              </T>
            </View>
          ) : null}
        </ScrollView>
      </Glass>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: "relative",
  },
  capsule: {
    borderRadius: radius.xl,
    borderCurve: "continuous",
    paddingTop: 4,
  },
  input: {
    fontSize: 16,
    lineHeight: 21,
    minHeight: 40,
    maxHeight: 160,
    paddingHorizontal: space.lg,
    paddingTop: 10,
    paddingBottom: 6,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 6,
    paddingBottom: 6,
  },
  tool: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  slash: {
    ...type.mono,
    fontSize: 18,
    fontWeight: "700",
    lineHeight: 22,
  },
  send: {
    width: 36,
    height: 36,
    marginLeft: 2,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  files: {
    gap: 10,
    paddingHorizontal: space.md,
    paddingTop: 10,
    paddingBottom: 2,
  },
  fileWrap: {
    paddingTop: 6,
    paddingRight: 6,
  },
  thumb: {
    width: 60,
    height: 60,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
  center: {
    alignItems: "center",
    justifyContent: "center",
    marginTop: 6,
  },
  fileChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    height: 60,
    maxWidth: 200,
    paddingLeft: 10,
    paddingRight: 14,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
  fileIcon: {
    width: 32,
    height: 32,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  removeFile: {
    position: "absolute",
    top: 0,
    right: 0,
  },
  removeDot: {
    borderRadius: radius.pill,
  },
  hint: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: space.lg,
    paddingTop: 10,
  },
  menuWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: "100%",
    marginBottom: space.sm,
    zIndex: 10,
  },
  menu: {
    borderRadius: radius.lg,
    borderCurve: "continuous",
    overflow: "hidden",
  },
  menuHeader: {
    fontSize: 10,
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 4,
  },
  menuRow: {
    gap: 2,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: radius.sm,
    borderCurve: "continuous",
  },
  menuName: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 8,
  },
  menuEmpty: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 12,
  },
  dock: {
    paddingHorizontal: space.md,
    paddingTop: space.sm,
  },
});
