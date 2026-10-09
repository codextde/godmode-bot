import { Children, isValidElement, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Switch, TextInput, View, type KeyboardTypeOptions } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { Icon, type IconName } from "./icon";
import { Card, Hairline, SectionTitle, T, tap } from "./ui";
import { useAutosave, useEditable, type SaveState } from "@/lib/setup";
import { radius, space, useColors } from "@/lib/theme";

/** A titled card of rows with hairlines between them, and an optional note below. */
export function Group({
  title,
  footer,
  action,
  onAction,
  children,
}: {
  title?: string;
  footer?: ReactNode;
  action?: string;
  onAction?: () => void;
  children: ReactNode;
}) {
  const c = useColors();
  const rows = Children.toArray(children).filter(isValidElement);
  return (
    <View>
      {title ? <SectionTitle title={title} action={action} onAction={onAction} /> : null}
      <Card style={{ overflow: "hidden" }}>
        {rows.map((row, i) => (
          <View key={row.key ?? i}>
            {i > 0 && <Hairline inset={space.lg} />}
            {row}
          </View>
        ))}
      </Card>
      {footer ? (
        <T variant="footnote" color={c.textMuted} style={styles.footer}>
          {footer}
        </T>
      ) : null}
    </View>
  );
}

export function Tile({ icon, emoji, size = 30, tint }: { icon?: IconName; emoji?: string; size?: number; tint?: string }) {
  const c = useColors();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.tile, { width: size, height: size, borderRadius: size * 0.3, backgroundColor: c.sunken }]}
    >
      {emoji ? <T style={{ fontSize: size * 0.55 }}>{emoji}</T> : icon ? <Icon name={icon} size={size * 0.5} color={tint ?? c.text} /> : null}
    </View>
  );
}

function Label({ title, detail, tone }: { title: string; detail?: ReactNode; tone?: "danger" | "brand" }) {
  const c = useColors();
  return (
    <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
      <T variant="callout" color={tone === "danger" ? c.danger : tone === "brand" ? c.brandStrong : c.text} style={{ fontWeight: "500" }} numberOfLines={1}>
        {title}
      </T>
      {detail ? (
        <T variant="footnote" muted numberOfLines={2}>
          {detail}
        </T>
      ) : null}
    </View>
  );
}

export function LinkRow({
  icon,
  emoji,
  lead,
  title,
  detail,
  value,
  onPress,
  tone,
  chevron = true,
}: {
  icon?: IconName;
  emoji?: string;
  lead?: ReactNode;
  title: string;
  detail?: ReactNode;
  value?: string;
  onPress: () => void;
  tone?: "danger" | "brand";
  chevron?: boolean;
}) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
    >
      {lead ?? (icon || emoji ? <Tile icon={icon} emoji={emoji} tint={tone === "danger" ? c.danger : tone === "brand" ? c.brandStrong : undefined} /> : null)}
      <Label title={title} detail={detail} tone={tone} />
      {value ? (
        <T variant="subhead" muted numberOfLines={1} style={styles.value}>
          {value}
        </T>
      ) : null}
      {chevron ? (
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Icon name="chevron" size={12} color={c.textFaint} weight="semibold" />
        </View>
      ) : null}
    </Pressable>
  );
}

export function SwitchRow({
  icon,
  title,
  detail,
  value,
  onChange,
  disabled,
}: {
  icon?: IconName;
  title: string;
  detail?: ReactNode;
  value: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  const c = useColors();
  return (
    <View style={[styles.row, disabled && { opacity: 0.45 }]}>
      {icon ? <Tile icon={icon} /> : null}
      <Label title={title} detail={detail} />
      <Switch
        accessibilityLabel={title}
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          tap();
          onChange(next);
        }}
        trackColor={{ true: c.brand, false: c.sunken }}
      />
    </View>
  );
}

export function StepperRow({
  icon,
  title,
  detail,
  value,
  onChange,
  min,
  max,
  steps,
  format = String,
}: {
  icon?: IconName;
  title: string;
  detail?: ReactNode;
  value: number;
  onChange: (next: number) => void;
  min: number;
  max: number;
  /** Values to step through (else whole numbers from min to max). */
  steps?: readonly number[];
  format?: (n: number) => string;
}) {
  const c = useColors();
  const move = (dir: 1 | -1) => {
    tap();
    if (steps) {
      const next = dir > 0 ? steps.find((s) => s > value) : [...steps].reverse().find((s) => s < value);
      if (next !== undefined) onChange(next);
      return;
    }
    onChange(Math.min(max, Math.max(min, value + dir)));
  };
  const canDown = steps ? steps.some((s) => s < value) : value > min;
  const canUp = steps ? steps.some((s) => s > value) : value < max;
  return (
    <View style={styles.row}>
      {icon ? <Tile icon={icon} /> : null}
      <Label title={title} detail={detail} />
      <View style={[styles.stepper, { backgroundColor: c.sunken }]}>
        <Pressable accessibilityLabel={`Less ${title}`} disabled={!canDown} hitSlop={6} onPress={() => move(-1)} style={[styles.stepBtn, { opacity: canDown ? 1 : 0.3 }]}>
          <Icon name="minus" size={13} color={c.text} weight="bold" />
        </Pressable>
        <T variant="subhead" style={styles.stepValue}>
          {format(value)}
        </T>
        <Pressable accessibilityLabel={`More ${title}`} disabled={!canUp} hitSlop={6} onPress={() => move(1)} style={[styles.stepBtn, { opacity: canUp ? 1 : 0.3 }]}>
          <Icon name="plus" size={13} color={c.text} weight="bold" />
        </Pressable>
      </View>
    </View>
  );
}

