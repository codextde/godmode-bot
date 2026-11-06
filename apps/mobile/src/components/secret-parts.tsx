import { Button as MenuButton, Host, Image as SwiftImage, Menu } from "@expo/ui/swift-ui";
import { accessibilityLabel, contentShape, frame, shapes } from "@expo/ui/swift-ui/modifiers";
import { router } from "expo-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, TextInput, View, type KeyboardTypeOptions, type TextInputProps } from "react-native";
import { useTranslation } from "react-i18next";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import Svg, { Circle } from "react-native-svg";
import { Icon, sfSymbol, type IconName } from "./icon";
import { Row, T, tap } from "./ui";
import { fonts, radius, space, useColors } from "@/lib/theme";

/** Cancel, a title, and the sheet's action (Save, Add, Unlock…), like the app's other form sheets. */
export function SheetHeader({
  title,
  action,
  onAction,
  ready = true,
  busy,
  onCancel = () => router.back(),
}: {
  title: string;
  action?: string;
  onAction?: () => void;
  ready?: boolean;
  busy?: boolean;
  onCancel?: () => void;
}) {
  const c = useColors();
  const { t } = useTranslation("common");
  const enabled = ready && !busy;
  return (
    <Row>
      <Pressable accessibilityRole="button" hitSlop={10} disabled={busy} onPress={onCancel} style={styles.headSide}>
        <T variant="callout" muted>
          {t("actions.cancel")}
        </T>
      </Pressable>
      <T variant="headline" numberOfLines={1} style={{ flex: 1, textAlign: "center" }}>
        {title}
      </T>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: !enabled, busy }}
        hitSlop={10}
        disabled={!enabled || !onAction}
        onPress={() => {
          tap();
          onAction?.();
        }}
        style={[styles.headSide, { alignItems: "flex-end" }]}
      >
        {busy ? (
          <ActivityIndicator size="small" color={c.textMuted} />
        ) : action ? (
          <T variant="callout" color={enabled ? c.brandStrong : c.textFaint} style={{ fontWeight: "600" }}>
            {action}
          </T>
        ) : null}
      </Pressable>
    </Row>
  );
}

/** Rows of fields on one card, hairlines between them. */
export function FieldCard({ children }: { children: ReactNode }) {
  const c = useColors();
  const rows = (Array.isArray(children) ? children : [children]).filter(Boolean);
  return (
    <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
      {rows.map((row, i) => (
        <View key={i}>
          {i > 0 && <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginLeft: space.lg }} />}
          {row}
        </View>
      ))}
    </View>
  );
}

/** A label and its field on one line. `secure`: dots, with an eye to look at what was typed. */
export function InputRow({
  label,
  value,
  onChangeText,
  placeholder,
  secure,
  mono,
  keyboardType,
  autoFocus,
  autoCapitalize = "none",
  multiline,
  textContentType,
  maxLength,
  trailing,
  onSubmitEditing,
}: {
  label: string;
  value: string;
  onChangeText: (next: string) => void;
  placeholder?: string;
  secure?: boolean;
  mono?: boolean;
  keyboardType?: KeyboardTypeOptions;
  autoFocus?: boolean;
  autoCapitalize?: TextInputProps["autoCapitalize"];
  multiline?: boolean;
  textContentType?: TextInputProps["textContentType"];
  maxLength?: number;
  trailing?: ReactNode;
  onSubmitEditing?: () => void;
}) {
  const c = useColors();
  const { t } = useTranslation("vault");
  const [visible, setVisible] = useState(false);
  const hidden = !!secure && !visible;
  return (
    <View style={[styles.inputRow, multiline && { alignItems: "flex-start" }]}>
      <T variant="callout" style={[styles.inputLabel, multiline && { paddingTop: 2 }]} numberOfLines={1}>
        {label}
      </T>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={c.textFaint}
        secureTextEntry={hidden}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        spellCheck={false}
        autoComplete="off"
        importantForAutofill="no"
        textContentType={textContentType ?? (secure ? "oneTimeCode" : "none")}
        keyboardType={keyboardType}
        autoFocus={autoFocus}
        multiline={multiline}
        maxLength={maxLength}
        returnKeyType={multiline ? "default" : "done"}
        submitBehavior={multiline ? "newline" : "blurAndSubmit"}
        onSubmitEditing={onSubmitEditing}
        style={[styles.input, { color: c.text, fontFamily: mono || (secure && visible) ? fonts.mono : fonts.regular }, multiline && styles.inputMultiline]}
      />
      {secure ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={visible ? t("secret.hide") : t("secret.show")}
          hitSlop={8}
          onPress={() => {
            tap();
            setVisible((v) => !v);
          }}
        >
          <Icon name={visible ? "incognito" : "eye"} size={17} color={c.textMuted} />
        </Pressable>
      ) : null}
      {trailing}
    </View>
  );
}

