import { isOverdue, isWaiting, mergesOnApprove, reopenStatus, waitsForAnswer, waitsForSubtasks, waitsForTickets } from "@godmode/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { format, formatDistanceToNowStrict } from "date-fns";
import { useMemo, useState, type ReactNode } from "react";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Alert, Linking, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Task, TaskStatus } from "@godmode/shared";
import { CharacterAvatar } from "@/components/character";
import { Composer } from "@/components/composer";
import { Icon } from "@/components/icon";
import { Markdown } from "@/components/markdown";
import { openChat } from "@/components/rows";
import { ProjectPicker } from "@/components/project-picker";
import { STATUS_META, TaskStatusBadge, TYPE_META } from "@/components/task-row";
import { TaskTimeline } from "@/components/task-timeline";
import { Badge, Button, Card, ErrorState, Row, SectionTitle, Skeleton, T, tap, UnassignedAvatar } from "@/components/ui";
import { ApiError, api, errorText } from "@/lib/api";
import { encodeFiles, type PendingFile } from "@/lib/attachments";
import { BLOCKED_TITLE, dueLabel, formatWork, isWorking, PRIORITY_LABEL, taskRepoLabel } from "@/lib/desktop-parity";
import { activityText, hostOf } from "@/lib/format";
import { useAgents } from "@/lib/hooks";
import { dateLocale } from "@/lib/i18n";
import { qk, queryClient } from "@/lib/query";
import { agentsFor, useWorkspace } from "@/lib/workspace";
import { radius, space, useColors } from "@/lib/theme";