export interface Option<V extends string> {
  value: V;
  label: string;
  detail?: string;
}

/** A row that opens its choices in place, with a check on the current one. */
export function PickerRow<V extends string>({
  icon,
  title,
  detail,
  value,
  options,
  onChange,
}: {
  icon?: IconName;
  title: string;
  detail?: ReactNode;
  value: V;
  options: readonly Option<V>[];
  onChange: (next: V) => void;
}) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => {
          tap();
          setOpen((v) => !v);
        }}
        style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
      >
        {icon ? <Tile icon={icon} /> : null}
        <Label title={title} detail={detail} />
        <T variant="subhead" muted numberOfLines={1} style={styles.value}>
          {current?.label ?? value}
        </T>
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Icon name="down" size={12} color={c.textFaint} weight="semibold" style={{ transform: [{ rotate: open ? "180deg" : "0deg" }] }} />
        </View>
      </Pressable>
      {open ? (
        <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(120)} style={{ backgroundColor: c.surfaceAlt }}>
          {options.map((o) => {
            const selected = o.value === value;
            return (
              <Pressable
                key={o.value}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                onPress={() => {
                  tap();
                  setOpen(false);
                  if (!selected) onChange(o.value);
                }}
                style={({ pressed }) => [styles.option, pressed && { backgroundColor: c.sunken }]}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T variant="subhead" style={{ fontWeight: selected ? "600" : "400" }}>
                    {o.label}
                  </T>
                  {o.detail ? (
                    <T variant="caption" muted numberOfLines={2}>
                      {o.detail}
                    </T>
                  ) : null}
                </View>
                {selected ? <Icon name="check" size={14} color={c.brandStrong} weight="bold" /> : null}
              </Pressable>
            );
          })}
        </Animated.View>
      ) : null}
    </View>
  );
}

export function Segmented<V extends string>({ options, value, onChange }: { options: readonly Option<V>[]; value: V; onChange: (next: V) => void }) {
  const c = useColors();
  return (
    <View style={[styles.segmented, { backgroundColor: c.sunken }]}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => {
              if (active) return;
              tap();
              onChange(o.value);
            }}
            style={[styles.segment, active && { backgroundColor: c.surface, borderColor: c.border }]}
          >
            <T variant="footnote" numberOfLines={1} color={active ? c.text : c.textMuted} style={{ fontWeight: active ? "600" : "500" }}>
              {o.label}
            </T>
          </Pressable>
        );
      })}
    </View>
  );
}

export function SegmentRow<V extends string>({
  title,
  detail,
  options,
  value,
  onChange,
}: {
  title: string;
  detail?: ReactNode;
  options: readonly Option<V>[];
  value: V;
  onChange: (next: V) => void;
}) {
  return (
    <View style={[styles.row, { flexDirection: "column", alignItems: "stretch", gap: space.sm }]}>
      <Label title={title} detail={detail} />
      <Segmented options={options} value={value} onChange={onChange} />
    </View>
  );
}

/** One line of text, saved when you're done with it (return or leaving the field). */
export function FieldRow({
  label,
  value,
  onCommit,
  placeholder,
  keyboardType,
  maxLength,
  prefix,
  stacked,
}: {
  label: string;
  value: string;
  onCommit: (next: string) => void;
  placeholder?: string;
  keyboardType?: KeyboardTypeOptions;
  maxLength?: number;
  prefix?: string;
  /** Label above a full-width field, for longer text. */
  stacked?: boolean;
}) {
  const c = useColors();
  const { text, setText, done } = useEditable(value);
  const commit = () => {
    const next = done();
    if (next !== null) onCommit(next);
  };
  return (
    <View style={[styles.row, stacked && { flexDirection: "column", alignItems: "stretch", gap: 2 }]}>
      <T variant={stacked ? "footnote" : "callout"} muted={stacked} style={stacked ? undefined : { fontWeight: "500" }}>
        {label}
      </T>
      <View style={[{ flexDirection: "row", alignItems: "center", gap: 2 }, !stacked && { flex: 1 }]}>
        {prefix && text ? (
          <T variant="callout" muted>
            {prefix}
          </T>
        ) : null}
        <TextInput
          accessibilityLabel={label}
          value={text}
          onChangeText={setText}
          onBlur={commit}
          placeholder={placeholder}
          placeholderTextColor={c.textFaint}
          keyboardType={keyboardType}
          maxLength={maxLength}
          returnKeyType="done"
          submitBehavior="blurAndSubmit"
          style={[styles.field, { color: c.text, textAlign: stacked ? "left" : "right" }]}
        />
      </View>
    </View>
  );
}

