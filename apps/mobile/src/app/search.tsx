import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { SearchBarCommands } from "react-native-screens";
import { searchSegments, type Agent, type Routine, type SearchChatHit, type SearchNoteHit, type SearchTaskHit } from "@godmode/shared";
import { CharacterAvatar } from "@/components/character";
import { Tile } from "@/components/form";
import { useFullAccess } from "@/components/full-access";
import { EmptyState, ErrorState, Hairline, SectionTitle, SkeletonRows, T, tap } from "@/components/ui";
import { ApiError, api, errorText } from "@/lib/api";
import { shortTime } from "@/lib/format";
import { useAgents } from "@/lib/hooks";
import { qk } from "@/lib/query";
import { radius, space, useColors } from "@/lib/theme";

type Item =
  | { kind: "header"; key: string; title: string }
  | { kind: "agent"; key: string; agent: Agent; divided: boolean }
  | { kind: "chat"; key: string; hit: SearchChatHit; divided: boolean }
  | { kind: "task"; key: string; hit: SearchTaskHit; divided: boolean }
  | { kind: "note"; key: string; hit: SearchNoteHit; divided: boolean }
  | { kind: "automation"; key: string; routine: Routine; divided: boolean };

const fold = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

/** Every word of the query somewhere in the text. */
function matches(text: string, query: string): boolean {
  const hay = fold(text);
  return fold(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}

const agentMatches = (agent: Agent, query: string) => matches(`${agent.name} ${agent.role ?? ""} ${agent.description ?? ""}`, query);

/** Everything at once, like the desktop's command palette: chats and their messages, tasks, agents, automations and, with full access, agents' notes. */
export default function Search() {
  const { t } = useTranslation(["chat", "common"]);
  const params = useLocalSearchParams<{ q?: string }>();
  const bar = useRef<SearchBarCommands>(null);
  const [text, setText] = useState(params.q ?? "");
  const [q, setQ] = useState((params.q ?? "").trim());
  useEffect(() => {
    const next = text.trim();
    const timer = setTimeout(() => setQ(next), next ? 250 : 0);
    return () => clearTimeout(timer);
  }, [text]);
  // Opened with words from the Chats search: they're in the field already.
  useEffect(() => {
    if (!params.q) return;
    const timer = setTimeout(() => bar.current?.setText(params.q!), 350);
    return () => clearTimeout(timer);
  }, [params.q]);

  const searching = q.length >= 2;
  const notes = useFullAccess().fullAccess === true;
  const found = useQuery({ queryKey: ["search", q, notes], queryFn: () => api.search(q, notes), enabled: searching, placeholderData: keepPreviousData, staleTime: 5_000 });
  const routines = useQuery({ queryKey: qk.allRoutines, queryFn: () => api.routines.list(), enabled: searching });
  const { data: agents = [], byId } = useAgents();
  const forbidden = found.error instanceof ApiError && found.error.code === "device_forbidden";

  const items = useMemo(() => {
    if (!searching) return [];
    const out: Item[] = [];
    const matching = agents.filter((a) => agentMatches(a, q)).slice(0, 6);
    if (matching.length) {
      out.push({ kind: "header", key: "h-agents", title: t("search.agents") });
      matching.forEach((agent, i) => out.push({ kind: "agent", key: `a-${agent.id}`, agent, divided: i > 0 }));
    }
    const data = found.data;
    if (data?.chats.length) {
      out.push({ kind: "header", key: "h-chats", title: t("search.chats") });
      data.chats.forEach((hit, i) => out.push({ kind: "chat", key: `c-${hit.id}`, hit, divided: i > 0 }));
    }
    if (data?.tasks.length) {
      out.push({ kind: "header", key: "h-tasks", title: t("search.tasks") });
      data.tasks.forEach((hit, i) => out.push({ kind: "task", key: `t-${hit.id}`, hit, divided: i > 0 }));
    }
    if (data?.notes.length) {
      out.push({ kind: "header", key: "h-notes", title: t("search.notes") });
      data.notes.forEach((hit, i) => out.push({ kind: "note", key: `n-${hit.agentId}-${hit.path}`, hit, divided: i > 0 }));
    }
    const automations = (routines.data ?? []).filter((r) => matches(`${r.name} ${r.prompt}`, q)).slice(0, 6);
    if (automations.length) {
      out.push({ kind: "header", key: "h-automations", title: t("search.automations") });
      automations.forEach((routine, i) => out.push({ kind: "automation", key: `r-${routine.id}`, routine, divided: i > 0 }));
    }
    return out;
  }, [searching, agents, q, found.data, routines.data, t]);

  const renderItem: ListRenderItem<Item> = useCallback(
    ({ item }) => {
      switch (item.kind) {
        case "header":
          return (
            <View style={{ paddingHorizontal: space.sm, paddingTop: space.lg }}>
              <SectionTitle title={item.title} />
            </View>
          );
        case "agent":
          return (
            <>
              {item.divided && <Hairline inset={68} />}
              <AgentHit agent={item.agent} />
            </>
          );
        case "chat":
          return (
            <>
              {item.divided && <Hairline inset={68} />}
              <ChatHit hit={item.hit} agent={byId.get(item.hit.agentId)} />
            </>
          );
        case "note":
          return (
            <>
              {item.divided && <Hairline inset={68} />}
              <NoteHit hit={item.hit} agent={byId.get(item.hit.agentId)} />
            </>
          );
        case "automation":
          return (
            <>
              {item.divided && <Hairline inset={68} />}
              <AutomationHit routine={item.routine} />
            </>
          );
        default:
          return (
            <>
              {item.divided && <Hairline inset={68} />}
              <TaskHit hit={item.hit} />
            </>
          );
      }
    },
    [byId],
  );

  const corrected = searching && found.data?.query === q ? found.data.corrected : null;

  return (
    <>
      <Stack.Title>{t("search.title")}</Stack.Title>
      <Stack.SearchBar
        ref={bar}
        autoFocus={!params.q}
        placeholder={t("search.placeholder")}
        hideWhenScrolling={false}
        onChangeText={(e) => setText(e.nativeEvent.text)}
        onCancelButtonPress={() => (router.canGoBack() ? router.back() : setText(""))}
      />
      <FlashList
        data={items}
        keyExtractor={(item) => item.key}
        getItemType={(item) => item.kind}
        renderItem={renderItem}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: 80 }}
        ListHeaderComponent={
          corrected ? (
            <T variant="footnote" muted style={{ paddingHorizontal: space.md, paddingTop: space.sm }}>
              {t("search.showingFor", { query: corrected })}
            </T>
          ) : null
        }
        ListEmptyComponent={
          !searching ? (
            <EmptyState icon="search" title={t("search.emptyTitle")} />
          ) : forbidden ? (
            <EmptyState icon="search" title={t("search.unavailableTitle")} body={t("search.unavailableBody")} />
          ) : found.isError ? (
            <ErrorState title={t("search.failed")} error={errorText(found.error)} onRetry={() => void found.refetch()} />
          ) : found.isLoading || found.isFetching ? (
            <View style={{ paddingTop: space.sm }}>
              <SkeletonRows count={6} avatar={36} />
            </View>
          ) : (
            <EmptyState icon="search" title={t("search.noResultsTitle")} body={t("search.noResultsBody", { query: q })} />
          )
        }
      />
    </>
  );
}