/** A small round icon button in a row (copy, reveal, open). */
export function IconButton({ icon, label, onPress, busy, disabled, tint }: { icon: IconName; label: string; onPress: () => void; busy?: boolean; disabled?: boolean; tint?: string }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ busy, disabled }}
      disabled={busy || disabled}
      hitSlop={8}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [styles.iconButton, { backgroundColor: c.sunken, opacity: disabled ? 0.4 : pressed ? 0.6 : 1 }]}
    >
      {busy ? <ActivityIndicator size="small" color={c.textMuted} /> : <Icon name={icon} size={15} color={tint ?? c.text} />}
    </Pressable>
  );
}

/** Copy, then a check for a moment. `copy` resolves false when nothing was copied (cancelled). */
export function CopyButton({ label, copy, disabled }: { label: string; copy: () => Promise<boolean | void>; disabled?: boolean }) {
  const c = useColors();
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const run = async () => {
    setBusy(true);
    try {
      const ok = await copy();
      if (ok === false) return;
      setDone(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setDone(false), 1500);
    } finally {
      setBusy(false);
    }
  };
  return <IconButton icon={done ? "check" : "copy"} label={label} onPress={() => void run()} busy={busy} disabled={disabled} tint={done ? c.brandStrong : undefined} />;
}

/**
 * A secret in a row: dots until revealed, then the value for a while, with a line that runs out until it hides again.
 * `onReveal` asks for Face ID and fetches it; `onCopy` copies it (revealing first when needed).
 */
export function SecretRow({
  label,
  value,
  shownAt,
  ttlMs,
  placeholder = "••••••••••",
  onReveal,
  onHide,
  onCopy,
  revealing,
  empty,
  multiline,
  toggle = true,
}: {
  label: string;
  value: string | null;
  shownAt: number | null;
  ttlMs: number;
  placeholder?: string;
  onReveal: () => void;
  onHide: () => void;
  onCopy?: () => Promise<boolean | void>;
  revealing?: boolean;
  /** Shown instead of the dots when there is nothing to reveal. */
  empty?: string;
  multiline?: boolean;
  /** The eye that shows and hides it; off for parts of a group another row reveals. */
  toggle?: boolean;
}) {
  const { t } = useTranslation("vault");
  const shown = value !== null;
  return (
    <View style={styles.secretRow}>
      <Row style={{ gap: space.md }}>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T variant="footnote" muted>
            {label}
          </T>
          {empty ? (
            <T variant="callout" muted>
              {empty}
            </T>
          ) : shown ? (
            <T variant="callout" numberOfLines={multiline ? undefined : 2} style={{ fontFamily: multiline ? fonts.regular : fonts.mono, letterSpacing: multiline ? 0 : 0.2 }}>
              {value || "—"}
            </T>
          ) : (
            <T variant="callout" muted style={{ letterSpacing: 2 }} accessibilityLabel={t("secret.hidden")}>
              {placeholder}
            </T>
          )}
        </View>
        {empty ? null : (
          <>
            {toggle ? <IconButton icon={shown ? "incognito" : "eye"} label={shown ? t("secret.hide") : t("secret.show")} busy={revealing} onPress={shown ? onHide : onReveal} /> : null}
            {onCopy ? <CopyButton label={t("secret.copy", { name: label })} copy={onCopy} /> : null}
          </>
        )}
      </Row>
      {shown && shownAt ? <Countdown key={shownAt} from={shownAt} ms={ttlMs} /> : null}
    </View>
  );
}

/** A hairline that runs out while a revealed value stays on screen (shown at `from`, for `ms`). */
function Countdown({ from, ms }: { from: number; ms: number }) {
  const c = useColors();
  const width = useSharedValue(1);
  useEffect(() => {
    const left = Math.max(0, ms - (Date.now() - from));
    width.value = left / ms;
    width.value = withTiming(0, { duration: left, easing: Easing.linear });
  }, [from, ms, width]);
  const bar = useAnimatedStyle(() => ({ transform: [{ scaleX: width.value }] }));
  return (
    <View style={[styles.countdownTrack, { backgroundColor: c.border }]}>
      <Animated.View style={[styles.countdownBar, { backgroundColor: c.brand, transformOrigin: "left" }, bar]} />
    </View>
  );
}

