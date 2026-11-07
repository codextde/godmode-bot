import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { router, useIsFocused, useLocalSearchParams } from "expo-router";
import { useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { computerTargetLabel, computerView, sameComputerTarget, type ComputerSources, type ComputerTarget } from "@godmode/shared";
import { AppTile, useComputerSources } from "@/components/computer-parts";
import { Group, LinkRow, Segmented, SwitchRow } from "@/components/form";
import { NeedsFullAccess, useFullAccess } from "@/components/full-access";
import { Icon, type IconName } from "@/components/icon";
import { Button, EmptyState, ErrorState, Hairline, Skeleton, T, tap } from "@/components/ui";
import { errorText } from "@/lib/api";
import { fetchConversation } from "@/lib/chat-cache";
import { changeChatWork } from "@/lib/chat-extras";
import { useNewChatOptions } from "@/lib/chat-options";
import { useAgents } from "@/lib/hooks";
import { hostOfUrl } from "@/lib/integrations";
import { currentLanguage } from "@/lib/i18n";
import { displayTarget, machinesApi, mk, sortedDisplays, sourceHref, tabTarget, windowTarget } from "@/lib/machines";
import { qk } from "@/lib/query";
import { settingsApi, sq } from "@/lib/settings-api";
import { radius, space, type, useColors } from "@/lib/theme";

type Kind = "window" | "screen" | "tab";

const kindOf = (target: ComputerTarget | null): Kind => (target?.kind === "tab" ? "tab" : target?.kind === "desktop" || target?.kind === "display" ? "screen" : "window");

/** Share a window, a screen or a browser tab with a chat: what its agent may see and control. */
export default function ChatScreenSheet() {
  const c = useColors();
  const { t } = useTranslation(["chat", "common"]);
  const { conversationId = "", agentId } = useLocalSearchParams<{ conversationId?: string; agentId?: string }>();
  const { fullAccess } = useFullAccess();
  const conversation = useQuery({ queryKey: qk.conversation(conversationId), queryFn: () => fetchConversation(conversationId), enabled: !!conversationId, staleTime: Infinity });
  const { byId } = useAgents();
  const newChatTarget = useNewChatOptions((s) => s.options.computerTarget);
  const current = conversationId ? (conversation.data?.computerTarget ?? null) : newChatTarget;
  const agent = byId.get(conversation.data?.agentId ?? agentId ?? "");
  const status = useQuery({ queryKey: sq.computerStatus, queryFn: settingsApi.computer.status, enabled: fullAccess === true });
  const off = status.data?.enabled === false;
  const sources = useComputerSources(fullAccess === true && !off);
  const [kind, setKind] = useState<Kind>(kindOf(current));
  const [query, setQuery] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [busy, setBusy] = useState(false);

  const share = (target: ComputerTarget | null) => {
    if (busy) return;
    tap();
    if (target && sameComputerTarget(target, current)) return router.back();
    if (!conversationId) {
      useNewChatOptions.getState().set({ computerTarget: target });
      return router.back();
    }
    setBusy(true);
    changeChatWork(conversationId, { computerTarget: target })
      .then(() => router.back())
      .catch((err: unknown) => {
        setBusy(false);
        Alert.alert(t("shareScreen.changeFailed"), errorText(err));
      });
  };

  if (fullAccess === false) {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <NeedsFullAccess />
      </View>
    );
  }
  const data = sources.data;
  const note = kind === "window" ? t("shareScreen.noteWindow") : kind === "tab" ? t("shareScreen.noteTab") : t("shareScreen.noteDesktop");
  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <T variant="title">{t("shareScreen.title", { name: agent?.name ?? t("shareScreen.theAgent") })}</T>
      {current ? (
        <Group>
          {conversationId ? <LinkRow icon="eye" title={t("shareScreen.watch")} value={computerTargetLabel(current, currentLanguage())} onPress={() => router.push(sourceHref(current))} /> : null}
          <LinkRow icon="close" title={t("shareScreen.stop")} tone="danger" chevron={false} onPress={() => share(null)} />
        </Group>
      ) : null}
      {off ? (
        <EmptyState icon="display" title={t("shareScreen.off")} action={<Button title={t("shareScreen.turnOn")} variant="secondary" onPress={() => router.push("/settings/computer")} />} />
      ) : (
        <>
          <Segmented
            options={[
              { value: "window", label: t("shareScreen.window") },
              { value: "screen", label: t("shareScreen.screen") },
              { value: "tab", label: t("shareScreen.tab") },
            ]}
            value={kind}
            onChange={(next: Kind) => {
              setKind(next);
              setQuery("");
            }}
          />
          <T variant="footnote" muted style={{ paddingHorizontal: 4 }}>
            {note}
          </T>
          {kind !== "screen" ? (
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={t("shareScreen.search")}
              placeholderTextColor={c.textFaint}
              autoCorrect={false}
              clearButtonMode="while-editing"
              returnKeyType="search"
              accessibilityLabel={t("shareScreen.search")}
              style={[type.body, styles.search, { backgroundColor: c.sunken, color: c.text }]}
            />
          ) : null}
          {data?.problems.map((problem) => (
            <View key={problem} style={[styles.problem, { backgroundColor: c.warningSoft }]}>
              <Icon name="warning" size={14} color={c.warning} />
              <T variant="footnote" style={{ flex: 1 }}>
                {problem}
              </T>
            </View>
          ))}
          {!data ? (
            sources.isError ? (
              <ErrorState title={t("shareScreen.loadFailed")} error={errorText(sources.error)} onRetry={() => void sources.refetch()} />
            ) : (
              <View style={{ gap: space.sm }} accessibilityRole="progressbar">
                <Skeleton height={64} radius={14} />
                <Skeleton height={64} radius={14} />
                <Skeleton height={64} radius={14} />
              </View>
            )
          ) : kind === "window" ? (
            <Windows data={data} query={query} showHidden={showHidden} onShowHidden={setShowHidden} current={current} onPick={share} />
          ) : kind === "screen" ? (
            <Screens data={data} current={current} onPick={share} />
          ) : (
            <Tabs data={data} query={query} current={current} onPick={share} />
          )}
        </>
      )}
      {busy ? <ActivityIndicator color={c.textFaint} /> : null}
    </ScrollView>
  );
}

