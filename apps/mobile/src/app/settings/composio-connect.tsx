import { useInfiniteQuery } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, FlatList, Linking, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { ComposioConnectResult, ComposioToolkit } from "@godmode/shared";
import { CloseButton } from "@/components/close-button";
import { NeedsFullAccessScreen } from "@/components/full-access";
import { FullAccessGate, isRefused } from "@/components/admin";
import { ToolkitLogo } from "@/components/composio-parts";
import { Group } from "@/components/form";
import { Icon } from "@/components/icon";
import { useScopeRows, type Scope } from "@/components/tool-form";
import { Badge, Button, EmptyState, ErrorState, Hairline, SkeletonRows, T, tap } from "@/components/ui";
import { errorText } from "@/lib/api";
import { composioAdmin, refreshComposio, toolkitsKey } from "@/lib/composio-admin";
import { useAgents } from "@/lib/hooks";
import { integrationsApi, useComposioConnections } from "@/lib/integrations";
import { radius, space, useColors } from "@/lib/theme";
import { useWorkspace } from "@/lib/workspace";
import { t as translate } from "@/lib/i18n";

const POLL_MS = 2500;
const TIMEOUT_MS = 5 * 60_000;
const FAILED = new Set(["FAILED", "EXPIRED", "REVOKED", "INACTIVE", "DELETED"]);

type Phase =
  | { kind: "configure" }
  | { kind: "starting" }
  | { kind: "waiting"; result: ComposioConnectResult }
  | { kind: "success" }
  | { kind: "error"; message: string };

/** Connect a Composio app (desktop: toolkit-gallery.tsx and composio-connect-dialog.tsx): pick it, choose who may use it, sign in. */
export default function ComposioConnect() {
  const { t } = useTranslation("integrations");
  const [toolkit, setToolkit] = useState<ComposioToolkit | null>(null);
  return (
    <>
      <Stack.Screen options={{ title: toolkit ? t("composioAdmin.connect.title", { name: toolkit.name }) : t("composioAdmin.gallery.title") }} />
      <CloseButton />
      <FullAccessGate locked={<NeedsFullAccessScreen />}>{toolkit ? <ConnectFlow toolkit={toolkit} onBack={() => setToolkit(null)} /> : <Gallery onPick={setToolkit} />}</FullAccessGate>
    </>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setV(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return v;
}

function Gallery({ onPick }: { onPick: (toolkit: ComposioToolkit) => void }) {
  const c = useColors();
  const { t } = useTranslation("integrations");
  const [input, setInput] = useState("");
  const search = useDebounced(input.trim(), 300);
  const connections = useComposioConnections();
  const query = useInfiniteQuery({
    queryKey: toolkitsKey(search),
    queryFn: ({ pageParam }) => composioAdmin.toolkits({ search: search || undefined, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 5 * 60_000,
  });
  const items = useMemo(() => {
    const seen = new Set<string>();
    return (query.data?.pages ?? [])
      .flatMap((p) => p.items)
      .filter((x) => {
        if (seen.has(x.slug)) return false;
        seen.add(x.slug);
        return true;
      });
  }, [query.data]);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of connections.data ?? []) if (x.status.toUpperCase() === "ACTIVE") m.set(x.toolkit, (m.get(x.toolkit) ?? 0) + 1);
    return m;
  }, [connections.data]);

  return (
    <FlatList
      data={items}
      keyExtractor={(x) => x.slug}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerStyle={styles.list}
      onEndReached={() => void (query.hasNextPage && !query.isFetchingNextPage && query.fetchNextPage())}
      onEndReachedThreshold={0.5}
      ListHeaderComponent={
        <View style={[styles.search, { backgroundColor: c.sunken }]}>
          <Icon name="search" size={15} color={c.textMuted} />
          <TextInput
            accessibilityLabel={t("composioAdmin.gallery.search")}
            value={input}
            onChangeText={setInput}
            placeholder={t("composioAdmin.gallery.search")}
            placeholderTextColor={c.textFaint}
            autoCorrect={false}
            autoCapitalize="none"
            clearButtonMode="while-editing"
            returnKeyType="search"
            style={[styles.searchInput, { color: c.text }]}
          />
        </View>
      }
      ListEmptyComponent={
        query.isLoading ? (
          <SkeletonRows count={8} avatar={36} />
        ) : query.isError ? (
          <ErrorState title={t("composioAdmin.gallery.loadFailed")} error={errorText(query.error)} onRetry={() => void query.refetch()} />
        ) : (
          <EmptyState icon="search" title={search ? t("composioAdmin.gallery.noMatch", { search }) : t("composioAdmin.gallery.none")} />
        )
      }
      ItemSeparatorComponent={() => <Hairline inset={space.lg + 36 + space.md} />}
      ListFooterComponent={query.isFetchingNextPage ? <ActivityIndicator style={{ margin: space.lg }} color={c.textMuted} /> : undefined}
      renderItem={({ item }) => {
        const n = counts.get(item.slug) ?? 0;
        return (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              tap();
              onPick(item);
            }}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
          >
            <ToolkitLogo uri={item.logo} name={item.name} size={36} />
            <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
              <T variant="callout" style={{ fontWeight: "500" }} numberOfLines={1}>
                {item.name}
              </T>
              <T variant="footnote" muted numberOfLines={2}>
                {item.description || t("composioAdmin.gallery.noDescription")}
              </T>
            </View>
            {n ? (
              <Badge label={n > 1 ? t("composioAdmin.gallery.accounts", { n }) : t("composioAdmin.gallery.connected")} tone="success" />
            ) : item.noAuth ? (
              <Badge label={t("composioAdmin.gallery.noSignIn")} dot={false} />
            ) : null}
          </Pressable>
        );
      }}
    />
  );
}