/** How much of a 2FA code's period is left, as a ring. */
export function CountdownRing({ remaining, period, size = 18 }: { remaining: number; period: number; size?: number }) {
  const c = useColors();
  const stroke = 2.2;
  const r = (size - stroke) / 2;
  const length = 2 * Math.PI * r;
  const share = Math.max(0, Math.min(1, remaining / period));
  const urgent = remaining <= 5;
  return (
    <Svg width={size} height={size} style={{ transform: [{ rotate: "-90deg" }] }}>
      <Circle cx={size / 2} cy={size / 2} r={r} stroke={c.border} strokeWidth={stroke} fill="none" />
      <Circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={urgent ? c.danger : c.brand}
        strokeWidth={stroke}
        fill="none"
        strokeDasharray={`${length} ${length}`}
        strokeDashoffset={length * (1 - share)}
        strokeLinecap="round"
      />
    </Svg>
  );
}

export interface MenuItem {
  label: string;
  icon: IconName;
  onPress: () => void;
  destructive?: boolean;
}

/** "…" with a row's actions: the system menu on iOS, a dialog on Android. */
export function RowMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const c = useColors();
  const { t } = useTranslation("common");
  if (!items.length) return null;
  if (process.env.EXPO_OS === "ios") {
    return (
      <Host style={styles.menuHost}>
        <Menu
          label={<SwiftImage systemName="ellipsis" size={15} color={c.textMuted} modifiers={[frame({ width: 32, height: 32 }), contentShape(shapes.rectangle())]} />}
          modifiers={[accessibilityLabel(label)]}
        >
          {items.map((item) => (
            <MenuButton key={item.label} label={item.label} systemImage={sfSymbol(item.icon)} role={item.destructive ? "destructive" : undefined} onPress={item.onPress} />
          ))}
        </Menu>
      </Host>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={() =>
        Alert.alert(label, undefined, [
          ...items.map((item) => ({ text: item.label, style: item.destructive ? ("destructive" as const) : ("default" as const), onPress: item.onPress })),
          { text: t("actions.cancel"), style: "cancel" as const },
        ])
      }
      style={styles.menuHost}
    >
      <Icon name="more" size={17} color={c.textMuted} />
    </Pressable>
  );
}

/** A label and its value in a row (a detail screen's facts); `onPress` makes it a button. */
export function ValueRow({ label, value, onPress, trailing, muted }: { label: string; value: string; onPress?: () => void; trailing?: ReactNode; muted?: boolean }) {
  const c = useColors();
  const body = (
    <Row style={{ gap: space.md }}>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T variant="footnote" muted>
          {label}
        </T>
        <T variant="callout" color={muted ? c.textMuted : onPress ? c.brandStrong : c.text} numberOfLines={2}>
          {value}
        </T>
      </View>
      {trailing}
    </Row>
  );
  if (!onPress) return <View style={styles.secretRow}>{body}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [styles.secretRow, pressed && { backgroundColor: c.sunken }]}
    >
      {body}
    </Pressable>
  );
}

/** Asks before something is deleted for good. */
export function confirmDelete(title: string, body: string | undefined, deleteLabel: string, cancelLabel: string, onDelete: () => void) {
  Alert.alert(title, body, [
    { text: cancelLabel, style: "cancel" },
    { text: deleteLabel, style: "destructive", onPress: onDelete },
  ]);
}

const styles = StyleSheet.create({
  headSide: {
    minWidth: 76,
    height: 32,
    justifyContent: "center",
  },
  card: {
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    minHeight: 48,
  },
  inputLabel: {
    width: 112,
    fontWeight: "500",
  },
  input: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 13,
  },
  inputMultiline: {
    minHeight: 96,
    maxHeight: 220,
    paddingTop: 12,
    textAlignVertical: "top",
  },
  iconButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  secretRow: {
    paddingHorizontal: space.lg,
    paddingVertical: 12,
    gap: space.sm,
  },
  countdownTrack: {
    height: 2,
    borderRadius: 1,
    overflow: "hidden",
  },
  countdownBar: {
    height: 2,
    width: "100%",
  },
  menuHost: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
});