/** A task: what it's about, how far its agent got, and the buttons to move it along. */
export default function TaskScreen() {
  const c = useColors();
  const { t: tr } = useTranslation(["tasks", "common"]);
  const { id } = useLocalSearchParams<{ id: string }>();
  // The board already has the ticket, without its long texts: the screen opens from that copy while the whole one loads.
  const seed = useMemo(() => boardTicket(id), [id]);
  const task = useQuery({ queryKey: qk.task(id), queryFn: () => api.tasks.get(id), placeholderData: seed });
  const { data: agents, byId } = useAgents();
  const { workspaces, id: pickedWorkspace } = useWorkspace();
  const [picking, setPicking] = useState(false);

  const onDone = (next: Task) => {
    queryClient.setQueryData(qk.task(id), next);
    void queryClient.invalidateQueries({ queryKey: [...qk.tasks, "list"] });
  };
  const update = useMutation({
    mutationFn: (patch: { status?: TaskStatus; agentId?: string | null; archived?: boolean; projectId?: string | null }) => api.tasks.update(id, patch),
    onSuccess: onDone,
    onError: (err, patch) =>
      Alert.alert(
        tr("task.changeFailed"),
        err instanceof ApiError && err.code === "device_forbidden" && patch.projectId !== undefined ? tr("task.projectNeedsUpdate") : errorText(err),
      ),
  });
  const approve = useMutation({
    mutationFn: () => api.tasks.approve(id),
    onSuccess: (next) => {
      onDone(next);
      if (next.pullRequest?.state === "open") Alert.alert(tr("task.queuedToMerge", { number: next.pullRequest.number }), tr("task.queuedToMergeBody"));
    },
    onError: (err) => {
      // A computer on an older Godmode: approving only marks it done.
      if (err instanceof ApiError && err.status === 404) return update.mutate({ status: "done" });
      if (!(err instanceof ApiError && err.code === "merge_failed")) return Alert.alert(tr("task.approveFailed"), errorText(err));
      Alert.alert(tr("task.mergeFailed", { number: task.data?.pullRequest?.number ?? "" }), errorText(err), [
        { text: tr("common:actions.cancel"), style: "cancel" },
        { text: tr("task.markDoneAnyway"), onPress: () => update.mutate({ status: "done" }) },
      ]);
    },
  });

  const gone = task.error instanceof ApiError && task.error.status === 404;
  const t = task.data ?? (gone ? undefined : seed);
  if (!t) {
    if (!task.isError) return <TaskSkeleton />;
    return (
      <View style={{ flex: 1, justifyContent: "center" }}>
        <Stack.Title>{tr("task.notFound")}</Stack.Title>
        <ErrorState title={tr("task.openFailed")} error={errorText(task.error)} onRetry={() => void task.refetch()} />
      </View>
    );
  }

  // A board's copy has no description and a clipped result; one a live event put there is whole.
  const slim = (!task.data || task.isPlaceholderData) && !t.description;
  const unrefreshed = (!task.data || task.isPlaceholderData) && task.isError && !task.isFetching;
  const whole = !slim;
  const loadingTexts = slim && !unrefreshed;

  const agent = t.agentId ? byId.get(t.agentId) : undefined;
  const workspace = workspaces.find((w) => w.id === t.workspaceId);
  const projects = workspace?.projects ?? [];
  const project = projects.find((p) => p.id === t.projectId);
  const pickProject = () => {
    tap();
    setPicking((v) => !v);
  };
  // In progress isn't working: the ticket may wait for its follow-up, for an answer, or stand still.
  const working = t.status === "in_progress" && (t.runStatus === "running" || t.runStatus === "queued" || !!t.activity);
  const waiting = t.status === "in_progress" && (isWaiting(t) || waitsForAnswer(t) || !!t.pause);
  const canFollowUp =
    !!t.conversationId && !!t.agentId && !t.archivedAt && (t.status === "in_review" || t.status === "blocked" || t.status === "done" || isWaiting(t));
  const assignable = agentsFor(agents ?? [], t.workspaceId).filter((a) => a.enabled);
  const filedAt = format(new Date(t.createdAt), tr("task.filedFormat"), { locale: dateLocale() });
  const filer = t.createdBy === "user" ? undefined : agents?.find((a) => `agent:${a.id}` === t.createdBy)?.name;
  const filedLine =
    t.createdBy === "user" ? tr("task.filedByYou", { date: filedAt }) : filer ? tr("task.filedBy", { name: filer, date: filedAt }) : tr("task.filedByAgent", { date: filedAt });

  const move = (status: TaskStatus) => {
    tap();
    if (status === "done" && mergesOnApprove(t)) return approve.mutate();
    if (!(working || waiting) || status === "in_progress") return update.mutate({ status });
    Alert.alert(
      tr("task.stopAgentTitle"),
      working
        ? tr("task.stopWorking", { agent: agent?.name ?? tr("task.theAgent"), status: STATUS_META[status].label })
        : tr("task.stopWaiting", { status: STATUS_META[status].label }),
      [
        { text: tr("task.keepWorking"), style: "cancel" },
        { text: tr("common:actions.stop"), style: "destructive", onPress: () => update.mutate({ status }) },
      ],
    );
  };

  const archive = (archived: boolean) => {
    tap();
    if (!archived || !working) return update.mutate({ archived });
    Alert.alert(tr("task.stopAgentTitle"), tr("task.stopArchiving", { agent: agent?.name ?? tr("task.theAgent") }), [
      { text: tr("task.keepWorking"), style: "cancel" },
      { text: tr("task.stopAndArchive"), style: "destructive", onPress: () => update.mutate({ archived }) },
    ]);
  };

  const followUp = async (content: string, files: PendingFile[]) => {
    try {
      onDone(await api.tasks.message(id, content, await encodeFiles(files)));
    } catch (err) {
      Alert.alert(tr("task.sendFailed"), errorText(err));
      throw err;
    }
  };

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <Stack.Title>{`#${t.number}`}</Stack.Title>

      <View style={{ gap: space.sm }}>
        <T variant="title">{t.title}</T>
        <Row style={{ gap: 6, flexWrap: "wrap" }}>
          <TaskStatusBadge task={t} />
          {t.archivedAt ? <Badge label={tr("task.archived")} /> : null}
          <Badge label={workspace ? `${workspace.icon || "🗂️"} ${workspace.name}` : tr("task.global")} />
          {projects.length > 0 && !t.archivedAt ? (
            <Pressable accessibilityRole="button" accessibilityLabel={project ? tr("task.projectA11y", { name: project.name }) : tr("task.addToProject")} hitSlop={6} onPress={pickProject}>
              <Badge label={project ? `${project.icon ? `${project.icon} ` : ""}${project.name}` : tr("task.addProject")} tone={project ? "brand" : "neutral"} />
            </Pressable>
          ) : project ? (
            <Badge label={`${project.icon ? `${project.icon} ` : ""}${project.name}`} tone="brand" />
          ) : null}
        </Row>
        {picking && (
          <ProjectPicker
            bleed={space.lg}
            projects={projects}
            value={t.projectId}
            onChange={(projectId) => {
              setPicking(false);
              if (projectId !== t.projectId) update.mutate({ projectId });
            }}
            hint={tr("task.projectHint")}
          />
        )}
      </View>

      {unrefreshed ? (
        <View style={[styles.stale, { backgroundColor: c.sunken }]}>
          <Icon name="wifi" size={15} color={c.textMuted} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <T variant="subhead" style={{ fontWeight: "600" }}>
              {tr("task.couldNotRefresh")}
            </T>
            <T variant="footnote" muted numberOfLines={2}>
              {slim ? tr("task.boardCopy") : errorText(task.error)}
            </T>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={tr("task.retryA11y")}
            hitSlop={10}
            onPress={() => {
              tap();
              void task.refetch();
            }}
            style={({ pressed }) => [styles.retry, { backgroundColor: c.surface, opacity: pressed ? 0.6 : 1 }]}
          >
            <T variant="footnote" style={{ fontWeight: "600" }}>
              {tr("common:actions.tryAgain")}
            </T>
          </Pressable>
        </View>
      ) : null}

      <Card style={styles.agent} onPress={agent ? () => router.push({ pathname: "/agent/[id]", params: { id: agent.id } }) : undefined}>
        {agent ? <CharacterAvatar agent={agent} size={40} running={working} /> : <UnassignedAvatar size={40} />}
        <View style={{ flex: 1, minWidth: 0 }}>
          <T variant="headline" numberOfLines={1} style={{ fontSize: 16 }}>
            {agent?.name ?? tr("task.unassigned")}
          </T>
          <T variant="footnote" muted numberOfLines={2}>
            {working
              ? t.activity
                ? activityText(t.activity)
                : t.runStatus === "queued"
                  ? tr("task.queued")
                  : tr("task.workingOnIt")
              : waitsForAnswer(t)
                ? tr("task.waitingAnswer")
                : waitsForTickets(t)
                  ? tr("task.waitsForTickets", { tickets: t.waitsFor.filter((w) => !w.finished).map((w) => `#${w.number}`).join(", ") })
                : waitsForSubtasks(t)
                  ? tr("task.waitingParts", { count: t.subtasks!.open })
                : isWaiting(t)
                  ? tr("task.waitingFollowUp")
                  : t.pause
                    ? tr("task.paused")
                    : t.status === "todo"
                      ? tr("task.aboutToStart")
                      : agent
                        ? tr("task.assigned")
                        : tr("task.pickBelow")}
          </T>
        </View>
        {agent && <Icon name="chevron" size={13} color={c.textFaint} />}
      </Card>

      {t.status === "blocked" && (t.blockedReason || t.blockedKind) ? (
        <Card style={[styles.notice, { backgroundColor: c.dangerSoft, borderColor: "transparent" }]}>
          <Icon name="warning" size={16} color={c.danger} />
          <View style={{ flex: 1, gap: 2 }}>
            {t.blockedKind && t.blockedKind !== "manual" ? (
              <T variant="subhead" style={{ fontWeight: "600" }}>
                {BLOCKED_TITLE[t.blockedKind](agent?.name ?? tr("task.theAgent"))}
              </T>
            ) : null}
            {t.blockedReason ? <T variant="subhead">{t.blockedReason}</T> : null}
            {t.blockedKind === "publish" ? (
              <T variant="footnote" muted>
                {tr("task.publishFailed")}
              </T>
            ) : null}
          </View>
        </Card>
      ) : null}
      {t.status === "in_review" ? (
        <Card style={[styles.notice, { backgroundColor: c.brandSoft, borderColor: "transparent" }]}>
          <Icon name="check" size={16} color={c.brandStrong} />
          <View style={{ flex: 1, gap: 2 }}>
            <T variant="subhead" style={{ fontWeight: "600" }}>
              {tr("task.deliveredReview")}
            </T>
            {mergesOnApprove(t) ? (
              <T variant="footnote" muted>
                {tr("task.mergesInto", { number: t.pullRequest!.number, branch: t.baseBranch || tr("task.defaultBranch"), host: hostOf(t.pullRequest!.url) })}
              </T>
            ) : null}
          </View>
        </Card>
      ) : null}

      <Actions
        task={t}
        busy={update.isPending || approve.isPending}
        hasAgent={!!agent}
        onMove={move}
        onArchive={archive}
        onOpenChat={t.conversationId ? () => openChat(t.conversationId!) : undefined}
      />

      {!agent && (t.status === "backlog" || t.status === "todo") && assignable.length > 0 && (
        <View>
          <SectionTitle title={tr("task.handTo")} />
          <View style={styles.chips}>
            {assignable.map((a) => (
              <Pressable
                key={a.id}
                disabled={update.isPending}
                onPress={() => {
                  tap();
                  update.mutate({ agentId: a.id, status: "todo" });
                }}
                style={({ pressed }) => [styles.chip, { backgroundColor: c.sunken, opacity: pressed ? 0.7 : 1, paddingLeft: 8 }]}
              >
                <CharacterAvatar agent={a} size={24} />
                <T variant="subhead" style={{ fontWeight: "600" }}>
                  {a.name}
                </T>
              </Pressable>
            ))}
          </View>
        </View>
      )}

      <Properties task={t} />

      <Parts task={t} workspaceId={pickedWorkspace === null || pickedWorkspace === t.workspaceId ? pickedWorkspace : t.workspaceId} />

      {t.pullRequest && (
        <Card
          style={styles.pr}
          onPress={() => {
            tap();
            void Linking.openURL(t.pullRequest!.url);
          }}
        >
          <Icon name="branch" size={17} color={c.textMuted} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <T variant="headline" style={{ fontSize: 16 }}>
              {t.pullRequest.number ? tr("task.pullRequest", { number: t.pullRequest.number }) : tr("task.openPullRequest")}
            </T>
            <T variant="footnote" muted numberOfLines={1}>
              {t.pullRequest.state ? tr(`task.prState.${t.pullRequest.state}`) : tr("task.notOpened")}
              {t.branch ? ` · ${t.branch}` : ""}
            </T>
          </View>
          <Icon name="external" size={14} color={c.textFaint} />
        </Card>
      )}

      {t.summary && (whole || loadingTexts) ? (
        <TextSection title={isWorking(t) ? tr("task.previousResult") : t.type === "research" ? tr("task.report") : tr("task.result")} text={whole ? t.summary : undefined} />
      ) : null}
      {(whole && t.description) || loadingTexts ? <TextSection title={tr("task.details")} text={whole ? t.description : undefined} /> : null}

      {canFollowUp && (
        <View>
          <SectionTitle
            title={
              t.status === "in_review"
                ? tr("task.requestChanges")
                : t.blockedKind === "needs_input" && t.status === "blocked"
                  ? tr("task.answer")
                  : t.status === "blocked"
                    ? tr("task.helpAlong")
                    : tr("task.askForChanges")
            }
          />
          <Composer
            draftKey={`task:${id}`}
            onSend={followUp}
            attachments
            placeholder={agent ? tr("task.composerPlaceholder", { agent: agent.name }) : tr("task.composerPlaceholderUnnamed")}
          />
        </View>
      )}

      <View>
        <SectionTitle title={tr("task.activity")} />
        <TaskTimeline task={t} agents={agents} />
      </View>

      <T variant="footnote" muted style={{ paddingHorizontal: 4 }}>
        {filedLine}
        {t.runCount > 0
          ? ` · ${tr(isWorking(t) ? "task.workedSoFar" : "task.worked", { agent: agent?.name ?? tr("task.theAgent"), time: formatWork(t.workMs), count: t.runCount })}`
          : ""}
        {t.completedAt ? ` · ${tr("task.closedAgo", { ago: formatDistanceToNowStrict(new Date(t.completedAt), { addSuffix: true, locale: dateLocale() }) })}` : ""}
      </T>
    </ScrollView>
  );
}

