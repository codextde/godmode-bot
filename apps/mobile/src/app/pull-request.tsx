import { useMutation, useQuery } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import { Image } from "expo-image";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState, type ReactNode } from "react";
import { Alert, Linking, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { GithubErrorCode, parsePullRequestUrl, type PullRequestCheck, type PullRequestView } from "@godmode/shared";
import { NeedsFullAccess, needsFullAccess } from "@/components/full-access";
import { HeaderActions } from "@/components/header-actions";
import { Icon, type IconName } from "@/components/icon";
import { Markdown } from "@/components/markdown";
import { Badge, Button, Card, EmptyState, Hairline, SectionTitle, Skeleton, T, tap, type Tone } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { dateLocale, intlLocale } from "@/lib/i18n";
import { prApi, prKey, refreshEvery } from "@/lib/pull-requests";
import { queryClient } from "@/lib/query";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { fonts, radius, space, useColors } from "@/lib/theme";

const CHECKS_SHOWN = 6;
const FILES_SHOWN = 12;

const STATES: Record<PullRequestView["state"], { icon: IconName; tone: Tone }> = {
  open: { icon: "pullRequest", tone: "success" },
  draft: { icon: "pullRequest", tone: "neutral" },
  merged: { icon: "merge", tone: "violet" },
  closed: { icon: "closeCircle", tone: "danger" },
};

const ago = (iso: string | null | undefined) => (iso ? formatDistanceToNowStrict(new Date(iso), { addSuffix: true, locale: dateLocale() }) : "");
const timeOf = (iso: string | null | undefined) => {
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at.toLocaleTimeString(intlLocale(), { hour: "2-digit", minute: "2-digit" });
};

/**
 * A pull request on GitHub, like the desktop's side panel: state, branches, reviews, checks, description and files,
 * merged (or set to merge by itself) from here with the computer's GitHub login.
 */
export default function PullRequestScreen() {
  const { t } = useTranslation("tasks");
  const { url = "" } = useLocalSearchParams<{ url: string }>();
  const ref = parsePullRequestUrl(url);
  const pr = useQuery({
    queryKey: prKey(url),
    queryFn: () => prApi.get(url, { background: (queryClient.getQueryState(prKey(url))?.dataUpdateCount ?? 0) > 0 }),
    enabled: !!ref,
    staleTime: 30_000,
    refetchInterval: (q) => refreshEvery(q.state.data),
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 1,
  });
  const refresh = async () => {
    try {
      queryClient.setQueryData(prKey(url), await prApi.get(url, { refresh: true }));
    } catch {
      await pr.refetch();
    }
  };
  const pull = usePullRefresh(refresh);
  const data = pr.data;

  return (
    <>
      <Stack.Title>{ref ? `${ref.repo} #${ref.number}` : t("pullRequest.title")}</Stack.Title>
      <HeaderActions
        actions={[
          { icon: "refresh", label: t("pullRequest.refresh"), onPress: () => void refresh() },
          { icon: "external", label: t("pullRequest.openOnGithub"), onPress: () => void Linking.openURL(data?.url ?? url) },
        ]}
      />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content} refreshControl={<RefreshControl {...pull} />}>
        {!ref ? (
          <EmptyState icon="pullRequest" title={t("pullRequest.errors.notALink")} />
        ) : data ? (
          <Body pr={data} url={url} />
        ) : needsFullAccess(pr.error) ? (
          <NeedsFullAccess />
        ) : pr.isError ? (
          <Failure error={pr.error} url={url} onRetry={() => void refresh()} />
        ) : (
          <View style={{ gap: space.md }}>
            <Skeleton height={22} width="85%" />
            <Skeleton height={14} width="50%" />
            <Skeleton height={64} radius={radius.lg} />
            <Skeleton height={120} radius={radius.lg} />
          </View>
        )}
      </ScrollView>
    </>
  );
}

function Failure({ error, url, onRetry }: { error: unknown; url: string; onRetry: () => void }) {
  const { t } = useTranslation("tasks");
  const code = error instanceof ApiError ? error.code : undefined;
  const text =
    code === GithubErrorCode.RateLimited
      ? t("pullRequest.errors.rateLimited")
      : code === GithubErrorCode.NotFound
        ? t("pullRequest.errors.notFound")
        : code === GithubErrorCode.Unauthorized
          ? t("pullRequest.errors.unauthorized")
          : t("pullRequest.errors.other", { message: error instanceof Error ? error.message : String(error) });
  return (
    <EmptyState
      icon="warning"
      title={t("pullRequest.loadFailed")}
      body={text}
      action={
        <View style={{ gap: space.sm, alignItems: "center" }}>
          {code !== GithubErrorCode.RateLimited ? <Button title={t("pullRequest.tryAgain")} icon="refresh" variant="secondary" onPress={onRetry} /> : null}
          <Button title={t("pullRequest.openOnGithub")} icon="external" variant="outline" onPress={() => void Linking.openURL(url)} />
        </View>
      }
    />
  );
}

