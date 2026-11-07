import { Button as MenuButton, Host, Image as SwiftImage, Menu } from "@expo/ui/swift-ui";
import { accessibilityLabel, background, contentShape, frame, shapes } from "@expo/ui/swift-ui/modifiers";
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, TextInput, View, type TextInputInstance } from "react-native";
import { useTranslation } from "react-i18next";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import type { SlashCommand } from "@godmode/shared";
import { CHAT_SHARE_CODE_PREFIX, parseSlashCommand } from "@godmode/shared";
import { AttachmentTray } from "./attachments";
import { useFullAccess } from "./full-access";
import { Glass } from "./glass";
import { MenuSheet, useMenuSheet } from "./header-actions";
import { Icon } from "./icon";
import { T, tap } from "./ui";
import { VoiceButton } from "./voice-button";
import { errorText } from "@/lib/api";
import { addFiles, canScanDocuments, chooseCameraMode, formatBytes, fromPasted, MAX_FILES, pastedTextFile, pickFrom, type FileSource, type PendingFile } from "@/lib/attachments";
import { isChatFile, openChatFile, openChatImport } from "@/lib/chat-extras";
import { useChatPrefs } from "@/lib/chat-prefs";
import { findCommand, rankCommands, useComposerFocus, useDraft, useDrafts, useSlashCommands } from "@/lib/composer";
import { fitsInMessage, largePaste } from "@/lib/large-paste";
import { fonts, radius, space, textScale, type, useColors } from "@/lib/theme";
import { addPasteListener, setPasteActive } from "../../modules/paste-input";

export interface ComposerHandle {
  focus: () => void;
  setText: (text: string) => void;
  /** Add text below whatever is being written. */
  insert: (text: string) => void;
}

/** How the human sent this message. */
export interface SendOptions {
  /** Spoken into the field: the reply may be read out. */
  voice: boolean;
  /** Held the button and took the other way than the usual one (steer instead of queue, or the reverse). */
  otherWay: boolean;
}

/**
 * The message field: text, files from the phone, Claude Code's slash commands and whatever the screen adds to the
 * toolbar (the model). Its button sends, queues while the agent works, or stops the agent when the field is empty.
 */