/** The board's copy of a ticket: there at once, but without its description and with a clipped result. */
function boardTicket(id: string): Task | undefined {
  for (const [, list] of queryClient.getQueriesData<Task[]>({ queryKey: [...qk.tasks, "list"] })) {
    const hit = Array.isArray(list) ? list.find((t) => t.id === id) : undefined;
    if (hit) return hit;
  }
  return undefined;
}

/** The screen's shape while a ticket nothing is known about yet loads. */
function TaskSkeleton() {
  const { t } = useTranslation("tasks");
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content} scrollEnabled={false}>
      <Stack.Title>{t("task.title")}</Stack.Title>
      <View style={{ gap: space.lg }} accessibilityRole="progressbar" accessibilityLabel={t("task.loadingTask")}>
        <View style={{ gap: space.sm }}>
          <Skeleton width="86%" height={22} radius={8} />
          <Skeleton width="52%" height={22} radius={8} />
          <Row style={{ gap: 6, marginTop: 2 }}>
            <Skeleton width={86} height={21} radius={radius.pill} />
            <Skeleton width={58} height={21} radius={radius.pill} />
            <Skeleton width={104} height={21} radius={radius.pill} />
          </Row>
        </View>
        <Card style={styles.agent}>
          <Skeleton width={40} height={40} radius={13} />
          <View style={{ flex: 1, gap: 8 }}>
            <Skeleton width="44%" height={14} />
            <Skeleton width="68%" height={11} />
          </View>
        </Card>
        <View style={{ gap: space.sm }}>
          <Skeleton height={46} radius={radius.pill} />
          <Skeleton height={46} radius={radius.pill} />
        </View>
        <Card style={styles.text}>
          <TextSkeleton />
        </Card>
      </View>
    </ScrollView>
  );
}