type Pick = { current: ComputerTarget | null; onPick: (target: ComputerTarget) => void };

function Windows({ data, query, showHidden, onShowHidden, current, onPick }: Pick & { data: ComputerSources; query: string; showHidden: boolean; onShowHidden: (on: boolean) => void }) {
  const { t } = useTranslation("chat");
  const q = query.trim().toLowerCase();
  const hidden = data.windows.filter((w) => !w.onScreen).length;
  const list = data.windows
    .filter((w) => showHidden || w.onScreen)
    .filter((w) => !q || w.app.toLowerCase().includes(q) || w.title.toLowerCase().includes(q))
    .sort((a, b) => Number(b.onScreen) - Number(a.onScreen) || a.app.localeCompare(b.app));
  return (
    <>
      <Sources empty={q ? t("shareScreen.noWindowMatch", { query }) : t("shareScreen.noWindows")}>
        {list.map((w) => {
          const target = windowTarget(w);
          return (
            <Source
              key={`${w.pid}:${w.id}`}
              target={target}
              lead={<AppTile app={w.app} />}
              icon="screens"
              title={w.app}
              detail={w.title}
              badge={w.onScreen ? undefined : t("shareScreen.hidden")}
              selected={sameComputerTarget(current, target)}
              onPress={() => onPick(target)}
            />
          );
        })}
      </Sources>
      {hidden > 0 ? (
        <Group>
          <SwitchRow title={t("shareScreen.hiddenWindows", { n: hidden })} value={showHidden} onChange={onShowHidden} />
        </Group>
      ) : null}
    </>
  );
}

function Screens({ data, current, onPick }: Pick & { data: ComputerSources }) {
  const { t } = useTranslation(["chat", "machines"]);
  const many = data.displays.length > 1;
  const desktop: ComputerTarget = { kind: "desktop" };
  return (
    <Sources empty={t("shareScreen.noDisplays")}>
      {many ? (
        <Source target={desktop} icon="layers" title={t("machines:computer.entireDesktop")} detail={t("machines:computer.displayCount", { count: data.displays.length })} selected={current?.kind === "desktop"} onPress={() => onPick(desktop)} />
      ) : null}
      {sortedDisplays(data.displays).map((d) => {
        // One display is the whole desktop.
        const target = many ? displayTarget(d) : desktop;
        return (
          <Source
            key={d.id}
            target={displayTarget(d)}
            icon="display"
            title={d.name}
            detail={`${Math.round(d.width)} × ${Math.round(d.height)}${d.primary ? ` · ${t("machines:computer.main")}` : ""}`}
            selected={sameComputerTarget(current, target)}
            onPress={() => onPick(target)}
          />
        );
      })}
    </Sources>
  );
}