export function Composer({
  onSend,
  onStop,
  running,
  placeholder,
  autoFocus,
  disabled,
  draftKey,
  agentId,
  attachments: allowFiles,
  trailing,
  sendLabel,
  otherSend,
  voice,
  blocked,
  ref,
}: {
  onSend: (text: string, files: PendingFile[], options: SendOptions) => Promise<unknown> | void;
  onStop?: () => void;
  running?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  /** Keeps the unsent text and files under this key while the app runs. */
  draftKey: string;
  /** Agent whose slash commands are offered after typing "/". */
  agentId?: string;
  /** Offer files and photos from the phone, picked or pasted. */
  attachments?: boolean;
  /** In the toolbar, before the send button (e.g. the model). */
  trailing?: ReactNode;
  /** What sending does right now, e.g. "Queue message". */
  sendLabel?: string | null;
  /** What holding the button offers instead, e.g. steer while messages queue. */
  otherSend?: string | null;
  /** A mic that dictates into the field (the computer or the phone writes it down). */
  voice?: boolean;
  /** Write, but don't send (e.g. while the agent is switched off): the text waits as a draft. */
  blocked?: boolean;
  ref?: Ref<ComposerHandle>;
}) {
  const c = useColors();
  const { t: tr } = useTranslation(["components", "common"]);
  const input = useRef<TextInputInstance>(null);
  const draft = useDraft(draftKey);
  const setDraft = useDrafts((s) => s.set);
  const { text, files } = draft;
  const setText = (t: string) => setDraft(draftKey, { text: t });
  const [sending, setSending] = useState(false);
  const [focused, setFocused] = useState(false);
  const [menuDismissed, setMenuDismissed] = useState<string | null>(null);
  const [menuForced, setMenuForced] = useState(false);
  const [dictating, setDictating] = useState(false);
  const [otherOpen, setOtherOpen] = useState(false);
  // The run ended under the open menu: nothing may pop up by itself with the next one.
  if (otherOpen && !otherSend) setOtherOpen(false);
  const dictated = useRef(false);
  const [pastedAs, setPastedAs] = useState<{ id: string; text: string; size: number } | null>(null);
  const { fullAccess } = useFullAccess();
  const commands = useSlashCommands(agentId);
  // A quote went in from outside the field: a new field measures all its lines, then the caret goes below the quote.
  const focusAt = useComposerFocus((s) => (s.key === draftKey ? s.at : 0));
  const focusedAt = useRef(focusAt);
  const [field, setField] = useState(0);
  useEffect(() => {
    if (!focusAt || focusAt === focusedAt.current) return;
    focusedAt.current = focusAt;
    setField((n) => n + 1);
    const timer = setTimeout(() => {
      const end = (useDrafts.getState().drafts[draftKey]?.text ?? "").length;
      input.current?.focus();
      input.current?.setSelection(end, end);
    }, 350);
    return () => clearTimeout(timer);
  }, [focusAt, draftKey]);

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

  const canSend = (text.trim().length > 0 || files.length > 0) && !sending && !disabled && !blocked;
  const showStop = !!running && !!onStop && !canSend && !sending;

  const slashToken = /^\/([\w:.-]*)$/.exec(text)?.[1] ?? null;
  const menuQuery = slashToken ?? (menuForced ? "" : null);
  const menuItems = useMemo(() => (menuQuery === null ? [] : rankCommands(commands.data ?? [], menuQuery)), [menuQuery, commands.data]);
  const menuOpen = !!agentId && menuQuery !== null && focused && menuDismissed !== text;
  const typed = parseSlashCommand(text);
  const hint = !menuOpen && slashToken === null && typed ? findCommand(commands.data, typed.name) : null;

  const pickCommand = (command: SlashCommand) => {
    tap();
    setMenuForced(false);
    const args = typed ? typed.args : slashToken !== null ? "" : text.trim();
    setText(`/${command.name} ${args}`);
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

  const attach = async (source: FileSource) => {
    const chosen = await pickFrom(source, MAX_FILES - files.length);
    // A shared chat opens as one instead of going along as an attachment.
    const shared = fullAccess ? chosen.find(isChatFile) : undefined;
    if (shared) await openChatFile(shared).catch((err: unknown) => Alert.alert(tr("composer.chatFileFailed"), errorText(err)));
    const picked = chosen.filter((f) => f !== shared);
    if (!picked.length) return;
    const current = useDrafts.getState().drafts[draftKey]?.files ?? [];
    setDraft(draftKey, { files: addFiles(current, picked) });
  };

  const onChange = (next: string) => {
    // A chat's share code pasted into the empty field opens the chat, like the desktop.
    const pasted = next.trim();
    if (allowFiles && fullAccess && !text.trim() && pasted.startsWith(CHAT_SHARE_CODE_PREFIX) && next.length > text.length + 1) {
      openChatImport(pasted);
      return;
    }
    const big = allowFiles && useChatPrefs.getState().largePasteAsFile ? largePaste(text, next) : null;
    if (big && attachPaste(big.pasted, big.rest)) return;
    setText(next);
    setMenuForced(false);
  };

  // Over the size the desktop takes as a file: the text stays out of the message, and the agent reads what it needs.
  const attachPaste = (pasted: string, rest: string) => {
    let file: PendingFile;
    try {
      file = pastedTextFile(pasted);
    } catch {
      return false;
    }
    const kept = addFiles(useDrafts.getState().drafts[draftKey]?.files ?? [], [file]);
    if (!kept.some((f) => f.id === file.id)) return false;
    setDraft(draftKey, { files: kept, text: rest });
    setPastedAs({ id: file.id, text: pasted, size: file.size });
    return true;
  };

  const pasteAsText = () => {
    if (!pastedAs) return;
    tap();
    const draft = useDrafts.getState().drafts[draftKey];
    setDraft(draftKey, { files: (draft?.files ?? []).filter((f) => f.id !== pastedAs.id), text: (draft?.text ?? "") + pastedAs.text });
    setPastedAs(null);
  };

  useEffect(() => {
    if (!pastedAs) return;
    const timer = setTimeout(() => setPastedAs(null), 8000);
    return () => clearTimeout(timer);
  }, [pastedAs]);

  const pasteOn = !!allowFiles && focused && !disabled;
  useEffect(() => {
    if (!pasteOn) return;
    setPasteActive(true);
    const remove = addPasteListener((pasted) => {
      const current = useDrafts.getState().drafts[draftKey]?.files ?? [];
      setDraft(draftKey, { files: addFiles(current, fromPasted(pasted)) });
    });
    return () => {
      remove();
      setPasteActive(false);
    };
  }, [pasteOn, draftKey, setDraft]);

  const removeFile = (id: string) => {
    setDraft(draftKey, { files: files.filter((f) => f.id !== id) });
  };

  const submit = async (otherWay = false) => {
    if (!canSend) return;
    const content = text.trim();
    const sent = files;
    const voiced = dictated.current;
    dictated.current = false;
    tap();
    setSending(true);
    setMenuForced(false);
    useDrafts.getState().clear(draftKey);
    try {
      await onSend(content, sent, { voice: voiced, otherWay });
    } catch {
      // Nothing gets lost: the caller shows the error, the field gets the text and files back next to anything new.
      dictated.current = voiced;
      const cur = useDrafts.getState().drafts[draftKey];
      setDraft(draftKey, { text: cur?.text ? `${content}\n\n${cur.text}` : content, files: [...sent, ...(cur?.files ?? [])] });
    } finally {
      setSending(false);
    }
  };

  const active = showStop || canSend;
  // What was said goes where the cursor would: after what is written so far.
  const insertDictated = (said: string) => {
    dictated.current = true;
    const cur = useDrafts.getState().drafts[draftKey]?.text ?? "";
    setDraft(draftKey, { text: cur.trim() ? `${cur.trimEnd()} ${said}` : said });
  };
  const label = showStop ? tr("common:actions.stop") : (sendLabel ?? tr("common:actions.send"));

  return (
    <View style={styles.root}>
      {menuOpen ? <SlashMenu items={menuItems} grouped={!menuQuery} loading={commands.isLoading} error={commands.error} onPick={pickCommand} /> : null}
      <Glass style={styles.capsule} fallback={c.surface}>
        {files.length > 0 ? <AttachmentTray files={files} onRemove={removeFile} /> : null}
        {pastedAs && files.some((f) => f.id === pastedAs.id) ? (
          <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(160)} style={styles.pasted}>
            <T variant="caption" muted numberOfLines={2} style={{ flex: 1 }}>
              {tr("composer.pastedAsFile", { size: formatBytes(pastedAs.size) })}
            </T>
            {fitsInMessage(text, pastedAs.text) ? (
              <Pressable accessibilityRole="button" hitSlop={10} onPress={pasteAsText}>
                <T variant="caption" style={{ fontWeight: "600" }}>
                  {tr("composer.pasteInline")}
                </T>
              </Pressable>
            ) : null}
          </Animated.View>
        ) : null}
        {hint ? <SlashHint command={hint} /> : null}
        <TextInput
          key={field}
          ref={input}
          value={text}
          onChangeText={onChange}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={files.length ? tr("composer.addMessage") : (placeholder ?? tr("composer.message"))}
          placeholderTextColor={c.textFaint}
          multiline
          autoFocus={autoFocus}
          editable={!disabled}
          maxFontSizeMultiplier={textScale.label}
          style={[styles.input, { color: c.text }]}
          submitBehavior="newline"
          accessibilityLabel={tr("composer.message")}
        />
        <View style={styles.toolbar}>
          {allowFiles && !dictating ? (
            // A new native menu when the strip above it opens or closes: SwiftUI hosts keep their old place otherwise.
            <AttachButton key={files.length > 0 ? "below-files" : "alone"} onPick={(s) => void attach(s)} disabled={disabled || sending || files.length >= MAX_FILES} />
          ) : null}
          {agentId && !dictating ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={tr("composer.slashCommands")}
              accessibilityState={{ selected: menuOpen }}
              onPress={toggleCommands}
              disabled={disabled}
              hitSlop={4}
              style={({ pressed }) => [styles.tool, { backgroundColor: menuOpen ? c.sunken : "transparent", opacity: pressed ? 0.6 : 1 }]}
            >
              <T maxScale={textScale.control} style={[styles.slash, { color: menuOpen ? c.text : c.textMuted }]}>/</T>
            </Pressable>
          ) : null}
          {dictating ? null : <View style={{ flex: 1 }} />}
          {dictating ? null : trailing}
          {voice ? <VoiceButton onText={insertDictated} onActive={setDictating} disabled={disabled || sending} /> : null}
          {dictating ? null : (
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
              onLongPress={otherSend && canSend ? () => {
                tap();
                setOtherOpen(true);
              } : undefined}
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
          )}
        </View>
      </Glass>
      {otherSend ? <MenuSheet items={[{ icon: "send", title: otherSend, onPress: () => void submit(true) }]} open={otherOpen} onClose={() => setOtherOpen(false)} /> : null}
    </View>
  );
}

