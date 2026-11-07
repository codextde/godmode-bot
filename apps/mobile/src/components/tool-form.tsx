import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View, type KeyboardTypeOptions } from "react-native";
import { useTranslation } from "react-i18next";
import { ChoiceRow, PickerRow } from "./form";
import { Icon, type IconName } from "./icon";
import { T, tap } from "./ui";
import { RowPressable } from "./row-pressable";
import { useAgents } from "@/lib/hooks";
import type { SecretRow } from "@/lib/tools-admin";
import { fonts, space, useColors } from "@/lib/theme";
import { useWorkspace, scopeLabel } from "@/lib/workspace";

/** One field of a form, typed into directly (no save on its own): label on the left, or above for longer text. */
export function TextRow({
  label,
  value,
  onChange,
  onBlur,
  placeholder,
  mono,
  multiline,
  secure,
  stacked,
  keyboardType,
  minHeight,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  mono?: boolean;
  multiline?: boolean;
  secure?: boolean;
  stacked?: boolean;
  keyboardType?: KeyboardTypeOptions;
  minHeight?: number;
  maxLength?: number;
}) {
  const c = useColors();
  const above = stacked || multiline;
  return (
    <View style={[styles.row, above && styles.stacked]}>
      <T variant={above ? "footnote" : "callout"} muted={above} style={above ? undefined : { fontWeight: "500" }}>
        {label}
      </T>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        onBlur={onBlur}
        placeholder={placeholder}
        placeholderTextColor={c.textFaint}
        keyboardType={keyboardType}
        maxLength={maxLength}
        secureTextEntry={secure}
        multiline={multiline}
        scrollEnabled={false}
        autoCapitalize={mono || secure || keyboardType === "url" ? "none" : "sentences"}
        autoCorrect={!(mono || secure || keyboardType === "url")}
        spellCheck={!(mono || secure)}
        textContentType={secure ? "none" : undefined}
        style={[
          styles.input,
          { color: c.text, fontFamily: mono ? fonts.mono : fonts.regular, fontSize: mono ? 14 : 15, textAlign: above ? "left" : "right" },
          !above && { flex: 1 },
          multiline && { minHeight: minHeight ?? 64, textAlignVertical: "top" },
        ]}
      />
    </View>
  );
}

function IconButton({ icon, label, onPress, tint }: { icon: IconName; label: string; onPress: () => void; tint?: string }) {
  const c = useColors();
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={() => {
        tap();
        onPress();
      }}
      style={styles.iconButton}
    >
      <Icon name={icon} size={15} color={tint ?? c.textMuted} />
    </RowPressable>
  );
}

/**
 * One secret name and value (an environment variable, a header). A saved value is never shown: it can be kept,
 * replaced or removed with its row.
 */
export function SecretRowEditor({
  row,
  onChange,
  onRemove,
  keyPlaceholder,
  valuePlaceholder,
  upperCase,
}: {
  row: SecretRow;
  onChange: (patch: Partial<SecretRow>) => void;
  onRemove: () => void;
  keyPlaceholder: string;
  valuePlaceholder?: string;
  upperCase?: boolean;
}) {
  const c = useColors();
  const { t } = useTranslation("tools");
  const locked = row.stored && !row.replacing;
  return (
    <View style={styles.secret}>
      <View style={styles.secretTop}>
        {row.stored ? (
          <T variant="mono" numberOfLines={1} style={{ flex: 1, fontSize: 14 }}>
            {row.key}
          </T>
        ) : (
          <TextInput
            accessibilityLabel={t("secrets.name")}
            value={row.key}
            onChangeText={(text) => onChange({ key: upperCase ? text.toUpperCase().replace(/[^A-Z0-9_]/g, "_") : text })}
            placeholder={keyPlaceholder}
            placeholderTextColor={c.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            style={[styles.input, { flex: 1, color: c.text, fontFamily: fonts.mono, fontSize: 14 }]}
          />
        )}
        {row.stored ? (
          row.replacing ? (
            <IconButton icon="reply" label={t("secrets.keep")} onPress={() => onChange({ replacing: false, value: "" })} />
          ) : (
            <IconButton icon="pencil" label={t("secrets.replace", { key: row.key })} onPress={() => onChange({ replacing: true, value: "" })} />
          )
        ) : null}
        <IconButton icon="trash" label={row.key ? t("secrets.removeNamed", { key: row.key }) : t("secrets.remove")} onPress={onRemove} tint={c.danger} />
      </View>
      {locked ? (
        <View style={styles.lockedLine}>
          <Icon name="lock" size={11} color={c.brandStrong} />
          <T variant="footnote" muted>
            {t("secrets.stored")}
          </T>
        </View>
      ) : (
        <TextInput
          accessibilityLabel={t("secrets.value")}
          value={row.value}
          onChangeText={(value) => onChange({ value })}
          placeholder={row.replacing ? t("secrets.newValue") : (valuePlaceholder ?? t("secrets.value"))}
          placeholderTextColor={c.textFaint}
          secureTextEntry
          autoFocus={row.replacing}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          textContentType="none"
          style={[styles.input, styles.secretValue, { color: c.text, backgroundColor: c.sunken }]}
        />
      )}
    </View>
  );
}

/** A plain action inside a group: an icon and a label, busy while it runs. */
export function ActionRow({ icon, title, onPress, busy, tone }: { icon: IconName; title: string; onPress: () => void; busy?: boolean; tone?: "danger" }) {
  const c = useColors();
  const color = tone === "danger" ? c.danger : c.brandStrong;
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityState={{ busy: !!busy, disabled: !!busy }}
      disabled={busy}
      onPress={() => {
        tap();
        onPress();
      }}
      style={styles.row}
    >
      {busy ? <ActivityIndicator size="small" color={color} /> : <Icon name={icon} size={16} color={color} />}
      <T variant="callout" color={color} style={{ fontWeight: "500", flex: 1 }}>
        {title}
      </T>
    </RowPressable>
  );
}