/** A snippet with the matched words stand out. */
function Marked({ text }: { text: string }) {
  const c = useColors();
  return (
    <T variant="subhead" muted numberOfLines={2}>
      {searchSegments(text).map((seg, i) =>
        seg.hit ? (
          <T key={i} variant="subhead" color={c.text} style={{ fontWeight: "600" }}>
            {seg.text}
          </T>
        ) : (
          seg.text
        ),
      )}
    </T>
  );
}

function HitRow({ lead, title, meta, onPress, children }: { lead: ReactNode; title: string; meta?: string; onPress: () => void; children?: ReactNode }) {
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
      {lead}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <T variant="headline" numberOfLines={1} style={{ flexShrink: 1, fontSize: 16 }}>
            {title}
          </T>
          <View style={{ flex: 1 }} />
          {meta ? (
            <T variant="footnote" muted>
              {meta}
            </T>
          ) : null}
        </View>
        {children}
      </View>
    </Pressable>
  );
}

function AgentHit({ agent }: { agent: Agent }) {
  return (
    <HitRow lead={<CharacterAvatar agent={agent} size={36} />} title={agent.name} onPress={() => router.push({ pathname: "/agent/[id]", params: { id: agent.id } })}>
      {agent.role || agent.description ? (
        <T variant="subhead" muted numberOfLines={1}>
          {agent.role || agent.description}
        </T>
      ) : null}
    </HitRow>
  );
}

function ChatHit({ hit, agent }: { hit: SearchChatHit; agent?: Agent }) {
  const { t } = useTranslation("chat");
  const meta = [hit.archived ? t("search.archived") : null, hit.at ? shortTime(hit.at) : null].filter(Boolean).join(" · ");
  return (
    <HitRow
      lead={<CharacterAvatar agent={agent} size={36} />}
      title={hit.title || t("thread.fallbackTitle")}
      meta={meta}
      onPress={() => router.push({ pathname: "/chat/[id]", params: { id: hit.id } })}
    >
      {hit.snippet ? <Marked text={hit.snippet} /> : agent ? (
        <T variant="subhead" muted numberOfLines={1}>
          {agent.name}
        </T>
      ) : null}
    </HitRow>
  );
}

function TaskHit({ hit }: { hit: SearchTaskHit }) {
  const { t } = useTranslation("chat");
  return (
    <HitRow
      lead={
        <View style={styles.lead}>
          <Tile icon="tasks" size={36} />
        </View>
      }
      title={`#${hit.number} ${hit.title}`}
      meta={hit.archived ? t("search.archived") : undefined}
      onPress={() => router.push({ pathname: "/task/[id]", params: { id: hit.id } })}
    >
      {hit.snippet ? <Marked text={hit.snippet} /> : null}
    </HitRow>
  );
}

function NoteHit({ hit, agent }: { hit: SearchNoteHit; agent?: Agent }) {
  return (
    <HitRow
      lead={
        <View style={styles.lead}>
          <Tile icon="doc" size={36} />
        </View>
      }
      title={hit.heading || hit.path.split("/").pop() || hit.path}
      meta={agent?.name}
      onPress={() => router.push({ pathname: "/chat-file", params: { agent: hit.agentId, path: hit.path } })}
    >
      <Marked text={hit.snippet} />
    </HitRow>
  );
}

function AutomationHit({ routine }: { routine: Routine }) {
  const { t } = useTranslation("chat");
  return (
    <HitRow
      lead={
        <View style={styles.lead}>
          <Tile icon="workflow" size={36} />
        </View>
      }
      title={routine.name}
      meta={routine.enabled ? undefined : t("search.off")}
      onPress={() => router.push({ pathname: "/automation/[id]", params: { id: routine.id } })}
    />
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
  lead: { width: 36, alignItems: "center" },
});
