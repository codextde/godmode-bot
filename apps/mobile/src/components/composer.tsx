import { useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { Glass } from "./glass";
import { Icon } from "./icon";
import { tap } from "./ui";
import { radius, space, useColors } from "@/lib/theme";

/** The message field: a glass capsule whose button sends, or stops the agent while it works. */
export function Composer({
  onSend,
  onStop,
  running,
  placeholder = "Message",
  autoFocus,
  disabled,
  defaultValue = "",
}: {
  defaultValue?: string;
  onSend: (text: string) => Promise<unknown> | void;
  onStop?: () => void;
  running?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  const c = useColors();
  const [text, setText] = useState(defaultValue);
  const [sending, setSending] = useState(false);
  const canSend = text.trim().length > 0 && !sending && !disabled;
  const showStop = running && !canSend && !!onStop;

  const submit = async () => {
    const value = text.trim();
    if (!value) return;
    tap();
    setSending(true);
    setText("");
    try {
      await onSend(value);
    } catch {
      setText(value);
    } finally {
      setSending(false);
    }
  };

  return (
    <Glass style={styles.capsule} fallback={c.surface}>
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder={placeholder}
        placeholderTextColor={c.textFaint}
        multiline
        autoFocus={autoFocus}
        editable={!disabled}
        style={[styles.input, { color: c.text }]}
        submitBehavior="newline"
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={showStop ? "Stop" : "Send"}
        disabled={!showStop && !canSend}
        onPress={() => {
          if (showStop) {
            tap();
            onStop?.();
          } else void submit();
        }}
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: showStop || canSend ? c.primary : c.sunken, opacity: pressed ? 0.75 : 1, transform: [{ scale: pressed ? 0.94 : 1 }] },
        ]}
      >
        <Icon name={showStop ? "stop" : "send"} size={showStop ? 12 : 15} weight="bold" color={showStop || canSend ? c.onPrimary : c.textFaint} />
      </Pressable>
    </Glass>
  );
}

export function ComposerDock({ children }: { children: React.ReactNode }) {
  return <View style={styles.dock}>{children}</View>;
}

const styles = StyleSheet.create({
  capsule: {
    flexDirection: "row",
    alignItems: "flex-end",
    borderRadius: 26,
    borderCurve: "continuous",
    paddingLeft: space.lg,
    paddingRight: 6,
    paddingVertical: 6,
    minHeight: 52,
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