export function ComposerDock({ children }: { children: ReactNode }) {
  return <View style={styles.dock}>{children}</View>;
}

/** Photos, camera, document scan and files: the system menu on iOS, a sheet on Android. */
function AttachButton({ onPick, disabled }: { onPick: (source: FileSource) => void; disabled?: boolean }) {
  const c = useColors();
  const { t } = useTranslation("components");
  const menu = useMenuSheet();
  if (process.env.EXPO_OS === "ios") {
    return (
      <View style={[styles.tool, disabled && { opacity: 0.4 }]} pointerEvents={disabled ? "none" : "auto"}>
        <Host style={styles.tool}>
          <Menu
            label={
              <SwiftImage
                systemName="plus"
                size={17}
                color={c.textMuted}
                modifiers={[frame({ width: 36, height: 36 }), background(c.sunken, shapes.circle()), contentShape(shapes.circle())]}
              />
            }
            modifiers={[accessibilityLabel(t("composer.attach"))]}
          >
            <MenuButton label={t("composer.photoLibrary")} systemImage="photo.on.rectangle" onPress={() => onPick("library")} />
            <MenuButton label={t("composer.takePhoto")} systemImage="camera" onPress={() => onPick("camera")} />
            {canScanDocuments() ? <MenuButton label={t("composer.scanDocument")} systemImage="doc.viewfinder" onPress={() => onPick("scan")} /> : null}
            <MenuButton label={t("composer.chooseFiles")} systemImage="folder" onPress={() => onPick("files")} />
          </Menu>
        </Host>
      </View>
    );
  }
  return (
    <>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("composer.attach")}
      disabled={disabled}
      onPress={() => {
        tap();
        menu.show([
          { icon: "photo", title: t("composer.photos"), onPress: () => onPick("library") },
          { icon: "camera", title: t("composer.camera"), onPress: () => void chooseCameraMode().then((mode) => mode && onPick(mode)) },
          { icon: "folder", title: t("composer.files"), onPress: () => onPick("files") },
        ]);
      }}
      style={({ pressed }) => [styles.tool, { backgroundColor: c.sunken, opacity: disabled ? 0.4 : pressed ? 0.6 : 1 }]}
    >
      <Icon name="plus" size={17} color={c.textMuted} weight="semibold" />
    </Pressable>
    {menu.sheet}
    </>
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
  const { t } = useTranslation("components");
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
                    {cmd.builtin ? "Claude Code" : t("composer.thisAgent")}
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
                {loading ? t("composer.loadingCommands") : error ? t("composer.commandsFailed", { error: errorText(error) }) : t("composer.noMatch")}
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
  pasted: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingTop: 4,
  },
  capsule: {
    borderRadius: radius.xl,
    borderCurve: "continuous",
    paddingTop: 4,
  },
  input: {
    fontFamily: fonts.regular,
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
    fontFamily: fonts.monoMedium,
    fontSize: 18,
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