export function SaveBadge({ state }: { state: SaveState }) {
  const c = useColors();
  if (state === "idle") return null;
  const label = state === "saving" ? "Saving" : state === "saved" ? "Saved" : "Not saved";
  const color = state === "failed" ? c.danger : state === "saved" ? c.brandStrong : c.textMuted;
  return (
    <Animated.View key={state} entering={FadeIn.duration(180)} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      {state === "saved" ? <Icon name="check" size={10} color={color} weight="bold" /> : null}
      <T variant="caption" color={color} style={{ fontWeight: "600" }}>
        {label}
      </T>
    </Animated.View>
  );
}

/**
 * Long text that saves itself (instructions, agent context, checklists): a moment after typing stops and when the field
 * loses focus. A failed save says so and tries again on the next change.
 */
export function TextEditor({
  value,
  onSave,
  placeholder,
  maxLength,
  minHeight = 140,
  label,
  hint,
}: {
  value: string;
  onSave: (next: string) => Promise<boolean>;
  placeholder?: string;
  maxLength?: number;
  minHeight?: number;
  label: string;
  hint?: string;
}) {
  const c = useColors();
  const { draft, setDraft, flush, state } = useAutosave(value, onSave);
  const [focused, setFocused] = useState(false);
  const near = maxLength ? draft.length > maxLength * 0.9 : false;
  return (
    <View
      style={[
        styles.editor,
        { backgroundColor: c.surface, borderColor: focused ? c.borderStrong : c.border },
      ]}
    >
      <TextInput
        accessibilityLabel={label}
        value={draft}
        onChangeText={setDraft}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          void flush();
        }}
        placeholder={placeholder}
        placeholderTextColor={c.textFaint}
        maxLength={maxLength}
        multiline
        scrollEnabled={false}
        style={[styles.editorInput, { color: c.text, minHeight }]}
      />
      <View style={[styles.editorFoot, { borderTopColor: c.border }]}>
        <T variant="caption" muted style={{ flex: 1 }} numberOfLines={1}>
          {hint ?? "Saves as you type"}
        </T>
        <SaveBadge state={state} />
        {maxLength && (near || focused) ? (
          <T variant="caption" color={near ? c.warning : c.textFaint} style={{ fontVariant: ["tabular-nums"] }}>
            {draft.length.toLocaleString()}/{maxLength.toLocaleString()}
          </T>
        ) : null}
      </View>
    </View>
  );
}

/** The picture of a workspace or project: an emoji on a soft tile. */
export const EMOJIS = [
  "🚀", "💼", "🏢", "🏠", "🛒", "📈", "💰", "🏦", "💡", "🎯",
  "🧠", "🎨", "✍️", "📣", "💬", "🤝", "🧑‍💻", "🛠️", "⚙️", "🧪",
  "🔬", "📚", "🎓", "🏥", "✈️", "🌍", "🌱", "🍀", "🔥", "⭐",
  "🎮", "🎬", "🎵", "📦", "🧾", "📊", "🗂️", "📝", "🔒", "🐙",
];

export function EmojiGrid({ value, onPick }: { value: string; onPick: (emoji: string) => void }) {
  const c = useColors();
  return (
    <Animated.View entering={FadeIn.duration(160)} style={[styles.emojiGrid, { backgroundColor: c.surface, borderColor: c.border }]}>
      {EMOJIS.map((e) => (
        <Pressable
          key={e}
          accessibilityLabel={`Use ${e}`}
          accessibilityState={{ selected: e === value }}
          onPress={() => {
            tap();
            onPick(e);
          }}
          style={({ pressed }) => [styles.emoji, { backgroundColor: e === value ? c.brandSoft : pressed ? c.sunken : "transparent" }]}
        >
          <T style={{ fontSize: 24 }}>{e}</T>
        </Pressable>
      ))}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  footer: {
    marginTop: space.sm,
    paddingHorizontal: 4,
  },
  tile: {
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 52,
    paddingHorizontal: space.lg,
    paddingVertical: 11,
  },
  value: {
    flexShrink: 1,
    maxWidth: "45%",
    textAlign: "right",
  },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: 11,
    paddingLeft: space.xl + space.lg,
    paddingRight: space.lg,
  },
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: radius.pill,
    height: 34,
  },
  stepBtn: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  stepValue: {
    minWidth: 44,
    textAlign: "center",
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  segmented: {
    flexDirection: "row",
    padding: 3,
    borderRadius: radius.sm,
    borderCurve: "continuous",
  },
  segment: {
    flex: 1,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "transparent",
    paddingHorizontal: 4,
  },
  field: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 4,
  },
  editor: {
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  editorInput: {
    fontSize: 15,
    lineHeight: 21,
    paddingHorizontal: space.lg,
    paddingTop: 14,
    paddingBottom: 14,
    textAlignVertical: "top",
  },
  editorFoot: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: 9,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  emojiGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    padding: space.sm,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  emoji: {
    width: 46,
    height: 46,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    borderCurve: "continuous",
  },
});