function Note({ children }: { children: ReactNode }) {
  const c = useColors();
  return (
    <View style={[styles.note, { backgroundColor: c.sunken }]}>
      <T variant="footnote" muted>
        {children}
      </T>
    </View>
  );
}

function Body({ pr, url }: { pr: PullRequestView; url: string }) {
  const c = useColors();
  const { t } = useTranslation("tasks");
  const state = STATES[pr.state];
  const when =
    pr.state === "merged"
      ? t("pullRequest.when.merged", { ago: ago(pr.mergedAt) })
      : pr.state === "closed"
        ? t("pullRequest.when.closed", { ago: ago(pr.closedAt) })
        : t("pullRequest.when.opened", { ago: ago(pr.createdAt) });
  const open = pr.state === "open" || pr.state === "draft";
  return (
    <>
      {pr.stale ? <Note>{timeOf(pr.retryAt) ? t("pullRequest.staleUntil", { ago: ago(pr.fetchedAt), time: timeOf(pr.retryAt) }) : t("pullRequest.stale", { ago: ago(pr.fetchedAt) })}</Note> : null}
      {!pr.signedIn ? <Note>{t("pullRequest.signedOut")}</Note> : null}

      <View style={{ gap: space.sm }}>
        <T variant="title" selectable>
          {pr.title}
        </T>
        <View style={styles.wrap}>
          <Badge label={t(`pullRequest.states.${pr.state}`)} tone={state.tone} icon={<Icon name={state.icon} size={11} color={c.textMuted} />} />
          {pr.authorAvatarUrl ? <Image source={{ uri: pr.authorAvatarUrl }} style={styles.avatar} /> : null}
          <T variant="footnote" muted>
            <T variant="footnote" style={{ fontWeight: "600" }}>
              {pr.author}
            </T>{" "}
            {when}
          </T>
        </View>
        <T variant="footnote" muted numberOfLines={1} style={{ fontFamily: fonts.mono }}>
          {`${pr.headBranch} → ${pr.baseBranch}`}
        </T>
        <View style={styles.wrap}>
          <T variant="footnote" style={{ fontVariant: ["tabular-nums"] }}>
            <T variant="footnote" color={c.success}>{`+${pr.additions}`}</T> <T variant="footnote" color={c.danger}>{`−${pr.deletions}`}</T>
          </T>
          <T variant="footnote" muted>
            {t("pullRequest.files", { count: pr.changedFiles })}
          </T>
          <T variant="footnote" muted>
            {t("pullRequest.commits", { count: pr.commits })}
          </T>
          {pr.comments > 0 ? (
            <T variant="footnote" muted>
              {t("pullRequest.comments", { count: pr.comments })}
            </T>
          ) : null}
        </View>
        {pr.labels.length ? (
          <View style={styles.wrap}>
            {pr.labels.map((l) => (
              <View key={l.name} style={[styles.label, { borderColor: c.border }]}>
                <View style={[styles.labelDot, { backgroundColor: /^[0-9a-f]{6}$/i.test(l.color) ? `#${l.color}` : c.textFaint }]} />
                <T variant="caption">{l.name}</T>
              </View>
            ))}
          </View>
        ) : null}
      </View>

      {open && pr.mergeable !== "clean" && pr.mergeable !== "unknown" ? (
        <View style={[styles.note, { backgroundColor: c.warningSoft, flexDirection: "row", gap: space.sm }]}>
          <Icon name="warning" size={14} color={c.warning} />
          <T variant="footnote" style={{ flex: 1 }}>
            {pr.mergeable === "conflicting" ? t("pullRequest.conflicts") : t("pullRequest.blocked")}
          </T>
        </View>
      ) : null}

      {open && pr.canMerge ? <MergeBar pr={pr} url={url} /> : null}
      {pr.reviews?.length ? <Reviews pr={pr} /> : null}
      {pr.checks?.length ? <Checks checks={pr.checks} /> : null}
      {pr.body.trim() ? <Description body={pr.body} /> : null}
      {pr.files?.length ? <Files pr={pr} /> : null}
    </>
  );
}

