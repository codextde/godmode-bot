import { FlashList } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  AGENT_TEMPLATE_CATEGORIES,
  AGENT_TEMPLATE_CATEGORY_LABELS,
  cronToHuman,
  MAX_AGENT_ROLE_LENGTH,
  MAX_INSTRUCTIONS_LENGTH,
  type AgentTemplate,
  type AgentTemplateCategory,
} from "@godmode/shared";
import { Character } from "@/components/character";
import { CloseButton } from "@/components/close-button";
import { EmojiGrid } from "@/components/form";
import { Icon } from "@/components/icon";
import { Badge, Button, Hairline, SkeletonRows, T, tap } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { qk, queryClient } from "@/lib/query";
import { radius, space, useColors } from "@/lib/theme";
import { useWorkspace } from "@/lib/workspace";
import { currentLanguage, t as translate, uses12Hour } from "@/lib/i18n";
import { templateText } from "@/lib/templates";

type Kind = "workspace" | "project" | "agent";

const ICON: Record<Kind, string> = { workspace: "🚀", project: "📁", agent: "" };

const GLOBAL = "";

export default function New() {
  const c = useColors();
  const { t } = useTranslation(["settings", "common"]);
  const params = useLocalSearchParams<{ kind?: string; workspaceId?: string }>();
  const kind: Kind = params.kind === "project" || params.kind === "agent" ? params.kind : "workspace";
  const copy = { title: t(`new.${kind}.title`), name: t(`new.${kind}.name`), context: t(`new.${kind}.context`), placeholder: t(`new.${kind}.placeholder`) };
  const { workspaces } = useWorkspace();
  const [icon, setIcon] = useState(ICON[kind]);
  const [picking, setPicking] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [instructions, setInstructions] = useState("");
  const [workspaceId, setWorkspaceId] = useState(params.workspaceId ?? GLOBAL);
  const [saving, setSaving] = useState(false);
  // A new agent starts from a role (or from scratch); workspaces and projects go straight to the form.
  const [picked, setPicked] = useState(kind !== "agent");
  const [template, setTemplate] = useState<AgentTemplate | null>(null);
  const parent = workspaces.find((w) => w.id === workspaceId);

  const start = (picked: AgentTemplate | null) => {
    setTemplate(picked);
    const shown = picked ? templateText(picked) : null;
    setName(shown?.name ?? "");
    setRole(shown?.role ?? "");
    setInstructions(picked?.instructions ?? "");
    setPicked(true);
  };

  const create = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const text = instructions.trim() || undefined;
      if (kind === "workspace") {
        const w = await api.workspace.create({ name: name.trim(), icon, instructions: text });
        await queryClient.invalidateQueries({ queryKey: qk.workspaces });
        router.replace({ pathname: "/settings/workspace/[id]", params: { id: w.id } });
      } else if (kind === "project") {
        const p = await api.projects.create({ workspaceId, name: name.trim(), icon, instructions: text });
        await queryClient.invalidateQueries({ queryKey: qk.workspaces });
        router.replace({ pathname: "/settings/project/[id]", params: { id: p.id } });
      } else {
        const look = template
          ? { avatar: template.avatar, color: template.color, character: template.character, personality: template.personality, description: templateText(template).description }
          : {};
        const a = await api.agents.create({ ...look, name: name.trim(), role: role.trim() || undefined, instructions: text, workspaceId: workspaceId || null });
        await queryClient.invalidateQueries({ queryKey: qk.agents });
        router.replace({ pathname: "/settings/agent/[id]", params: { id: a.id } });
      }
    } catch (err) {
      Alert.alert(t("new.createFailed"), errorText(err));
    } finally {
      setSaving(false);
    }
  };

  if (!picked) return <TemplatePicker onPick={start} />;

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={styles.content}
    >
      <Stack.Screen options={{ title: copy.title }} />
      <CloseButton />

      {kind === "agent" ? (
        <View style={styles.from}>
          {template ? <Character character={template.character} color={template.color} size={36} seed={template.id} /> : null}
          <T variant="subhead" muted style={{ flex: 1 }} numberOfLines={1}>
            {template ? t("new.from", { name: templateText(template).name }) : t("new.fromScratch")}
          </T>
          <Pressable accessibilityRole="button" hitSlop={8} onPress={() => setPicked(false)}>
            <T variant="subhead" style={{ fontWeight: "600" }}>
              {t("new.changeRole")}
            </T>
          </Pressable>
        </View>
      ) : null}

      {kind === "project" && parent ? (
        <T variant="subhead" muted>
          {t("new.inWorkspace", { icon: parent.icon || "🗂️", name: parent.name })}
        </T>
      ) : null}

      <View style={[styles.fields, { backgroundColor: c.surface, borderColor: c.border }]}>
        <View style={styles.nameRow}>
          {kind !== "agent" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("new.pickPicture")}
              onPress={() => {
                tap();
                setPicking((v) => !v);
              }}
              style={[styles.tile, { backgroundColor: c.sunken, borderColor: picking ? c.brand : "transparent" }]}
            >
              <T style={{ fontSize: 22 }}>{icon}</T>
            </Pressable>
          ) : null}
          <TextInput
            accessibilityLabel={t("common:words.name")}
            value={name}
            onChangeText={setName}
            placeholder={copy.name}
            placeholderTextColor={c.textFaint}
            maxLength={80}
            autoFocus={kind !== "agent" || !template}
            returnKeyType="next"
            style={[styles.name, { color: c.text }]}
          />
        </View>
        {kind === "agent" ? (
          <>
            <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border }} />
            <TextInput
              accessibilityLabel={t("agent.role")}
              value={role}
              onChangeText={setRole}
              placeholder={t("new.rolePlaceholder")}
              placeholderTextColor={c.textFaint}
              maxLength={MAX_AGENT_ROLE_LENGTH}
              style={[styles.line, { color: c.text }]}
            />
          </>
        ) : null}
        <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border }} />
        <TextInput
          accessibilityLabel={copy.context}
          value={instructions}
          onChangeText={setInstructions}
          placeholder={t("new.contextPlaceholder", { label: copy.context, hint: copy.placeholder })}
          placeholderTextColor={c.textFaint}
          maxLength={kind === "agent" ? 50_000 : MAX_INSTRUCTIONS_LENGTH}
          multiline
          style={[styles.context, { color: c.text }]}
        />
      </View>

      {picking ? (
        <EmojiGrid
          value={icon}
          onPick={(e) => {
            setIcon(e);
            setPicking(false);
          }}
        />
      ) : null}

      {kind === "agent" ? (
        <View style={{ gap: space.sm }}>
          <T variant="eyebrow" muted>
            {t("new.worksIn")}
          </T>
          <View style={styles.chips}>
            <Chip active={!workspaceId} label={t("new.everyWorkspace")} onPress={() => setWorkspaceId(GLOBAL)} />
            {workspaces.map((w) => (
              <Chip key={w.id} active={w.id === workspaceId} label={`${w.icon || "🗂️"} ${w.name}`} onPress={() => setWorkspaceId(w.id)} />
            ))}
          </View>
          <T variant="footnote" muted>
            {parent ? t("new.getsContext", { name: parent.name }) : t("new.anyWorkspace")}
          </T>
        </View>
      ) : null}

      <Button title={t(`new.${kind}.create`)} icon="plus" size="lg" loading={saving} disabled={!name.trim() || (kind === "project" && !parent)} onPress={() => void create()} />
      {kind === "agent" ? (
        <View style={{ gap: space.sm }}>
          {template?.routine ? (
            <View style={styles.hint}>
              <Icon name="clock" size={13} color={c.textMuted} />
              <T variant="footnote" muted style={{ flex: 1 }}>
                {t("new.routineHint", { name: templateText(template).routine!.name, schedule: cronToHuman(template.routine.cron, currentLanguage(), uses12Hour()) })}
              </T>
            </View>
          ) : null}
          <View style={styles.hint}>
            <Icon name="lock" size={13} color={c.textMuted} />
            <T variant="footnote" muted style={{ flex: 1 }}>
              {t("new.setupHint")}
            </T>
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}

type Filter = AgentTemplateCategory | "all" | "all-in-one";

type PickerItem = { kind: "group"; key: string; title: string; count: number } | { kind: "template"; key: string; template: AgentTemplate; divided: boolean };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Each term has to start a word somewhere in the template: "ads" finds ads, not leads. */
const wordStarts = (query: string) =>
  query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => new RegExp(`(^|[^a-z0-9])${escape(term)}`, "i"));