export interface Scope {
  workspaceId: string | null;
  agentId: string | null;
}

type ScopeMode = "global" | "workspace" | "agent";

const modeOf = (s: Scope): ScopeMode => (s.agentId ? "agent" : s.workspaceId ? "workspace" : "global");

/** Who may use it: every agent, the agents of one workspace, or one agent (which also carries its workspace). Rows for a Group. */
export function useScopeRows(value: Scope, onChange: (next: Scope) => void) {
  const { t } = useTranslation("tools");
  const { workspaces } = useWorkspace();
  const { data: agents = [] } = useAgents();
  const mode = modeOf(value);
  const pick = (m: ScopeMode) => {
    if (m === "global") onChange({ workspaceId: null, agentId: null });
    else if (m === "workspace") onChange({ workspaceId: value.workspaceId ?? workspaces[0]?.id ?? null, agentId: null });
    else {
      const a = agents.find((x) => x.id === value.agentId) ?? agents.find((x) => x.isDefault) ?? agents[0];
      onChange({ workspaceId: a?.workspaceId ?? null, agentId: a?.id ?? null });
    }
  };
  const rows = [
    <ChoiceRow key="global" icon="globe" title={t("scope.global")} selected={mode === "global"} onPress={() => pick("global")} />,
  ];
  if (workspaces.length) {
    rows.push(<ChoiceRow key="workspace" icon="layers" title={t("scope.workspace")} selected={mode === "workspace"} onPress={() => pick("workspace")} />);
  }
  if (agents.length) {
    rows.push(<ChoiceRow key="agent" icon="agents" title={t("scope.agent")} selected={mode === "agent"} onPress={() => pick("agent")} />);
  }
  if (mode === "workspace" && workspaces.length) {
    rows.push(
      <PickerRow
        key="pick-workspace"
        title={t("scope.which")}
        value={value.workspaceId ?? ""}
        options={workspaces.map((w) => ({ value: w.id, label: scopeLabel(w) }))}
        onChange={(id) => onChange({ workspaceId: id, agentId: null })}
      />,
    );
  }
  if (mode === "agent" && agents.length) {
    rows.push(
      <PickerRow
        key="pick-agent"
        title={t("scope.whichAgent")}
        value={value.agentId ?? ""}
        options={agents.map((a) => ({ value: a.id, label: a.name }))}
        onChange={(id) => onChange({ workspaceId: agents.find((a) => a.id === id)?.workspaceId ?? null, agentId: id })}
      />,
    );
  }
  return rows;
}

/** A test's outcome under its button: what worked, or why not. */
export function TestResult({ ok, title, body, items }: { ok: boolean; title: string; body?: string; items?: string[] }) {
  const c = useColors();
  const [all, setAll] = useState(false);
  const { t } = useTranslation("common");
  const shown = items && !all ? items.slice(0, 12) : items;
  return (
    <View style={[styles.row, { alignItems: "flex-start" }]}>
      <Icon name={ok ? "checkCircle" : "closeCircle"} size={17} color={ok ? c.success : c.danger} />
      <View style={{ flex: 1, gap: 4 }}>
        <T variant="callout" color={ok ? c.success : c.danger} style={{ fontWeight: "500" }}>
          {title}
        </T>
        {body ? (
          <T variant="mono" muted selectable>
            {body}
          </T>
        ) : null}
        {shown?.length ? (
          <T variant="mono" muted selectable>
            {shown.join("\n")}
          </T>
        ) : null}
        {items && items.length > 12 ? (
          <Pressable accessibilityRole="button" hitSlop={6} onPress={() => setAll((v) => !v)}>
            <T variant="footnote" color={c.brandStrong} style={{ fontWeight: "500" }}>
              {all ? t("actions.showLess") : t("actions.showMore")}
            </T>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 52,
    paddingHorizontal: space.lg,
    paddingVertical: 11,
  },
  stacked: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: 2,
  },
  input: {
    paddingVertical: 4,
  },
  iconButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  secret: {
    paddingHorizontal: space.lg,
    paddingVertical: 10,
    gap: 6,
  },
  secretTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
  },
  lockedLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingBottom: 2,
  },
  secretValue: {
    fontFamily: fonts.regular,
    fontSize: 15,
    borderRadius: 9,
    borderCurve: "continuous",
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
});