/** Merge (or auto-merge) when GitHub lets this login: why not, or into which branch, and the buttons. */
function MergeBar({ pr, url }: { pr: PullRequestView; url: string }) {
  const c = useColors();
  const { t } = useTranslation("tasks");
  const blocker =
    pr.state === "draft"
      ? t("pullRequest.merge.blockedDraft")
      : pr.mergeable === "conflicting"
        ? t("pullRequest.merge.blockedConflicts")
        : pr.mergeMethods.length === 0
          ? t("pullRequest.merge.blockedNoMethod")
          : null;
  const running = (pr.checks ?? []).filter((x) => x.state === "pending").length;
  const offerAuto = pr.autoMergeAllowed && !pr.autoMerge && !blocker && (running > 0 || pr.mergeable === "blocked");
  const turnOff = useMutation({
    mutationFn: () => prApi.autoMerge({ url, method: null }),
    onSuccess: (view) => queryClient.setQueryData(prKey(url), view),
    onError: (err) => Alert.alert(t("pullRequest.autoMerge.disableFailed", { reason: err instanceof Error ? err.message : String(err) })),
  });
  const openSheet = (mode: "now" | "auto") => router.push({ pathname: "/pull-request-merge", params: { url, mode } });

  if (pr.autoMerge) {
    return (
      <Card style={[styles.bar, { borderColor: c.brand, backgroundColor: c.brandSoft }]}>
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <Icon name="merge" size={16} color={c.brandStrong} />
          <T variant="subhead" style={{ flex: 1 }}>
            {t("pullRequest.autoMerge.on", { method: t(`pullRequest.merge.methods.${pr.autoMerge.method}.label`), base: pr.baseBranch })}
            {pr.autoMerge.enabledBy ? <T variant="subhead" muted>{` · ${t("pullRequest.autoMerge.by", { login: pr.autoMerge.enabledBy })}`}</T> : null}
          </T>
        </View>
        <Button title={t("pullRequest.autoMerge.turnOff")} icon="close" variant="outline" loading={turnOff.isPending} onPress={() => turnOff.mutate()} />
      </Card>
    );
  }
  return (
    <Card style={styles.bar}>
      <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
        <Icon name="merge" size={16} color={c.textMuted} />
        <T variant="subhead" muted style={{ flex: 1 }}>
          {blocker ?? t("pullRequest.merge.into", { base: pr.baseBranch })}
        </T>
      </View>
      <View style={{ flexDirection: "row", gap: space.sm }}>
        {offerAuto ? <Button title={t("pullRequest.autoMerge.button")} variant="outline" style={{ flex: 1 }} onPress={() => openSheet("auto")} /> : null}
        <Button title={t("pullRequest.merge.button")} icon="merge" disabled={!!blocker} style={{ flex: 1 }} onPress={() => openSheet("now")} />
      </View>
    </Card>
  );
}

function Reviews({ pr }: { pr: PullRequestView }) {
  const c = useColors();
  const { t } = useTranslation("tasks");
  return (
    <View>
      <SectionTitle title={t("pullRequest.sections.reviews")} />
      <Card style={{ overflow: "hidden" }}>
        {(pr.reviews ?? []).map((r, i) => (
          <View key={r.author}>
            {i > 0 ? <Hairline inset={space.lg} /> : null}
            <View style={styles.line}>
              <Icon
                name={r.state === "approved" ? "check" : r.state === "changes_requested" ? "close" : "chats"}
                size={14}
                color={r.state === "approved" ? c.success : r.state === "changes_requested" ? c.danger : c.textMuted}
              />
              {r.avatarUrl ? <Image source={{ uri: r.avatarUrl }} style={styles.avatar} /> : null}
              <T variant="subhead" style={{ fontWeight: "600" }}>
                {r.author}
              </T>
              <T variant="subhead" muted style={{ flex: 1 }} numberOfLines={1}>
                {t(`pullRequest.review.${r.state}`)}
              </T>
            </View>
          </View>
        ))}
      </Card>
    </View>
  );
}

function CheckIcon({ state }: { state: PullRequestCheck["state"] }) {
  const c = useColors();
  if (state === "success") return <Icon name="check" size={13} color={c.success} weight="bold" />;
  if (state === "failure") return <Icon name="close" size={13} color={c.danger} weight="bold" />;
  if (state === "pending") return <Icon name="clock" size={13} color={c.warning} />;
  return <Icon name="minus" size={13} color={c.textMuted} />;
}

