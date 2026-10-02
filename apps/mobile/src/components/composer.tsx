import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from "react-native";
import { AttachmentTray } from "./attachments";
import { Glass } from "./glass";
import { Icon } from "./icon";
import { tap } from "./ui";
import { usePendingFiles, type PendingFile } from "@/lib/attachments";
import { radius, space, useColors } from "@/lib/theme";

/**
 * The message field: a glass capsule whose button sends, or stops the agent while it works. With `attachments`, a
 * paperclip adds photos, a new photo or files; they wait above the text until the message goes out.
 */
export function Composer({
  onSend,
  onStop,
  running,
  placeholder = "Message",
  autoFocus,
  disabled,
  defaultValue = "",
  attachments,
}: {
  defaultValue?: string;
  onSend: (text: string, files: PendingFile[]) => Promise<unknown> | void;
  onStop?: () => void;
  running?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  attachments?: boolean;
}) {
  const c = useColors();
  const [text, setText] = useState(defaultValue);
  const { files, attach, remove, clear } = usePendingFiles();
  const [sending, setSending] = useState(false);
  const canSend = (text.trim().length > 0 || files.length > 0) && !sending && !disabled;
  const showStop = running && !canSend && !sending && !!onStop;
  const uploading = sending && files.length > 0;

  const submit = async () => {
    const value = text.trim();
    if (!value && !files.length) return;
    tap();
    setSending(true);
    setText("");
    try {
      await onSend(value, files);
      clear();
    } catch {
      setText(value);
    } finally {
      setSending(false);
    }
  };

  const active = showStop || canSend;

  return (
    <Glass style={styles.capsule} fallback={c.surface}>
      {files.length > 0 && <AttachmentTray files={files} busy={sending} onRemove={remove} />}
      <View style={styles.row}>
        {attachments && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Attach photos or files"
            disabled={disabled || sending}
            hitSlop={4}
            onPress={() => {
              tap();
              void attach();
            }}
            style={({ pressed }) => [styles.button, { opacity: disabled || sending ? 0.4 : pressed ? 0.6 : 1 }]}
          >
            <Icon name="plus" size={19} weight="semibold" color={c.textMuted} />
          </Pressable>
        )}
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={files.length ? "Add a message" : placeholder}
          placeholderTextColor={c.textFaint}
          multiline
          autoFocus={autoFocus}
          editable={!disabled}
          style={[styles.input, { color: c.text, marginLeft: attachments ? 2 : space.lg - 6 }]}
          submitBehavior="newline"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={showStop ? "Stop" : uploading ? "Sending" : "Send"}
          disabled={!showStop && !canSend}
          onPress={() => {
            if (showStop) {
              tap();
              onStop?.();
            } else void submit();
          }}
          style={({ pressed }) => [
            styles.button,
            { backgroundColor: active || uploading ? c.primary : c.sunken, opacity: pressed ? 0.75 : 1, transform: [{ scale: pressed ? 0.94 : 1 }] },
          ]}
        >
          {uploading ? (
            <ActivityIndicator size="small" color={c.onPrimary} />
          ) : (
            <Icon name={showStop ? "stop" : "send"} size={showStop ? 12 : 15} weight="bold" color={active ? c.onPrimary : c.textFaint} />
          )}
        </Pressable>
      </View>
    </Glass>
  );
}

export function ComposerDock({ children }: { children: React.ReactNode }) {
  return <View style={styles.dock}>{children}</View>;
}

const styles = StyleSheet.create({
  capsule: {
    borderRadius: 26,
    borderCurve: "continuous",
    padding: 6,
    minHeight: 52,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-end",
  },
  input: {
    flex: 1,
    fontSize: 16,
    lineHeight: 21,
    maxHeight: 140,
    paddingTop: 9,
    paddingBottom: 9,
    marginRight: space.sm,
  },
  button: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  dock: {
    paddingHorizontal: space.md,
    paddingTop: space.sm,
  },
});