const searchText = (t: AgentTemplate) => {
  const shown = templateText(t);
  return [t.name, t.role, t.description, AGENT_TEMPLATE_CATEGORY_LABELS[t.category], ...(t.covers ?? []), shown.name, shown.role, shown.description, translate(`settings:new.categoryTitles.${t.category}`), ...(shown.covers ?? [])].join(" ");
};

const inFilter = (t: AgentTemplate, f: Filter) => f === "all" || (f === "all-in-one" ? !!t.covers?.length : t.category === f);

/** Every role a company has, by department, searchable: one agent per job, or one all-in-one agent per department. */
function TemplatePicker({ onPick }: { onPick: (template: AgentTemplate | null) => void }) {
  const c = useColors();
  const { t, i18n } = useTranslation(["settings", "common"]);
  const templates = useQuery({ queryKey: ["agent-templates"], queryFn: api.agents.templates, staleTime: 60 * 60_000 });
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const terms = useMemo(() => wordStarts(query), [query]);
  const found = useMemo(() => (templates.data ?? []).filter((x) => terms.every((re) => re.test(searchText(x)))), [templates.data, terms, i18n.language]);
  const shown = found.filter((x) => inFilter(x, filter));
  const chips = (["all", "all-in-one", ...AGENT_TEMPLATE_CATEGORIES] as Filter[]).filter((f) => f === "all" || f === filter || found.some((x) => inFilter(x, f)));

  const items = useMemo(() => {
    const rows = (list: AgentTemplate[]): PickerItem[] => list.map((x, i) => ({ kind: "template", key: x.id, template: x, divided: i > 0 }));
    if (filter !== "all" || terms.length) return rows(shown);
    return AGENT_TEMPLATE_CATEGORIES.flatMap((category): PickerItem[] => {
      const group = shown.filter((x) => x.category === category);
      return group.length ? [{ kind: "group", key: `g-${category}`, title: t(`new.categoryTitles.${category}`), count: group.length }, ...rows(group)] : [];
    });
  }, [shown, filter, terms.length, t]);

  const header = (
    <View style={styles.pickerHeader}>
      <Button title={t("new.picker.scratch")} icon="plus" variant="secondary" onPress={() => onPick(null)} />
      <T variant="headline">{t("new.picker.hire")}</T>
      <T variant="subhead" muted style={{ marginTop: -space.sm }}>
        {t("new.picker.intro")}
      </T>
      <View style={[styles.search, { backgroundColor: c.sunken }]}>
        <Icon name="search" size={15} color={c.textMuted} />
        <TextInput
          accessibilityLabel={t("new.picker.search")}
          value={query}
          onChangeText={setQuery}
          placeholder={t("new.picker.searchPlaceholder")}
          placeholderTextColor={c.textFaint}
          autoCorrect={false}
          returnKeyType="search"
          style={[styles.searchInput, { color: c.text }]}
        />
        {query ? (
          <Pressable accessibilityRole="button" accessibilityLabel={t("new.picker.clearSearch")} hitSlop={8} onPress={() => setQuery("")}>
            <Icon name="close" size={13} color={c.textMuted} />
          </Pressable>
        ) : null}
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -space.lg }} contentContainerStyle={styles.chipRow}>
        {chips.map((f) => (
          <Chip
            key={f}
            active={filter === f}
            label={`${f === "all" ? t("common:words.all") : f === "all-in-one" ? t("new.picker.allInOne") : t(`new.categories.${f}`)} ${found.filter((x) => inFilter(x, f)).length}`}
            onPress={() => setFilter(f)}
          />
        ))}
      </ScrollView>
    </View>
  );

  return (
    <>
      <Stack.Screen options={{ title: t("new.agent.title") }} />
      <CloseButton />
      <FlashList
        data={items}
        keyExtractor={(item) => item.key}
        getItemType={(item) => item.kind}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: 60 }}
        ListHeaderComponent={header}
        renderItem={({ item }) =>
          item.kind === "group" ? (
            <View style={styles.group}>
              <T variant="eyebrow" muted>
                {item.title} · {item.count}
              </T>
            </View>
          ) : (
            <>
              {item.divided && <Hairline inset={space.lg + 44 + space.md} />}
              <TemplateRow template={item.template} onPress={() => onPick(item.template)} />
            </>
          )
        }
        ListEmptyComponent={
          templates.isLoading ? (
            <SkeletonRows count={6} avatar={44} />
          ) : templates.isError ? (
            <T variant="subhead" muted style={{ padding: space.lg }}>
              {t("new.picker.loadError", { error: errorText(templates.error) })}
            </T>
          ) : (
            <T variant="subhead" muted style={{ padding: space.lg }}>
              {query.trim() ? t("new.picker.noMatch", { query: query.trim() }) : t("new.picker.none")}
            </T>
          )
        }
      />
    </>
  );
}

