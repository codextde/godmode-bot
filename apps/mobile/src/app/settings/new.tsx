import { FlashList } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
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

type Kind = "workspace" | "project" | "agent";

const COPY: Record<Kind, { title: string; name: string; context: string; placeholder: string; icon: string }> = {
  workspace: {
    title: "New workspace",
    name: "Client, company or product",
    context: "Agent context",
    placeholder: "Who it's for, what it does, links, tone and rules. Every agent in the workspace gets it.",
    icon: "🚀",
  },
  project: {
    title: "New project",
    name: "Project name",
    context: "Project context",
    placeholder: "Goals, scope and conventions. Added to the workspace's context.",
    icon: "📁",
  },
  agent: {
    title: "New agent",
    name: "Name, like Inbox Keeper",
    context: "Instructions",
    placeholder: "What it does, how, and when it asks you.",
    icon: "",
  },
};

const GLOBAL = "";

export default function New() {
  const c = useColors();
  const params = useLocalSearchParams<{ kind?: string; workspaceId?: string }>();
  const kind: Kind = params.kind === "project" || params.kind === "agent" ? params.kind : "workspace";
  const copy = COPY[kind];
  const { workspaces } = useWorkspace();
  const [icon, setIcon] = useState(copy.icon);
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

  const start = (t: AgentTemplate | null) => {
    setTemplate(t);
    setName(t?.name ?? "");
    setRole(t?.role ?? "");
    setInstructions(t?.instructions ?? "");
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
          ? { avatar: template.avatar, color: template.color, character: template.character, personality: template.personality, description: template.description }
          : {};
        const a = await api.agents.create({ ...look, name: name.trim(), role: role.trim() || undefined, instructions: text, workspaceId: workspaceId || null });
        await queryClient.invalidateQueries({ queryKey: qk.agents });
        router.replace({ pathname: "/settings/agent/[id]", params: { id: a.id } });
      }
    } catch (err) {
      Alert.alert("Couldn't create it", errorText(err));
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
            {template ? `From “${template.name}”` : "Starting from scratch"}
          </T>
          <Pressable accessibilityRole="button" hitSlop={8} onPress={() => setPicked(false)}>
            <T variant="subhead" style={{ fontWeight: "600" }}>
              Change role
            </T>
          </Pressable>
        </View>
      ) : null}

      {kind === "project" && parent ? (
        <T variant="subhead" muted>
          In {parent.icon || "🗂️"} {parent.name}
        </T>
      ) : null}

      <View style={[styles.fields, { backgroundColor: c.surface, borderColor: c.border }]}>
        <View style={styles.nameRow}>
          {kind !== "agent" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Pick a picture"
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
            accessibilityLabel="Name"
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
              accessibilityLabel="Role"
              value={role}
              onChangeText={setRole}
              placeholder="Role, like Bookkeeper (optional)"
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
          placeholder={`${copy.context} (optional). ${copy.placeholder}`}
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
            Works in
          </T>
          <View style={styles.chips}>
            <Chip active={!workspaceId} label="Every workspace" onPress={() => setWorkspaceId(GLOBAL)} />
            {workspaces.map((w) => (
              <Chip key={w.id} active={w.id === workspaceId} label={`${w.icon || "🗂️"} ${w.name}`} onPress={() => setWorkspaceId(w.id)} />
            ))}
          </View>
          <T variant="footnote" muted>
            {parent ? `It gets ${parent.name}'s context, repositories and logins.` : "It can work in any workspace you start it in."}
          </T>
        </View>
      ) : null}

      <Button title={`Create ${kind}`} icon="plus" size="lg" loading={saving} disabled={!name.trim() || (kind === "project" && !parent)} onPress={() => void create()} />
      {kind === "agent" ? (
        <View style={{ gap: space.sm }}>
          {template?.routine ? (
            <View style={styles.hint}>
              <Icon name="clock" size={13} color={c.textMuted} />
              <T variant="footnote" muted style={{ flex: 1 }}>
                Its automation “{template.routine.name}” ({cronToHuman(template.routine.cron)}) can be added on your computer.
              </T>
            </View>
          ) : null}
          <View style={styles.hint}>
            <Icon name="lock" size={13} color={c.textMuted} />
            <T variant="footnote" muted style={{ flex: 1 }}>
              Logins, tools and folders for new agents are set on your computer.
            </T>
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}

type Filter = AgentTemplateCategory | "all" | "all-in-one";

type PickerItem = { kind: "group"; key: string; title: string; count: number } | { kind: "template"; key: string; template: AgentTemplate; divided: boolean };

const SHORT_LABELS: Record<AgentTemplateCategory, string> = {
  leadership: "Leadership",
  finance: "Finance",
  legal: "Legal",
  people: "People",
  marketing: "Marketing",
  sales: "Sales",
  customer: "Customer service",
  ecommerce: "E-commerce",
  product: "Product & design",
  engineering: "Engineering & IT",
  data: "Data",
  operations: "Operations",
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Each term has to start a word somewhere in the template: "ads" finds ads, not leads. */
const wordStarts = (query: string) =>
  query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => new RegExp(`(^|[^a-z0-9])${escape(term)}`, "i"));

const searchText = (t: AgentTemplate) => [t.name, t.role, t.description, AGENT_TEMPLATE_CATEGORY_LABELS[t.category], ...(t.covers ?? [])].join(" ");

const inFilter = (t: AgentTemplate, f: Filter) => f === "all" || (f === "all-in-one" ? !!t.covers?.length : t.category === f);

/** Every role a company has, by department, searchable: one agent per job, or one all-in-one agent per department. */
function TemplatePicker({ onPick }: { onPick: (template: AgentTemplate | null) => void }) {
  const c = useColors();
  const templates = useQuery({ queryKey: ["agent-templates"], queryFn: api.agents.templates, staleTime: 60 * 60_000 });
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const terms = useMemo(() => wordStarts(query), [query]);
  const found = useMemo(() => (templates.data ?? []).filter((t) => terms.every((re) => re.test(searchText(t)))), [templates.data, terms]);
  const shown = found.filter((t) => inFilter(t, filter));
  const chips = (["all", "all-in-one", ...AGENT_TEMPLATE_CATEGORIES] as Filter[]).filter((f) => f === "all" || f === filter || found.some((t) => inFilter(t, f)));

  const items = useMemo(() => {
    const rows = (list: AgentTemplate[]): PickerItem[] => list.map((t, i) => ({ kind: "template", key: t.id, template: t, divided: i > 0 }));
    if (filter !== "all" || terms.length) return rows(shown);
    return AGENT_TEMPLATE_CATEGORIES.flatMap((category): PickerItem[] => {
      const group = shown.filter((t) => t.category === category);
      return group.length ? [{ kind: "group", key: `g-${category}`, title: AGENT_TEMPLATE_CATEGORY_LABELS[category], count: group.length }, ...rows(group)] : [];
    });
  }, [shown, filter, terms.length]);

  const header = (
    <View style={styles.pickerHeader}>
      <Button title="Start from scratch" icon="plus" variant="secondary" onPress={() => onPick(null)} />
      <T variant="headline">Or hire one role</T>
      <T variant="subhead" muted style={{ marginTop: -space.sm }}>
        One agent per job, or one all-in-one agent that runs a whole department.
      </T>
      <View style={[styles.search, { backgroundColor: c.sunken }]}>
        <Icon name="search" size={15} color={c.textMuted} />
        <TextInput
          accessibilityLabel="Search roles"
          value={query}
          onChangeText={setQuery}
          placeholder="Search roles…"
          placeholderTextColor={c.textFaint}
          autoCorrect={false}
          returnKeyType="search"
          style={[styles.searchInput, { color: c.text }]}
        />
        {query ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={8} onPress={() => setQuery("")}>
            <Icon name="close" size={13} color={c.textMuted} />
          </Pressable>
        ) : null}
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -space.lg }} contentContainerStyle={styles.chipRow}>
        {chips.map((f) => (
          <Chip
            key={f}
            active={filter === f}
            label={`${f === "all" ? "All" : f === "all-in-one" ? "All-in-one" : SHORT_LABELS[f]} ${found.filter((t) => inFilter(t, f)).length}`}
            onPress={() => setFilter(f)}
          />
        ))}
      </ScrollView>
    </View>
  );

  return (
    <>
      <Stack.Screen options={{ title: "New agent" }} />
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
              Roles aren't available right now ({errorText(templates.error)}). Start from scratch instead.
            </T>
          ) : (
            <T variant="subhead" muted style={{ padding: space.lg }}>
              {query.trim() ? `No role matches “${query.trim()}”. Start from scratch and describe the job in the instructions.` : "No roles here yet."}
            </T>
          )
        }
      />
    </>
  );
}

function TemplateRow({ template: t, onPress }: { template: AgentTemplate; onPress: () => void }) {
  const c = useColors();
  const allInOne = !!t.covers?.length;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${t.name}, ${t.role}`}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [styles.template, pressed && { backgroundColor: c.sunken }]}
    >
      <Character character={t.character} color={t.color} size={44} seed={t.id} />
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <T variant="headline" numberOfLines={1} style={{ fontSize: 16 }}>
          {t.name}
        </T>
        <T variant="footnote" muted numberOfLines={1}>
          {t.role}
        </T>
        {t.leads || allInOne ? (
          <View style={{ flexDirection: "row", gap: 6 }}>
            {t.leads ? <Badge label="Leads a team" /> : null}
            {allInOne ? <Badge label={`All-in-one · ${t.covers!.length} jobs`} tone="brand" /> : null}
          </View>
        ) : null}
        <T variant="footnote" muted numberOfLines={2}>
          {t.description}
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
