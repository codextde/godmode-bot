import { useMutation, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { BotCheckReport, BotCheckStatus, BrowserProfile } from "@godmode/shared";
import { CloseButton } from "@/components/close-button";
import { Group, LinkRow, StepperRow, SwitchRow, Tile } from "@/components/form";
import { MenuSheet, type HeaderMenuItem } from "@/components/header-actions";
import { Icon, type IconName } from "@/components/icon";
import { FormSkeleton, isOutdated } from "@/components/settings-state";
import { Badge, ErrorState, LiveDot, Row, Skeleton, T, tap } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { t as translate } from "@/lib/i18n";
import { qk, queryClient } from "@/lib/query";
import { settingsApi } from "@/lib/settings-api";
import { patchSettings, useSettings } from "@/lib/setup";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { fonts, radius, space, useColors } from "@/lib/theme";
import { useWorkspace } from "@/lib/workspace";

const IDLE = [0, 5, 10, 15, 30, 60, 120, 240, 480, 1440] as const;

function minutes(n: number): string {
  if (n === 0) return translate("common:words.never");
  return n < 60 ? `${n} min` : `${n / 60} h`;
}

const botCheckKey = (profileId: string) => ["bot-check", profileId];

/** The browser agents use: its switches and its profiles (made, renamed, made the default, stopped, checked, deleted). */
export default function BrowserSettings() {
  const { t } = useTranslation(["settings", "common"]);
  const settings = useSettings();
  const profiles = useQuery({ queryKey: qk.browserProfiles, queryFn: api.browser.profiles });
  const pull = usePullRefresh(() => Promise.all([settings.refetch(), profiles.refetch()]));
  const [naming, setNaming] = useState<{ profile: BrowserProfile | null } | null>(null);
  const s = settings.data;

  const refresh = () => void queryClient.invalidateQueries({ queryKey: qk.browserProfiles });
  const create = (name: string) =>
    settingsApi.browser
      .create(name)
      .then(refresh)
      .catch((err) => Alert.alert(t("browser.createFailed"), errorText(err)));
  const rename = (profile: BrowserProfile, name: string) =>
    settingsApi.browser
      .rename(profile.id, name)
      .then(refresh)
      .catch((err) => Alert.alert(t("browser.renameFailed"), errorText(err)));
  const askName = (profile: BrowserProfile | null) => {
    if (process.env.EXPO_OS !== "ios") return setNaming({ profile });
    Alert.prompt(
      profile ? t("browser.renameTitle") : t("browser.newTitle"),
      undefined,
      (text) => {
        const name = text.trim();
        if (name) void (profile ? rename(profile, name) : create(name));
      },
      "plain-text",
      profile?.name ?? "",
    );
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl {...pull} />}
    >
      <Stack.Screen options={{ title: t("browser.title") }} />
      <CloseButton />
      {!s ? (
        settings.isError ? (
          <ErrorState title={t("browser.loadFailed")} error={errorText(settings.error)} onRetry={() => void settings.refetch()} />
        ) : (
          <FormSkeleton groups={2} rows={4} />
        )
      ) : (
        <>
          <Group>
            <SwitchRow icon="globe" title={t("capabilities.browser.enabled")} value={s.browser.enabled} onChange={(enabled) => void patchSettings({ browser: { enabled } })} />
            <SwitchRow
              icon="eye"
              title={t("capabilities.browser.headless")}
              disabled={!s.browser.enabled}
              value={s.browser.headless}
              onChange={(headless) => void patchSettings({ browser: { headless } })}
            />
            <SwitchRow
              icon="shield"
              title={t("capabilities.browser.stealth")}
              disabled={!s.browser.enabled}
              value={s.browser.stealth}
              onChange={(stealth) => void patchSettings({ browser: { stealth } })}
            />
            <SwitchRow
              icon="key"
              title={t("browser.passkeys")}
              disabled={!s.browser.enabled}
              value={s.browser.passkeys}
              onChange={(passkeys) => void patchSettings({ browser: { passkeys } })}
            />
            <SwitchRow icon="bell" title={t("capabilities.browser.mute")} disabled={!s.browser.enabled} value={s.browser.muteAudio} onChange={(muteAudio) => void patchSettings({ browser: { muteAudio } })} />
            <SwitchRow
              icon="screens"
              title={t("capabilities.liveView")}
              disabled={!s.browser.enabled}
              value={s.browser.liveView}
              onChange={(liveView) => void patchSettings({ browser: { liveView } })}
            />
            <StepperRow
              icon="clock"
              title={t("browser.keepAlive")}
              value={s.browser.keepAliveMinutes}
              min={0}
              max={1440}
              steps={IDLE}
              format={minutes}
              onChange={(keepAliveMinutes) => void patchSettings({ browser: { keepAliveMinutes } })}
            />
          </Group>

          <Profiles query={profiles} disabled={!s.browser.enabled} onName={askName} />
        </>
      )}
      <NameSheet
        open={!!naming}
        title={naming?.profile ? t("browser.renameTitle") : t("browser.newTitle")}
        initial={naming?.profile?.name ?? ""}
        onClose={() => setNaming(null)}
        onSave={(name) => {
          const target = naming?.profile ?? null;
          setNaming(null);
          void (target ? rename(target, name) : create(name));
        }}
      />
    </ScrollView>
  );
}