function TextSkeleton() {
  return (
    <View style={{ gap: 10 }}>
      <Skeleton width="94%" height={13} />
      <Skeleton width="80%" height={13} />
      <Skeleton width="58%" height={13} />
    </View>
  );
}

/** A titled card of Markdown; without `text` it is still loading. */
function TextSection({ title, text }: { title: string; text?: string }) {
  const { t } = useTranslation("tasks");
  return (
    <View>
      <SectionTitle title={title} />
      <Card style={styles.text}>
        {text ? (
          <Markdown text={text} />
        ) : (
          <View accessibilityRole="progressbar" accessibilityLabel={t("task.loadingSection", { section: title })}>
            <TextSkeleton />
          </View>
        )}
      </Card>
    </View>
  );
}

type Action = { title: string; icon: Parameters<typeof Button>[0]["icon"]; status?: TaskStatus; archived?: boolean; primary?: boolean; onPress?: () => void };

function Actions({
  task,
  busy,
  hasAgent,
  onMove,
  onArchive,
  onOpenChat,
}: {
  task: Task;
  busy: boolean;
  hasAgent: boolean;
  onMove: (status: TaskStatus) => void;
  onArchive: (archived: boolean) => void;
  onOpenChat?: () => void;
}) {
  const { t } = useTranslation(["tasks", "common"]);
  const buttons: Action[] = [];
  if (task.archivedAt) {
    buttons.push({ title: t("task.backOnBoard"), icon: "unarchive", archived: false, primary: true });
    if (onOpenChat) buttons.push({ title: t("task.openChat"), icon: "chats", onPress: onOpenChat });
    return <ActionButtons buttons={buttons} busy={busy} onMove={onMove} onArchive={onArchive} />;
  }
  switch (task.status) {
    case "backlog":
      if (hasAgent) buttons.push({ title: t("task.start"), icon: "play", status: "todo", primary: true });
      break;
    case "todo":
      buttons.push({ title: t("task.backToBacklog"), icon: "pause", status: "backlog" });
      break;
    case "in_progress":
      buttons.push({ title: t("common:actions.stop"), icon: "stop", status: "backlog" });
      break;
    case "in_review":
      buttons.push({
        title: busy && mergesOnApprove(task) ? t("task.merging") : mergesOnApprove(task) ? t("task.approveMerge") : t("task.approve"),
        icon: "check",
        status: "done",
        primary: true,
      });
      break;
    case "blocked":
      // When the agent asked for something, the answer goes in the message box below.
      if (hasAgent && task.blockedKind !== "needs_input") {
        const title =
          task.blockedKind === "interrupted"
            ? t("common:actions.continue")
            : task.blockedKind === "stopped" || task.blockedKind === "manual" || task.blockedKind === "publish"
              ? t("task.startAgain")
              : t("common:actions.tryAgain");
        buttons.push({ title, icon: "refresh", status: "todo", primary: true });
      }
      break;
    case "done":
    case "cancelled":
      buttons.push({ title: t("task.reopen"), icon: "refresh", status: reopenStatus(task) });
      break;
  }
  if (onOpenChat) buttons.push({ title: t("task.openChat"), icon: "chats", onPress: onOpenChat });
  buttons.push({ title: t("task.archive"), icon: "archive", archived: true });
  if (task.status !== "done" && task.status !== "cancelled") buttons.push({ title: t("task.cancelTask"), icon: "close", status: "cancelled" });
  return <ActionButtons buttons={buttons} busy={busy} onMove={onMove} onArchive={onArchive} />;
}

