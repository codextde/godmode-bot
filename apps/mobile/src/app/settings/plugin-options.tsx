import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState, type ReactNode } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Switch, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Mod, ModOption, ModOptionValue } from "@godmode/shared";
import { CloseButton } from "@/components/close-button";
import { NeedsFullAccessScreen } from "@/components/full-access";
import { FullAccessGate, isRefused } from "@/components/admin";
import { Group, PickerRow } from "@/components/form";
import { HeaderActions } from "@/components/header-actions";
import { Icon } from "@/components/icon";
import { ErrorState, LoadingState, Row, T, tap } from "@/components/ui";
import { errorText } from "@/lib/api";
import { usePlugins } from "@/lib/integrations";
import { pluginsAdmin, putPlugin } from "@/lib/plugins-admin";
import { fonts, radius, space, useColors } from "@/lib/theme";

/** What a field holds while it is edited: numbers stay text until they are saved. */
type Field = string | boolean | string[];
/** By option key. Missing: untouched · null: back to the default. */
type Draft = Partial<Record<string, Field | null>>;

function toField(o: ModOption, v: ModOptionValue | null | undefined): Field {
  if (o.multiple) return Array.isArray(v) ? v.map(String) : v === null || v === undefined || v === "" ? [] : [String(v)];
  if (o.type === "boolean") return v === true;
  return v === null || v === undefined || Array.isArray(v) ? "" : String(v);
}

function same(a: Field, b: Field): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return a === b;
  const x = a.filter(Boolean);
  const y = b.filter(Boolean);
  return x.length === y.length && x.every((s, i) => s === y[i]);
}

/** A plugin's options (`userConfig` in its manifest), like the desktop's options tab: only what changed is saved. */
export default function PluginOptions() {
  const { t } = useTranslation("tools");
  const { id } = useLocalSearchParams<{ id: string }>();
  const list = usePlugins();
  const mod = list.data?.find((m) => m.id === id);
  return (
    <>
      <Stack.Screen options={{ title: t("pluginAdmin.options"), headerLargeTitleEnabled: false }} />
      <CloseButton />
      <FullAccessGate locked={<NeedsFullAccessScreen />}>
        {mod ? (
          <OptionsForm key={mod.id} mod={mod} />
        ) : list.isLoading ? (
          <LoadingState />
        ) : (
          <ErrorState title={list.isError ? t("pluginAdmin.loadFailed") : t("pluginAdmin.notFound")} error={list.isError ? errorText(list.error) : t("pluginAdmin.maybeDeleted")} onRetry={() => void list.refetch()} />
        )}
      </FullAccessGate>
    </>
  );
}