function Profiles({
  query,
  disabled,
  onName,
}: {
  query: UseQueryResult<BrowserProfile[]>;
  disabled: boolean;
  onName: (profile: BrowserProfile | null) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const { workspaces } = useWorkspace();
  const [menu, setMenu] = useState<BrowserProfile | null>(null);
  const check = useMutation({
    mutationFn: (id: string) => settingsApi.browser.botCheck(id),
    onSuccess: (report) => {
      queryClient.setQueryData(botCheckKey(report.profileId), report);
      void queryClient.invalidateQueries({ queryKey: qk.browserProfiles });
    },
    onError: (err) => Alert.alert(t("browser.botCheck.failed"), errorText(err)),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: qk.browserProfiles });
  const fail = (title: string) => (err: unknown) => Alert.alert(title, errorText(err));

  if (isOutdated(query.error)) return null;
  const list = query.data ?? [];
  const workspaceName = (id: string | null) => (id ? workspaces.find((w) => w.id === id)?.name : null);
  const globalDefault = (p: BrowserProfile) => p.isDefault && !p.workspaceId;

  const remove = (p: BrowserProfile) =>
    Alert.alert(t("browser.deleteTitle", { name: p.name }), t("browser.deleteBody"), [
      { text: t("common:actions.cancel"), style: "cancel" },
      {
        text: t("common:actions.delete"),
        style: "destructive",
        onPress: () => {
          queryClient.setQueryData<BrowserProfile[]>(qk.browserProfiles, (l) => l?.filter((x) => x.id !== p.id));
          settingsApi.browser.remove(p.id).then(refresh, (err) => {
            refresh();
            fail(t("browser.deleteFailed"))(err);
          });
        },
      },
    ]);

  const items = (p: BrowserProfile): HeaderMenuItem[] => [
    { icon: "pencil", title: t("common:actions.rename"), onPress: () => onName(p) },
    ...(p.isDefault ? [] : [{ icon: "check" as IconName, title: t("browser.makeDefault"), onPress: () => void settingsApi.browser.makeDefault(p.id).then(refresh, fail(t("browser.defaultFailed"))) }]),
    ...(p.running ? [{ icon: "stop" as IconName, title: t("common:actions.stop"), onPress: () => void settingsApi.browser.stop(p.id).then(refresh, fail(t("browser.stopFailed"))) }] : []),
    ...(disabled ? [] : [{ icon: "shield" as IconName, title: t("browser.botCheck.run"), onPress: () => check.mutate(p.id) }]),
    ...(globalDefault(p) ? [] : [{ icon: "trash" as IconName, title: t("common:actions.delete"), destructive: true, onPress: () => remove(p) }]),
  ];

  return (
    <>
      <Group title={t("browser.profiles")}>
        {query.isLoading
          ? [0, 1].map((i) => <ProfileSkeleton key={i} />)
          : query.isError
            ? [
                <View key="error" style={styles.inlineError}>
                  <T variant="subhead" muted style={{ textAlign: "center" }}>
                    {errorText(query.error)}
                  </T>
                </View>,
              ]
            : list.map((p) => (
                <ProfileRow key={p.id} profile={p} workspace={workspaceName(p.workspaceId)} checking={check.isPending && check.variables === p.id} onPress={() => setMenu(p)} />
              ))}
        <LinkRow icon="plus" tone="brand" chevron={false} title={t("browser.newProfile")} onPress={() => onName(null)} />
      </Group>
      {list.map((p) => (
        <BotCheckResult key={p.id} profile={p} checking={check.isPending && check.variables === p.id} />
      ))}
      <MenuSheet items={menu ? items(menu) : []} open={!!menu} onClose={() => setMenu(null)} />
    </>
  );
}

function ProfileRow({ profile: p, workspace, checking, onPress }: { profile: BrowserProfile; workspace?: string | null; checking: boolean; onPress: () => void }) {
  const c = useColors();
  const { t } = useTranslation("settings");
  const detail = [
    p.running ? (p.chats.length ? t("browser.runningChats", { count: p.chats.length }) : t("browser.running")) : null,
    workspace,
    p.cookieCount ? t("browser.cookies", { count: p.cookieCount }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={t("browser.actionsHint")}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
    >
      <Tile icon="globe" />
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Row style={{ gap: space.sm }}>
          <T variant="callout" numberOfLines={1} style={{ flexShrink: 1, fontWeight: "500" }}>
            {p.name}
          </T>
          {p.isDefault ? <Badge label={t("browser.default")} tone="brand" dot={false} /> : null}
        </Row>
        {detail ? (
          <T variant="footnote" muted numberOfLines={1}>
            {detail}
          </T>
        ) : null}
      </View>
      {checking ? <ActivityIndicator size="small" color={c.textMuted} /> : p.running ? <LiveDot size={7} /> : null}
      <Icon name="more" size={16} color={c.textFaint} />
    </Pressable>
  );
}

function ProfileSkeleton() {
  return (
    <View style={styles.row}>
      <Skeleton width={30} height={30} radius={9} />
      <View style={{ flex: 1, gap: 6 }}>
        <Skeleton width="40%" height={13} />
        <Skeleton width="25%" height={10} />
      </View>
    </View>
  );
}

const STATUS_ICON: Record<BotCheckStatus, IconName> = { pass: "checkCircle", warn: "warning", fail: "closeCircle" };

/** What a site's bot detection saw in the profile's browser, from the last check on this phone. */
function BotCheckResult({ profile, checking }: { profile: BrowserProfile; checking: boolean }) {
  const c = useColors();
  const { t } = useTranslation("settings");
  const { data: report } = useQuery<BotCheckReport | null>({ queryKey: botCheckKey(profile.id), queryFn: () => null, enabled: false, initialData: null, staleTime: Infinity });
  if (!report && !checking) return null;
  const tint = (s: BotCheckStatus) => (s === "pass" ? c.success : s === "warn" ? c.warning : c.danger);
  const fails = report?.checks.filter((x) => x.status === "fail").length ?? 0;
  const warns = report?.checks.filter((x) => x.status === "warn").length ?? 0;
  const verdict = fails ? t("browser.botCheck.verdictFail", { count: fails }) : warns ? t("browser.botCheck.verdictWarn") : t("browser.botCheck.verdictPass");
  return (
    <Group title={t("browser.botCheck.title", { name: profile.name })}>
      <Row style={styles.verdict}>
        {report ? <Icon name={fails ? "warning" : "shield"} size={22} color={fails ? c.danger : c.success} /> : <ActivityIndicator color={c.textMuted} />}
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <T variant="callout" style={{ fontWeight: "600" }}>
            {report ? verdict : t("browser.botCheck.checking")}
          </T>
          <T variant="footnote" muted numberOfLines={2}>
            {report
              ? [
                  report.browser.replace("/", " "),
                  report.headless ? t("browser.botCheck.headless") : t("browser.botCheck.visible"),
                  report.stealth ? t("browser.botCheck.stealthOn") : t("browser.botCheck.stealthOff"),
                ].join(" · ")
              : t("browser.botCheck.opening")}
          </T>
        </View>
      </Row>
      {(report?.checks ?? []).map((item) => (
        <Row key={item.id} style={styles.check}>
          <Icon name={STATUS_ICON[item.status]} size={16} color={tint(item.status)} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <T variant="subhead" style={{ fontWeight: "500" }}>
              {item.label}
            </T>
            {item.detail ? (
              <T variant="footnote" muted>
                {item.detail}
              </T>
            ) : null}
          </View>
        </Row>
      ))}
    </Group>
  );
}

/** Android has no text prompt: the name is typed in a small dialog instead. */
function NameSheet({ open, title, initial, onClose, onSave }: { open: boolean; title: string; initial: string; onClose: () => void; onSave: (name: string) => void }) {
  const c = useColors();
  const { t } = useTranslation("common");
  const [text, setText] = useState(initial);
  const save = () => text.trim() && onSave(text.trim());
  return (
    <Modal visible={open} transparent animationType="fade" onShow={() => setText(initial)} onRequestClose={onClose}>
      <Pressable accessibilityLabel={t("actions.close")} onPress={onClose} style={[StyleSheet.absoluteFill, { backgroundColor: c.scrim }]} />
      <View style={styles.dialogWrap} pointerEvents="box-none">
        <View style={[styles.dialog, { backgroundColor: c.surface }]}>
          <T variant="headline">{title}</T>
          <TextInput
            autoFocus
            value={text}
            onChangeText={setText}
            maxLength={80}
            onSubmitEditing={save}
            returnKeyType="done"
            style={[styles.input, { color: c.text, borderColor: c.border, backgroundColor: c.sunken }]}
          />
          <Row style={{ justifyContent: "flex-end", gap: space.lg }}>
            <Pressable accessibilityRole="button" hitSlop={8} onPress={onClose}>
              <T variant="callout" muted>
                {t("actions.cancel")}
              </T>
            </Pressable>
            <Pressable accessibilityRole="button" hitSlop={8} disabled={!text.trim()} onPress={save}>
              <T variant="callout" color={text.trim() ? c.brandStrong : c.textFaint} style={{ fontWeight: "600" }}>
                {t("actions.save")}
              </T>
            </Pressable>
          </Row>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 52,
    paddingHorizontal: space.lg,
    paddingVertical: 11,
  },
  inlineError: {
    paddingVertical: space.lg,
    paddingHorizontal: space.lg,
  },
  verdict: {
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 14,
  },
  check: {
    alignItems: "flex-start",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
  },
  dialogWrap: {
    flex: 1,
    justifyContent: "center",
    padding: space.xl,
  },
  dialog: {
    borderRadius: radius.xl,
    borderCurve: "continuous",
    padding: space.xl,
    gap: space.lg,
  },
  input: {
    fontFamily: fonts.regular,
    fontSize: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: 10,
  },
});