function ActionButtons({
  buttons,
  busy,
  onMove,
  onArchive,
}: {
  buttons: Action[];
  busy: boolean;
  onMove: (status: TaskStatus) => void;
  onArchive: (archived: boolean) => void;
}) {
  if (!buttons.length) return null;
  return (
    <View style={{ gap: space.sm }}>
      {buttons.map((b) => (
        <Button
          key={b.title}
          title={b.title}
          icon={b.icon}
          variant={b.primary ? "primary" : b.status === "cancelled" ? "danger" : "secondary"}
          disabled={busy && (!!b.status || b.archived !== undefined)}
          onPress={b.onPress ?? (() => (b.archived !== undefined ? onArchive(b.archived) : onMove(b.status!)))}
        />
      ))}
    </View>
  );
}

/** The ticket's fields, read-only on the phone: they are set on the computer. */
function Properties({ task: t }: { task: Task }) {
  const c = useColors();
  const { t: tr } = useTranslation("tasks");
  const tickets = (numbers: number[]) => {
    const n = numbers.map((x) => `#${x}`);
    return n.length < 2 ? (n[0] ?? "") : tr("task.ticketList", { list: n.slice(0, -1).join(", "), last: n[n.length - 1] });
  };
  const coding = t.type === "coding" || !!t.branch;
  const open = (t.waitsFor ?? []).filter((w) => !w.finished);
  return (
    <Card style={styles.props}>
      <Prop label={tr("task.priority")} value={PRIORITY_LABEL[t.priority]} color={t.priority === "urgent" ? c.danger : undefined} />
      {t.dueDate ? <Prop label={tr("task.dueDate")} value={dueLabel(t.dueDate)} color={isOverdue(t) ? c.danger : undefined} /> : null}
      {t.waitsFor?.length ? (
        <Prop
          label={tr("task.waitsFor")}
          value={open.length ? tickets(open.map((w) => w.number)) : tr("task.nothingWaiting")}
          detail={open.length === 1 ? open[0]!.title : undefined}
        />
      ) : null}
      {t.labels?.length ? (
        <Prop label={tr("task.labels")}>
          <Row style={{ gap: 4, flexWrap: "wrap", flex: 1 }}>
            {(t.labels ?? []).map((l) => (
              <Badge key={l} label={l} />
            ))}
          </Row>
        </Prop>
      ) : null}
      <Prop label={tr("task.type")} value={TYPE_META[t.type].label} detail={TYPE_META[t.type].hint} />
      {coding ? <Prop label={tr("task.repository")} value={taskRepoLabel(t) || tr("task.workspaceRepo")} mono /> : null}
      {t.branch ? <Prop label={tr("task.branch")} value={`${t.branch} → ${t.baseBranch || tr("task.defaultBranchShort")}`} mono /> : null}
      {t.type === "coding" ? (
        <Prop label={tr("task.merge")} value={t.autoMerge ? tr("task.autoMerge", { branch: t.baseBranch || tr("task.defaultBranch") }) : tr("task.afterReview")} />
      ) : null}
    </Card>
  );
}