function Checks({ checks }: { checks: PullRequestCheck[] }) {
  const { t } = useTranslation("tasks");
  const [all, setAll] = useState(false);
  const count = (state: PullRequestCheck["state"]) => checks.filter((x) => x.state === state).length;
  const summary = [
    count("failure") && t("pullRequest.checks.failed", { count: count("failure") }),
    count("pending") && t("pullRequest.checks.running", { count: count("pending") }),
    count("success") && t("pullRequest.checks.passed", { count: count("success") }),
    count("neutral") && t("pullRequest.checks.skipped", { count: count("neutral") }),
  ]
    .filter(Boolean)
    .join(" · ");
  const shown = all ? checks : checks.slice(0, CHECKS_SHOWN);
  return (
    <View>
      <SectionTitle
        title={`${t("pullRequest.sections.checks")} · ${summary}`}
        action={checks.length > CHECKS_SHOWN ? (all ? t("pullRequest.showFewer") : t("pullRequest.showAllCount", { count: checks.length })) : undefined}
        onAction={() => setAll(!all)}
      />
      <Card style={{ overflow: "hidden" }}>
        {shown.map((check, i) => (
          <View key={check.name}>
            {i > 0 ? <Hairline inset={space.lg} /> : null}
            <Pressable
              accessibilityRole={check.url ? "link" : undefined}
              disabled={!check.url}
              onPress={() => {
                tap();
                if (check.url) void Linking.openURL(check.url);
              }}
              style={({ pressed }) => [styles.line, pressed && { opacity: 0.6 }]}
            >
              <CheckIcon state={check.state} />
              <T variant="subhead" numberOfLines={1} style={{ flex: 1 }}>
                {check.name}
              </T>
            </Pressable>
          </View>
        ))}
      </Card>
    </View>
  );
}

function Description({ body }: { body: string }) {
  const { t } = useTranslation("tasks");
  const long = body.length > 700 || body.split("\n").length > 14;
  const [open, setOpen] = useState(false);
  return (
    <View>
      <SectionTitle title={t("pullRequest.sections.description")} action={long ? (open ? t("pullRequest.showLess") : t("pullRequest.showAll")) : undefined} onAction={() => setOpen(!open)} />
      <Card style={[styles.description, long && !open && { maxHeight: 260, overflow: "hidden" }]}>
        <Markdown text={body} />
      </Card>
    </View>
  );
}

function Files({ pr }: { pr: PullRequestView }) {
  const c = useColors();
  const { t } = useTranslation("tasks");
  const [all, setAll] = useState(false);
  const files = pr.files ?? [];
  const shown = all ? files : files.slice(0, FILES_SHOWN);
  const hidden = pr.changedFiles - files.length;
  return (
    <View>
      <SectionTitle
        title={t("pullRequest.sections.files")}
        action={files.length > FILES_SHOWN ? (all ? t("pullRequest.showFewer") : t("pullRequest.showAllCount", { count: files.length })) : undefined}
        onAction={() => setAll(!all)}
      />
      <Card style={{ overflow: "hidden" }}>
        {shown.map((f, i) => (
          <View key={f.path}>
            {i > 0 ? <Hairline inset={space.lg} /> : null}
            <View style={styles.line}>
              <Icon name={f.status === "added" ? "plus" : f.status === "removed" ? "minus" : "doc"} size={12} color={f.status === "added" ? c.success : f.status === "removed" ? c.danger : c.textMuted} />
              <T variant="footnote" numberOfLines={1} style={{ flex: 1, fontFamily: fonts.mono }}>
                {f.path}
              </T>
              <T variant="caption" style={{ fontFamily: fonts.mono }}>
                <T variant="caption" color={c.success}>{`+${f.additions}`}</T> <T variant="caption" color={c.danger}>{`−${f.deletions}`}</T>
              </T>
            </View>
          </View>
        ))}
      </Card>
      {hidden > 0 ? (
        <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(`${pr.url}/files`)} style={{ paddingTop: space.sm, paddingHorizontal: space.md }}>
          <T variant="footnote" muted>
            {t("pullRequest.moreOnGithub", { count: hidden })}
          </T>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingBottom: 80, gap: space.lg },
  wrap: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm },
  avatar: { width: 18, height: 18, borderRadius: 9 },
  label: { flexDirection: "row", alignItems: "center", gap: 5, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 },
  labelDot: { width: 7, height: 7, borderRadius: 4 },
  note: { padding: space.md, borderRadius: radius.md, borderCurve: "continuous" },
  bar: { padding: space.lg, gap: space.md },
  line: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.lg, minHeight: 44, paddingVertical: space.sm },
  description: { padding: space.lg },
});
