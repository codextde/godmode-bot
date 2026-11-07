import { useState } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ModalTextInput } from "./modal-field";
import { Button, T } from "./ui";
import { fonts, radius, space, type, useColors } from "@/lib/theme";

/** A short text asked for in a dialog on both platforms (`Alert.prompt` is iOS only), with a problem shown below the field. */
export function TextPrompt({
  open,
  title,
  initial = "",
  placeholder,
  label,
  mono,
  secure,
  validate,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  initial?: string;
  placeholder?: string;
  /** The button; Save unless said otherwise. */
  label?: string;
  mono?: boolean;
  /** A password: hidden, and taken as typed. */
  secure?: boolean;
  validate?: (text: string) => string | null;
  onSubmit: (text: string) => void;
  onClose: () => void;
}) {
  const c = useColors();
  const { t } = useTranslation("common");
  const [text, setText] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  // Opening it starts from the given text.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setText(initial);
      setProblem(null);
    }
  }
  const save = () => {
    const value = secure ? text : text.trim();
    const refused = validate?.(value) ?? null;
    if (refused) return setProblem(refused);
    onSubmit(value);
  };
  return (
    <Modal visible={open} transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <Pressable accessibilityLabel={t("actions.close")} onPress={onClose} style={[StyleSheet.absoluteFill, { backgroundColor: c.scrim }]} />
      <View style={styles.wrap} pointerEvents="box-none">
        <View style={[styles.dialog, { backgroundColor: c.surface }]} accessibilityViewIsModal>
          <T variant="headline">{title}</T>
          <ModalTextInput
            value={text}
            onChangeText={(next) => {
              setText(next);
              setProblem(null);
            }}
            onSubmitEditing={save}
            returnKeyType="done"
            selectTextOnFocus
            secureTextEntry={secure}
            placeholder={placeholder}
            placeholderTextColor={c.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            accessibilityLabel={title}
            style={[type.body, styles.input, mono && { fontFamily: fonts.mono, fontSize: 14 }, { color: c.text, backgroundColor: c.sunken }]}
          />
          {problem ? (
            <T variant="footnote" color={c.danger} accessibilityLiveRegion="polite">
              {problem}
            </T>
          ) : null}
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <Button title={t("actions.cancel")} variant="secondary" onPress={onClose} style={{ flex: 1 }} />
            <Button title={label ?? t("actions.save")} onPress={save} style={{ flex: 1 }} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, justifyContent: "center", paddingHorizontal: space.xl },
  dialog: { gap: space.lg, padding: space.xl, borderRadius: radius.lg, borderCurve: "continuous" },
  input: { height: 46, paddingHorizontal: space.md, borderRadius: radius.sm, borderCurve: "continuous" },
});