/** Who may use the account, then the app's own sign-in page; the phone waits until Composio says it is connected. */
function ConnectFlow({ toolkit: tk, onBack }: { toolkit: ComposioToolkit; onBack: () => void }) {
  const c = useColors();
  const { t } = useTranslation(["integrations", "common", "components"]);
  const workspace = useWorkspace();
  const [scope, setScope] = useState<Scope>({ workspaceId: workspace.id, agentId: null });
  const [phase, setPhase] = useState<Phase>({ kind: "configure" });
  const scopeRows = useScopeRows(scope, setScope);
  const who = useWho(scope);
  const poke = useRef<() => void>(() => undefined);

  // Asks Composio until the sign-in is done, failed or took too long; coming back to the app asks at once.
  useEffect(() => {
    if (phase.kind !== "waiting") return;
    const started = Date.now();
    let connectionId: string | null = phase.result.connectionId ?? null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stop = false;
    const finish = (next: Phase) => {
      stop = true;
      refreshComposio();
      setPhase(next);
    };
    const tick = async () => {
      if (stop) return;
      if (timer) clearTimeout(timer);
      try {
        if (!connectionId) {
          const list = await integrationsApi.composioConnections();
          connectionId = list.find((x) => x.connectedAccountId === phase.result.connectedAccountId)?.id ?? null;
        }
        if (connectionId) {
          const conn = await composioAdmin.refresh(connectionId);
          const status = conn.status.toUpperCase();
          if (status === "ACTIVE") return finish({ kind: "success" });
          if (FAILED.has(status)) return finish({ kind: "error", message: translate("integrations:composioAdmin.connect.reportedAs", { status: status.toLowerCase() }) });
        }
      } catch (err) {
        if (isRefused(err)) return finish({ kind: "error", message: translate("components:fullAccess.title") });
      }
      if (stop) return;
      if (Date.now() - started > TIMEOUT_MS) return finish({ kind: "error", message: translate("integrations:composioAdmin.connect.timedOut") });
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    poke.current = () => void tick();
    timer = setTimeout(() => void tick(), 1200);
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void tick();
    });
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
      sub.remove();
    };
  }, [phase]);

  const start = async () => {
    setPhase({ kind: "starting" });
    try {
      const result = await composioAdmin.connect({ toolkit: tk.slug, workspaceId: scope.workspaceId, agentId: scope.agentId });
      if (result.redirectUrl) {
        void Linking.openURL(result.redirectUrl);
        setPhase({ kind: "waiting", result });
      } else if (result.status.toUpperCase() === "ACTIVE") {
        refreshComposio();
        setPhase({ kind: "success" });
      } else setPhase({ kind: "waiting", result });
    } catch (err) {
      setPhase({ kind: "error", message: isRefused(err) ? t("components:fullAccess.title") : errorText(err) });
    }
  };

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <View style={styles.hero}>
        <ToolkitLogo uri={tk.logo} name={tk.name} size={56} />
        <T variant="title" style={{ textAlign: "center" }}>
          {tk.name}
        </T>
        {tk.description ? (
          <T variant="subhead" muted style={{ textAlign: "center" }} numberOfLines={3}>
            {tk.description}
          </T>
        ) : null}
      </View>

      {phase.kind === "configure" || phase.kind === "starting" ? (
        <>
          <Group title={t("composioAdmin.connect.whoCanUse")} footer={tk.noAuth ? t("composioAdmin.connect.noAuth") : t("composioAdmin.connect.signInHint", { name: tk.name })}>
            {scopeRows}
          </Group>
          <View style={{ gap: space.sm }}>
            <Button
              title={tk.noAuth ? t("common:actions.enable") : t("composioAdmin.connect.continueTo", { name: tk.name })}
              icon={tk.noAuth ? "check" : "external"}
              loading={phase.kind === "starting"}
              onPress={() => void start()}
            />
            <Button title={t("composioAdmin.connect.otherApp")} variant="secondary" disabled={phase.kind === "starting"} onPress={onBack} />
          </View>
        </>
      ) : null}

      {phase.kind === "waiting" ? (
        <View style={styles.state}>
          <ActivityIndicator color={c.brand} />
          <T variant="headline" style={{ textAlign: "center" }}>
            {t("composioAdmin.connect.waiting")}
          </T>
          <T variant="subhead" muted style={{ textAlign: "center" }}>
            {t("composioAdmin.connect.waitingHint", { name: tk.name })}
          </T>
          {phase.result.redirectUrl ? (
            <Button title={t("composioAdmin.connect.reopen")} icon="external" variant="secondary" onPress={() => void Linking.openURL(phase.result.redirectUrl!)} style={{ alignSelf: "stretch" }} />
          ) : null}
          <Button title={t("composioAdmin.connect.checkNow")} icon="refresh" variant="secondary" onPress={() => poke.current()} style={{ alignSelf: "stretch" }} />
        </View>
      ) : null}

      {phase.kind === "success" ? (
        <View style={styles.state}>
          <View style={[styles.badge, { backgroundColor: c.brandSoft }]}>
            <Icon name="check" size={26} color={c.brandStrong} weight="bold" />
          </View>
          <T variant="headline" style={{ textAlign: "center" }}>
            {t("composioAdmin.connect.isConnected", { name: tk.name })}
          </T>
          <T variant="subhead" muted style={{ textAlign: "center" }}>
            {t("composioAdmin.connect.availableTo", { who })}
          </T>
          <Button title={t("common:actions.done")} onPress={() => router.back()} style={{ alignSelf: "stretch" }} />
        </View>
      ) : null}

      {phase.kind === "error" ? (
        <View style={styles.state}>
          <View style={[styles.badge, { backgroundColor: c.dangerSoft }]}>
            <Icon name="warning" size={24} color={c.danger} />
          </View>
          <T variant="headline" style={{ textAlign: "center" }}>
            {t("composioAdmin.connect.failed", { name: tk.name })}
          </T>
          <T variant="subhead" muted style={{ textAlign: "center" }}>
            {phase.message}
          </T>
          <Button title={t("common:actions.tryAgain")} icon="refresh" onPress={() => setPhase({ kind: "configure" })} style={{ alignSelf: "stretch" }} />
        </View>
      ) : null}
    </ScrollView>
  );
}

function useWho(scope: Scope): string {
  const { t } = useTranslation("integrations");
  const { byId } = useAgents();
  const { workspaces } = useWorkspace();
  if (scope.agentId) return byId.get(scope.agentId)?.name ?? t("composioAdmin.connect.theAgent");
  if (scope.workspaceId) {
    const name = workspaces.find((w) => w.id === scope.workspaceId)?.name;
    return name ? t("composioAdmin.connect.agentsIn", { name }) : t("composioAdmin.connect.theWorkspace");
  }
  return t("composioAdmin.connect.everyAgent");
}

const styles = StyleSheet.create({
  list: {
    paddingBottom: 60,
  },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    marginHorizontal: space.lg,
    marginTop: space.sm,
    marginBottom: space.md,
    paddingHorizontal: space.md,
    height: 40,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
    paddingVertical: 0,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 60,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
  },
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
  hero: {
    alignItems: "center",
    gap: space.sm,
    paddingTop: space.md,
  },
  state: {
    alignItems: "center",
    gap: space.md,
    paddingVertical: space.lg,
  },
  badge: {
    width: 56,
    height: 56,
    borderRadius: 18,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
});