function Tabs({ data, query, current, onPick }: Pick & { data: ComputerSources; query: string }) {
  const { t } = useTranslation("chat");
  const q = query.trim().toLowerCase();
  const list = data.tabs.filter((tab) => !q || tab.title.toLowerCase().includes(q) || tab.url.toLowerCase().includes(q));
  return (
    <Sources empty={data.tabs.length ? t("shareScreen.noTabMatch", { query }) : t("shareScreen.noBrowser")}>
      {list.map((tab) => {
        const target = tabTarget(tab);
        const host = hostOfUrl(tab.url);
        return (
          <Source
            key={`${tab.profileId}:${tab.targetId}`}
            target={target}
            icon="globe"
            title={tab.title || host || t("shareScreen.newTab")}
            detail={`${tab.profileName} · ${host || tab.url}`}
            selected={sameComputerTarget(current, target)}
            onPress={() => onPick(target)}
          />
        );
      })}
    </Sources>
  );
}

function Sources({ empty, children }: { empty: string; children: ReactNode[] | ReactNode }) {
  const c = useColors();
  const rows = (Array.isArray(children) ? children.flat() : [children]).filter(Boolean);
  if (!rows.length) {
    return (
      <T variant="subhead" muted style={{ textAlign: "center", paddingVertical: space.xl }}>
        {empty}
      </T>
    );
  }
  return (
    <View style={[styles.list, { backgroundColor: c.surface }]}>
      {rows.map((row, i) => (
        <View key={i}>
          {i > 0 ? <Hairline inset={92} /> : null}
          {row}
        </View>
      ))}
    </View>
  );
}

/** A window, screen or tab with a small picture of what it shows; a tap shares it. */
function Source({
  target,
  lead,
  icon,
  title,
  detail,
  badge,
  selected,
  onPress,
}: {
  target: ComputerTarget;
  lead?: ReactNode;
  icon: IconName;
  title: string;
  detail?: string;
  badge?: string;
  selected: boolean;
  onPress: () => void;
}) {
  const c = useColors();
  const focused = useIsFocused();
  const view = computerView(target);
  const shot = useQuery({
    queryKey: mk.thumbnail(view),
    queryFn: () => machinesApi.computer.thumbnail(view, 240),
    enabled: focused,
    refetchInterval: focused ? 8_000 : false,
    staleTime: 8_000,
    placeholderData: (prev) => prev,
    retry: false,
  });
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={detail ? `${title}, ${detail}` : title} onPress={onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}>
      <View style={[styles.thumb, { backgroundColor: c.sunken }]}>
        {shot.data ? (
          <Image source={{ uri: `data:${shot.data.mime};base64,${shot.data.data}` }} style={StyleSheet.absoluteFill} contentFit="cover" contentPosition="top" cachePolicy="none" />
        ) : (
          (lead ?? <Icon name={icon} size={18} color={c.textFaint} />)
        )}
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <T variant="subhead" numberOfLines={1} style={{ fontWeight: "500" }}>
          {title}
        </T>
        {detail ? (
          <T variant="caption" muted numberOfLines={1}>
            {detail}
          </T>
        ) : null}
      </View>
      {badge ? (
        <T variant="caption" muted>
          {badge}
        </T>
      ) : null}
      {selected ? <Icon name="check" size={15} color={c.brandStrong} weight="bold" /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: "center", padding: space.lg },
  content: { padding: space.xl, paddingBottom: 48, gap: space.md },
  search: { height: 40, paddingHorizontal: space.md, borderRadius: radius.sm, borderCurve: "continuous" },
  problem: { flexDirection: "row", gap: space.sm, padding: space.md, borderRadius: radius.sm, borderCurve: "continuous" },
  list: { borderRadius: radius.lg, borderCurve: "continuous", overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.md, paddingVertical: 10 },
  thumb: { width: 64, height: 42, borderRadius: 7, borderCurve: "continuous", overflow: "hidden", alignItems: "center", justifyContent: "center" },
});