function TemplateRow({ template, onPress }: { template: AgentTemplate; onPress: () => void }) {
  const c = useColors();
  const { t } = useTranslation("settings");
  const tpl = templateText(template);
  const allInOne = !!tpl.covers?.length;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${tpl.name}, ${tpl.role}`}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [styles.template, pressed && { backgroundColor: c.sunken }]}
    >
      <Character character={tpl.character} color={tpl.color} size={44} seed={tpl.id} />
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <T variant="headline" numberOfLines={1} style={{ fontSize: 16 }}>
          {tpl.name}
        </T>
        <T variant="footnote" muted numberOfLines={1}>
          {tpl.role}
        </T>
        {tpl.leads || allInOne ? (
          <View style={{ flexDirection: "row", gap: 6 }}>
            {tpl.leads ? <Badge label={t("new.picker.leads")} /> : null}
            {allInOne ? <Badge label={t("new.picker.allInOneJobs", { count: tpl.covers!.length })} tone="brand" /> : null}
          </View>
        ) : null}
        <T variant="footnote" muted numberOfLines={2}>
          {tpl.description}
        </T>
      </View>
    </Pressable>
  );
}

function Chip({ active, label, onPress }: { active: boolean; label: string; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={() => {
        tap();
        onPress();
      }}
      style={[styles.chip, { backgroundColor: active ? c.primary : c.sunken }]}
    >
      <T variant="subhead" color={active ? c.onPrimary : c.text} style={{ fontWeight: "600" }} numberOfLines={1}>
        {label}
      </T>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
  fields: {
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingLeft: space.md,
  },
  tile: {
    width: 44,
    height: 44,
    borderRadius: 13,
    borderCurve: "continuous",
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  name: {
    flex: 1,
    fontSize: 18,
    fontWeight: "600",
    paddingHorizontal: space.sm,
    paddingVertical: 16,
  },
  line: {
    fontSize: 15,
    paddingHorizontal: space.lg,
    paddingVertical: 14,
  },
  context: {
    fontSize: 15,
    lineHeight: 20,
    minHeight: 140,
    paddingHorizontal: space.lg,
    paddingTop: 14,
    paddingBottom: 14,
    textAlignVertical: "top",
  },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.sm,
  },
  chip: {
    height: 36,
    justifyContent: "center",
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    maxWidth: "100%",
  },
  hint: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: 4,
  },
  from: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: 4,
  },
  pickerHeader: {
    gap: space.lg,
    padding: space.lg,
    paddingBottom: space.sm,
  },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    height: 42,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 0,
  },
  chipRow: {
    gap: space.sm,
    paddingHorizontal: space.lg,
  },
  group: {
    paddingHorizontal: space.lg,
    paddingTop: space.xl,
    paddingBottom: space.sm,
  },
  template: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
});