function OptionsForm({ mod }: { mod: Mod }) {
  const c = useColors();
  const { t } = useTranslation(["tools", "components"]);
  const [draft, setDraft] = useState<Draft>({});
  const [showProblems, setShowProblems] = useState(false);
  const [saving, setSaving] = useState(false);

  const hasSecret = (o: ModOption) => o.sensitive && mod.secretKeys.includes(o.key);
  const saved = (o: ModOption): Field => (o.sensitive ? "" : toField(o, o.key in mod.values ? mod.values[o.key] : o.default));
  const fallback = (o: ModOption): Field => (o.sensitive ? "" : toField(o, o.default));
  const current = (o: ModOption): Field => {
    const d = draft[o.key];
    return d === undefined ? saved(o) : d === null ? fallback(o) : d;
  };
  const changed = (o: ModOption): boolean => {
    const d = draft[o.key];
    if (d === undefined) return false;
    if (d === null) return o.key in mod.values || hasSecret(o);
    return o.sensitive ? d !== "" : !same(d, saved(o));
  };
  const resettable = (o: ModOption): boolean => {
    const d = draft[o.key];
    if (o.sensitive) return (hasSecret(o) && d !== null) || (typeof d === "string" && d !== "");
    return !same(current(o), fallback(o));
  };
  const problem = (o: ModOption): string | null => {
    const v = current(o);
    if (o.type === "number" && typeof v === "string") {
      const text = v.trim();
      if (!text) return o.required && o.default === null ? t("pluginAdmin.opts.enterNumber") : null;
      const n = Number(text.replace(",", "."));
      if (!Number.isFinite(n)) return t("pluginAdmin.opts.enterNumber");
      if (o.min !== null && n < o.min) return t("pluginAdmin.opts.enterMin", { min: o.min });
      if (o.max !== null && n > o.max) return t("pluginAdmin.opts.enterMax", { max: o.max });
      return null;
    }
    if (!o.required) return null;
    if (o.sensitive) return v !== "" || (hasSecret(o) && draft[o.key] !== null) ? null : t("pluginAdmin.opts.needsValue");
    if (Array.isArray(v)) return v.some(Boolean) ? null : t("pluginAdmin.opts.addOneEntry");
    return v === "" ? t("pluginAdmin.opts.needsValue") : null;
  };
  const set = (o: ModOption, value: Field | null) => setDraft((d) => ({ ...d, [o.key]: value }));
  const dirty = mod.options.some(changed);
  const invalid = mod.options.some((o) => problem(o));

  const save = async () => {
    if (invalid) return setShowProblems(true);
    const values: Record<string, ModOptionValue | null> = {};
    for (const o of mod.options) {
      if (!changed(o)) continue;
      const d = draft[o.key];
      if (d === null || d === undefined) values[o.key] = null;
      else if (Array.isArray(d)) values[o.key] = d.filter(Boolean);
      else if (o.type === "number" && typeof d === "string") values[o.key] = d.trim() ? Number(d.trim().replace(",", ".")) : null;
      else values[o.key] = d;
    }
    setSaving(true);
    try {
      putPlugin(await pluginsAdmin.update(mod.id, { values }));
      tap();
      router.back();
    } catch (err) {
      Alert.alert(isRefused(err) ? t("components:fullAccess.title") : t("pluginAdmin.opts.saveFailed"), isRefused(err) ? undefined : errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      {dirty && !saving ? <HeaderActions actions={[{ icon: "check", label: t("pluginAdmin.opts.save"), prominent: true, onPress: () => void save() }]} /> : null}
      {mod.options.map((o) => {
        const value = current(o);
        const error = problem(o);
        const shownError = error && (showProblems || draft[o.key] !== undefined) ? error : null;
        const footer = [o.description, shownError, o.sensitive ? t("pluginAdmin.opts.secretHint") : null].filter(Boolean).join("\n\n") || undefined;
        const reset = resettable(o) ? (
          <Pressable accessibilityRole="button" accessibilityLabel={t("pluginAdmin.opts.resetLabel", { title: o.title })} hitSlop={8} onPress={() => set(o, null)}>
            <T variant="footnote" color={c.brandStrong} style={{ fontWeight: "600" }}>
              {t("pluginAdmin.opts.reset")}
            </T>
          </Pressable>
        ) : null;
        const title = `${o.title}${o.required ? ` · ${t("pluginAdmin.opts.required")}` : ""}`;
        let control: ReactNode;
        if (Array.isArray(value)) {
          control = o.choices?.length ? (
            o.choices.map((choice) => {
              const on = value.includes(choice);
              return (
                <Pressable
                  key={choice}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  onPress={() => {
                    tap();
                    set(o, on ? value.filter((x) => x !== choice) : [...value, choice]);
                  }}
                  style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
                >
                  <T variant="callout" style={{ flex: 1 }}>
                    {choice}
                  </T>
                  {on ? <Icon name="check" size={15} color={c.brandStrong} weight="bold" /> : null}
                </Pressable>
              );
            })
          ) : (
            <ListEditor values={value} label={o.title} onChange={(next) => set(o, next)} />
          );
        } else if (typeof value === "boolean") {
          control = (
            <Row style={styles.row}>
              <T variant="callout" style={{ flex: 1, fontWeight: "500" }}>
                {o.title}
              </T>
              <Switch accessibilityLabel={o.title} value={value} onValueChange={(v) => (tap(), set(o, v))} trackColor={{ true: c.brand, false: c.sunken }} />
            </Row>
          );
        } else if (o.choices?.length && !o.sensitive) {
          control = <PickerRow title={o.title} value={value} options={[...(value && !o.choices.includes(value) ? [value] : []), ...o.choices].map((x) => ({ value: x, label: x }))} onChange={(v) => set(o, v)} />;
        } else {
          control = (
            <View style={styles.field}>
              <TextInput
                accessibilityLabel={o.title}
                value={value}
                onChangeText={(v) => set(o, v)}
                placeholder={
                  o.sensitive
                    ? hasSecret(o)
                      ? draft[o.key] === null
                        ? t("pluginAdmin.opts.secretRemoved")
                        : t("pluginAdmin.opts.secretSaved")
                      : t("pluginAdmin.opts.notSet")
                    : o.type === "file"
                      ? "/path/to/file"
                      : o.type === "directory"
                        ? "/path/to/folder"
                        : o.type === "number" && o.min !== null && o.max !== null
                          ? t("pluginAdmin.opts.range", { min: o.min, max: o.max })
                          : undefined
                }
                placeholderTextColor={c.textFaint}
                secureTextEntry={o.sensitive}
                keyboardType={o.type === "number" ? "decimal-pad" : "default"}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                style={[styles.input, { color: c.text, backgroundColor: c.sunken, borderColor: shownError ? c.danger : "transparent", fontFamily: o.type === "file" || o.type === "directory" ? fonts.mono : fonts.regular }]}
              />
            </View>
          );
        }
        return (
          <View key={o.key}>
            <Row style={styles.head}>
              <T variant="eyebrow" muted style={{ flex: 1 }} numberOfLines={1}>
                {title}
              </T>
              {reset}
            </Row>
            <Group footer={footer}>{control}</Group>
          </View>
        );
      })}
    </ScrollView>
  );
}

/** A list of plain strings (often patterns, so set in mono); the last empty row adds one. */
function ListEditor({ values, label, onChange }: { values: string[]; label: string; onChange: (values: string[]) => void }) {
  const c = useColors();
  const { t } = useTranslation("tools");
  const rows = [...values, ""];
  return (
    <>
      {rows.map((v, i) => (
        <Row key={i} style={[styles.row, { paddingVertical: 6 }]}>
          <TextInput
            accessibilityLabel={t("pluginAdmin.opts.entry", { label, n: i + 1 })}
            value={v}
            onChangeText={(text) => {
              const next = [...values];
              if (i === values.length) next.push(text);
              else next[i] = text;
              onChange(next);
            }}
            placeholder={i === values.length ? t("pluginAdmin.opts.addEntry") : undefined}
            placeholderTextColor={c.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            style={[styles.entry, { color: c.text, fontFamily: fonts.mono }]}
          />
          {i < values.length ? (
            <Pressable accessibilityRole="button" accessibilityLabel={t("pluginAdmin.opts.removeEntry", { n: i + 1 })} hitSlop={8} onPress={() => onChange(values.filter((_, j) => j !== i))}>
              <Icon name="closeCircle" size={17} color={c.textFaint} />
            </Pressable>
          ) : null}
        </Row>
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
  head: {
    gap: space.sm,
    paddingHorizontal: 4,
    marginBottom: space.sm,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 48,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
  },
  field: {
    paddingHorizontal: space.lg,
    paddingVertical: 10,
  },
  input: {
    fontSize: 15,
    paddingHorizontal: space.md,
    paddingVertical: 9,
    borderRadius: radius.md,
    borderCurve: "continuous",
    borderWidth: 1,
  },
  entry: {
    flex: 1,
    fontSize: 14,
    paddingVertical: 6,
  },
});