function Prop({ label, value, detail, color, mono, children }: { label: string; value?: string; detail?: string; color?: string; mono?: boolean; children?: ReactNode }) {
  return (
    <Row style={styles.prop}>
      <T variant="footnote" muted style={styles.propLabel}>
        {label}
      </T>
      {children ?? (
        <View style={{ flex: 1, minWidth: 0 }}>
          <T variant={mono ? "mono" : "subhead"} color={color} numberOfLines={2} selectable={mono}>
            {value}
          </T>
          {detail ? (
            <T variant="caption" muted numberOfLines={1}>
              {detail}
            </T>
          ) : null}
        </View>
      )}
    </Row>
  );
}

/** What the ticket is part of, and its own parts (a lead's ticket waits until they're finished). */
function Parts({ task, workspaceId }: { task: Task; workspaceId: string | null }) {
  const c = useColors();
  const { t } = useTranslation("tasks");
  const { byId } = useAgents();
  // The board the Tasks tab keeps (and live events patch), so this is the same request, not one more.
  const board = useQuery({ queryKey: qk.taskList(workspaceId), queryFn: () => api.tasks.list({ workspaceId }), enabled: !!task.subtasks || !!task.parentId });
  const parts = useMemo(() => (board.data ?? []).filter((p) => p.parentId === task.id).sort((a, b) => a.number - b.number), [board.data, task.id]);
  const parentTitle = useMemo(() => (task.parentId ? board.data?.find((p) => p.id === task.parentId)?.title : undefined), [board.data, task.parentId]);
  if (!task.parentId && !task.subtasks) return null;
  const open = (id: string) => {
    tap();
    router.push({ pathname: "/task/[id]", params: { id } });
  };
  return (
    <View style={{ gap: space.sm }}>
      {task.parentId ? (
        <Card style={styles.pr} onPress={() => open(task.parentId!)}>
          <Icon name="branch" size={17} color={c.textMuted} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <T variant="footnote" muted>
              {t("task.partOf")}
            </T>
            <T variant="headline" numberOfLines={1} style={{ fontSize: 16 }}>
              #{task.parentNumber} {parentTitle ?? ""}
            </T>
          </View>
          <Icon name="chevron" size={13} color={c.textFaint} />
        </Card>
      ) : null}
      {task.subtasks ? (
        <View>
          <SectionTitle title={t("task.partsTitle", { done: task.subtasks.total - task.subtasks.open, total: task.subtasks.total })} />
          <Card style={{ paddingVertical: 4 }}>
            {!parts.length && board.isPending ? (
              <View style={styles.partsLoading} accessibilityRole="progressbar" accessibilityLabel={t("task.loadingParts")}>
                {Array.from({ length: Math.min(task.subtasks.total, 4) }, (_, i) => (
                  <Skeleton key={i} width={`${78 - ((i * 19) % 30)}%`} height={13} />
                ))}
              </View>
            ) : null}
            {parts.map((p) => (
              <Pressable
                key={p.id}
                onPress={() => open(p.id)}
                accessibilityRole="button"
                accessibilityLabel={t("task.partA11y", { number: p.number, title: p.title, status: STATUS_META[p.status].label })}
                style={({ pressed }) => [styles.part, { opacity: pressed ? 0.6 : 1 }]}
              >
                <T variant="footnote" muted style={{ fontVariant: ["tabular-nums"] }}>
                  #{p.number}
                </T>
                <T variant="subhead" numberOfLines={1} style={{ flex: 1 }}>
                  {p.title}
                </T>
                <T variant="footnote" muted numberOfLines={1}>
                  {STATUS_META[p.status].label}
                  {p.agentId ? ` · ${byId.get(p.agentId)?.name ?? t("task.anAgent")}` : ""}
                </T>
              </Pressable>
            ))}
          </Card>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  props: { paddingVertical: 6, paddingHorizontal: space.lg },
  prop: { alignItems: "flex-start", gap: space.md, paddingVertical: 7 },
  propLabel: { width: 84, paddingTop: 1 },
  part: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10 },
  partsLoading: { gap: space.md, paddingVertical: space.md, paddingHorizontal: space.lg },
  stale: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.md,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
  retry: {
    height: 32,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    justifyContent: "center",
  },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: 80,
    gap: space.lg,
  },
  agent: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.md,
  },
  notice: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.md,
    padding: space.lg,
  },
  pr: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.lg,
  },
  text: {
    padding: space.lg,
  },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.sm,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 36,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
  },
});
