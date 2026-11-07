import { useMutation, useQuery } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useLeaveSettings } from "@/components/agent-actions";
import { Character } from "@/components/character";
import { CloseButton } from "@/components/close-button";
import { Group, PickerRow, SwitchRow } from "@/components/form";
import { Icon } from "@/components/icon";
import { TeamIcon, flatSeats, seatTree, type Seat } from "@/components/team-parts";
import { Badge, Button, EmptyState, ErrorState, LoadingState, Row, T, tap } from "@/components/ui";
import { phoneTimezone } from "@/components/routine-row";
import { api, ApiError, errorText, updateDesktopMessage } from "@/lib/api";
import { qk, queryClient } from "@/lib/query";
import { teamText, templateText } from "@/lib/templates";
import { radius, space, useColors } from "@/lib/theme";
import { useWorkspace, scopeLabel } from "@/lib/workspace";

const NEW = "__new";
const GLOBAL = "__global";
/** Above this many schedules they start switched off: a big chart shouldn't start dozens of runs unasked. */
const MANY_SCHEDULES = 10;
/** Charts this big get the bulk choices. */
const BIG_CHART = 10;

const refused = (err: unknown) => err instanceof ApiError && err.code === "device_forbidden";

/** A whole team or company from a template, like the desktop's install dialog: who to hire, where they work, their schedules. */
export default function TeamInstall() {
  const { t } = useTranslation(["agents", "common"]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const teams = useQuery({ queryKey: qk.teamTemplates, queryFn: api.teams.templates, staleTime: 60 * 60_000 });
  const roles = useQuery({ queryKey: qk.agentTemplates, queryFn: api.agents.templates, staleTime: 60 * 60_000 });
  const team = teams.data?.find((x) => x.id === id);
  const root = useMemo(() => {
    if (!team || !roles.data) return null;
    const byId = new Map(roles.data.map((r) => [r.id, templateText(r)]));
    return seatTree(team.root, byId);
  }, [team, roles.data]);

  if (team && root) return <InstallForm teamId={team.id} kind={team.kind} icon={team.icon} name={teamText(team).name} description={teamText(team).description} root={root} />;
  const error = teams.error ?? roles.error;
  return (
    <View style={{ flex: 1, justifyContent: "center" }}>
      <Stack.Screen options={{ title: t("team.title") }} />
      <CloseButton />
      {error ? (
        <ErrorState title={t("team.loadFailed")} error={refused(error) ? updateDesktopMessage() : errorText(error)} onRetry={refused(error) ? undefined : () => void Promise.all([teams.refetch(), roles.refetch()])} />
      ) : teams.isLoading || roles.isLoading ? (
        <LoadingState />
      ) : (
        <EmptyState icon="orgChart" title={t("team.notFound")} />
      )}
    </View>
  );
}

function InstallForm({ teamId, kind, icon, name, description, root }: { teamId: string; kind: "team" | "company"; icon: string; name: string; description: string; root: Seat }) {
  const c = useColors();
  const { t } = useTranslation(["agents", "common"]);
  const { id: scope, workspaces, select } = useWorkspace();
  const leave = useLeaveSettings();
  const seats = useMemo(() => flatSeats(root), [root]);
  const [where, setWhere] = useState(kind === "company" ? NEW : (scope ?? GLOBAL));
  const [workspaceName, setWorkspaceName] = useState(name);
  const [skip, setSkip] = useState<Set<string>>(() => new Set());
  const [automations, setAutomations] = useState(() => seats.filter((s) => s.template.routine).length <= MANY_SCHEDULES);
  const kept = seats.filter((s) => !skip.has(s.path));
  const scheduled = kept.filter((s) => s.template.routine);
  const leads = seats.filter((s) => s.depth > 0 && s.reports.length > 0);

  const install = useMutation({
    mutationFn: () =>
      api.teams.install(teamId, {
        ...(where === NEW ? { newWorkspace: { name: workspaceName.trim(), color: root.template.color } } : { workspaceId: where === GLOBAL ? null : where }),
        automations: automations && scheduled.length > 0,
        timezone: phoneTimezone() ?? undefined,
        skip: [...skip],
      }),
    onSuccess: (res) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      void queryClient.invalidateQueries({ queryKey: qk.agents });
      void queryClient.invalidateQueries({ queryKey: qk.routines });
      void queryClient.invalidateQueries({ queryKey: qk.bootstrap });
      if (res.workspace) void queryClient.invalidateQueries({ queryKey: qk.workspaces });
      // Show where they went, unless every workspace is on screen anyway.
      const target = res.workspace?.id ?? (where === GLOBAL ? null : where);
      if (scope && scope !== target) select(target);
      leave(() => router.navigate("/agents/org"));
    },
    onError: (err) => Alert.alert(t("team.installFailed", { name }), refused(err) ? updateDesktopMessage() : errorText(err)),
  });

  const toggle = (path: string) =>
    setSkip((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const canInstall = kept.length > 1 && (where !== NEW || workspaceName.trim().length > 0) && !install.isPending;
  const names = scheduled.map((s) => s.template.routine!.name);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={styles.content}
    >
      <Stack.Screen options={{ title: name, headerLargeTitleEnabled: false }} />
      <CloseButton />

      <View style={{ gap: space.sm }}>
        <Row style={{ gap: space.md }}>
          <TeamIcon icon={icon} size={44} />
          <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
            <T variant="title" numberOfLines={2}>
              {name}
            </T>
            <Row style={{ gap: 6 }}>
              <Badge label={kind === "company" ? t("team.company") : t("team.team")} dot={false} />
              <T variant="footnote" muted>
                {t("team.agentCount", { count: seats.length })}
              </T>
            </Row>
          </View>
        </Row>
        <T variant="subhead" muted>
          {description}
        </T>
      </View>

      <View>
        <Row style={styles.chartHead}>
          <T variant="eyebrow" muted style={{ flex: 1 }}>
            {t("team.keptOf", { kept: kept.length, count: seats.length })}
          </T>
          {seats.length > BIG_CHART ? (
            <Row style={{ gap: space.md }}>
              <Bulk label={t("team.everyone")} disabled={!skip.size} onPress={() => setSkip(new Set())} />
              {leads.length > 1 ? <Bulk label={t("team.leadsOnly")} onPress={() => setSkip(new Set(seats.filter((s) => s.depth > 0 && !s.reports.length).map((s) => s.path)))} /> : null}
              <Bulk label={t("team.clear")} disabled={kept.length === 1} onPress={() => setSkip(new Set(seats.slice(1).map((s) => s.path)))} />
            </Row>
          ) : null}
        </Row>
        <View style={[styles.chart, { backgroundColor: c.surface, borderColor: c.border }]}>
          <SeatBranch seat={root} skip={skip} onToggle={toggle} />
        </View>
      </View>

      <Group title={t("team.where")}>
        <PickerRow
          icon="layers"
          title={t("team.workspace")}
          value={where}
          options={[
            { value: NEW, label: t("team.newWorkspace") },
            { value: GLOBAL, label: t("team.global") },
            ...workspaces.map((w) => ({ value: w.id, label: scopeLabel(w) })),
          ]}
          onChange={setWhere}
        />
        {where === NEW ? (
          <View style={styles.nameRow}>
            <T variant="callout" style={{ fontWeight: "500" }}>
              {t("common:words.name")}
            </T>
            <TextInput
              accessibilityLabel={t("team.workspaceName")}
              value={workspaceName}
              onChangeText={setWorkspaceName}
              placeholder={t("team.workspaceName")}
              placeholderTextColor={c.textFaint}
              maxLength={80}
              returnKeyType="done"
              style={[styles.nameInput, { color: c.text }]}
            />
          </View>
        ) : null}
      </Group>

      {scheduled.length > 0 ? (
        <Group footer={names.length > 4 ? t("team.scheduleListMore", { names: names.slice(0, 4).join(", "), count: names.length - 4 }) : t("team.scheduleList", { names: names.join(", ") })}>
          <SwitchRow icon="clock" title={t("team.schedules", { count: scheduled.length })} value={automations} onChange={setAutomations} />
        </Group>
      ) : null}

      <View style={{ gap: space.sm }}>
        <Button title={t("team.hire", { count: kept.length })} icon="plus" size="lg" loading={install.isPending} disabled={!canInstall} onPress={() => install.mutate()} />
        <Row style={{ gap: space.sm, paddingHorizontal: 4 }}>
          <Icon name="lock" size={13} color={c.textMuted} />
          <T variant="footnote" muted style={{ flex: 1 }}>
            {t("team.setupHint")}
          </T>
        </Row>
      </View>
    </ScrollView>
  );
}

function Bulk({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={8}
      onPress={() => {
        tap();
        onPress();
      }}
    >
      <T variant="footnote" color={disabled ? c.textFaint : c.brandStrong} style={{ fontWeight: "600" }}>
        {label}
      </T>
    </Pressable>
  );
}

/** A seat and, below it, its reports on a guide line; every seat but the top can be left out. */
function SeatBranch({ seat, skip, onToggle }: { seat: Seat; skip: Set<string>; onToggle: (path: string) => void }) {
  const c = useColors();
  const { t } = useTranslation("agents");
  const top = seat.depth === 0;
  const off = skip.has(seat.path);
  return (
    <View>
      <Pressable
        accessibilityRole={top ? undefined : "checkbox"}
        accessibilityState={top ? undefined : { checked: !off }}
        accessibilityLabel={`${seat.template.name}, ${seat.template.role}`}
        disabled={top}
        onPress={() => {
          tap();
          onToggle(seat.path);
        }}
        style={({ pressed }) => [styles.seat, pressed && { backgroundColor: c.sunken }]}
      >
        {top ? (
          <View style={styles.check} />
        ) : (
          <View style={[styles.check, styles.box, off ? { borderColor: c.borderStrong } : { backgroundColor: c.primary, borderColor: c.primary }]}>
            {!off ? <Icon name="check" size={11} color={c.onPrimary} weight="bold" /> : null}
          </View>
        )}
        <Character character={seat.template.character} color={seat.template.color} size={30} seed={seat.template.id} style={off ? { opacity: 0.35 } : undefined} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T variant="subhead" numberOfLines={1} color={off ? c.textMuted : c.text} style={[{ fontWeight: "600" }, off && { textDecorationLine: "line-through" }]}>
            {seat.template.name}
          </T>
          <T variant="caption" muted numberOfLines={1}>
            {top ? t("team.reportsToGodmode") : seat.template.role}
          </T>
        </View>
        {seat.template.routine && !off ? <Icon name="clock" size={13} color={c.textMuted} /> : null}
      </Pressable>
      {seat.reports.length ? (
        <View style={[styles.reports, { borderLeftColor: c.border }]}>
          {seat.reports.map((r) => (
            <SeatBranch key={r.path} seat={r} skip={skip} onToggle={onToggle} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
  chartHead: {
    gap: space.md,
    paddingHorizontal: 4,
    paddingBottom: space.sm,
  },
  chart: {
    padding: space.sm,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  seat: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingVertical: 6,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
  check: {
    width: 20,
    height: 20,
  },
  box: {
    borderRadius: 6,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  reports: {
    marginLeft: space.sm + 9,
    paddingLeft: 6,
    borderLeftWidth: StyleSheet.hairlineWidth * 2,
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    minHeight: 50,
  },
  nameInput: {
    flex: 1,
    fontSize: 15,
    textAlign: "right",
    paddingVertical: 12,
  },
});
