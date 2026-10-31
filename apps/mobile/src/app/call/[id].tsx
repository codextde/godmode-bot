import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { router, Stack, useLocalSearchParams } from "expo-router";
import type { ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { isCallActive, type CallPurpose, type PhoneCall } from "@godmode/shared";
import { CallStatusBadge, callListQuery, callName, callQuery, formatCallTime } from "@/components/call-parts";
import { CharacterAvatar } from "@/components/character";
import { Icon } from "@/components/icon";
import { Badge, Button, EmptyState, ErrorState, LiveDot, LoadingState, Row, T } from "@/components/ui";
import { ApiError, errorText } from "@/lib/api";
import { useAgents, useNow } from "@/lib/hooks";
import { dateLocale } from "@/lib/i18n";
import { queryClient } from "@/lib/query";
import { radius, space, useColors } from "@/lib/theme";

const GOAL_LABEL = {
  task: "detail.goal.task",
  question: "detail.goal.question",
  inform: "detail.goal.inform",
  inbound: "detail.goal.inbound",
} as const satisfies Record<CallPurpose, string>;

export default function CallScreen() {
  const { t } = useTranslation("calls");
  const { id } = useLocalSearchParams<{ id: string }>();
  const call = useQuery({
    ...callQuery(id),
    placeholderData: () => queryClient.getQueryData<PhoneCall[]>(callListQuery.queryKey)?.find((c) => c.id === id),
  });

  if (!call.data) {
    return (
      <View style={{ flex: 1, justifyContent: "center" }}>
        <Stack.Title>{t("detail.title")}</Stack.Title>
        {call.error instanceof ApiError && call.error.code === "device_forbidden" ? (
          <EmptyState icon="call" title={t("unavailableTitle")} body={t("unavailableBody")} />
        ) : call.isError ? (
          <ErrorState title={t("detail.openFailed")} error={errorText(call.error)} onRetry={() => void call.refetch()} />
        ) : (
          <LoadingState label={t("detail.loading")} />
        )}
      </View>
    );
  }
  return <CallDetail call={call.data} />;
}

function CallDetail({ call: c }: { call: PhoneCall }) {
  const colors = useColors();
  const { t } = useTranslation(["calls", "common"]);
  const { byId } = useAgents();
  const agent = c.agentId ? byId.get(c.agentId) : undefined;
  const agentName = agent?.name ?? c.agentName;
  const inbound = c.direction === "inbound";
  const active = isCallActive(c);
  const missed = c.successful === false;

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <Stack.Title>{callName(c)}</Stack.Title>

      <View style={styles.hero}>
        <View style={[styles.tile, { backgroundColor: colors.sunken }]}>
          <Icon name={inbound ? "callIn" : "callOut"} size={24} color={inbound ? colors.skyMark : colors.brandStrong} />
        </View>
        <T variant="title" style={{ textAlign: "center" }}>
          {callName(c)}
        </T>
        <T variant="footnote" muted style={{ textAlign: "center" }}>
          {[c.contactName && c.number ? c.number : null, inbound ? t("detail.incoming") : t("detail.outgoing"), format(new Date(c.createdAt), t("detail.dateFormat"), { locale: dateLocale() })]
            .filter(Boolean)
            .join(" · ")}
        </T>
        <Row style={{ gap: 6, marginTop: 4 }}>
          <CallStatusBadge status={c.status} />
          {c.fromOwner ? <Badge label={t("detail.ownerCall")} /> : null}
        </Row>
      </View>

      <View style={[styles.facts, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Fact label={t("detail.duration")}>{active && c.durationSecs == null ? <LiveTimer since={c.createdAt} /> : <FactText>{formatCallTime(c.durationSecs)}</FactText>}</Fact>
        <View style={{ width: StyleSheet.hairlineWidth, backgroundColor: colors.border }} />
        <Fact label={t("common:words.agent")}>
          <Row style={{ gap: 6 }}>
            {agent ? <CharacterAvatar agent={agent} size={18} /> : null}
            <FactText>{agentName ?? "–"}</FactText>
          </Row>
        </Fact>
      </View>

      {c.conversationId ? <Button title={t("detail.openChat")} icon="chats" variant="secondary" onPress={() => router.push({ pathname: "/chat/[id]", params: { id: c.conversationId! } })} /> : null}

      {c.error ? (
        <View style={[styles.callout, { backgroundColor: colors.dangerSoft }]}>
          <Icon name="warning" size={15} color={colors.danger} />
          <T variant="subhead" color={colors.danger} style={{ flex: 1 }}>
            {c.error}
          </T>
        </View>
      ) : null}

      {c.goal ? (
        <Section label={t(GOAL_LABEL[c.purpose])}>
          <T variant="body" selectable>
            {c.goal}
          </T>
        </Section>
      ) : null}

      {c.outcome ? (
        <View style={[styles.outcome, { backgroundColor: missed ? colors.warningSoft : colors.brandSoft }]}>
          <Row style={{ gap: 6 }}>
            <Icon name={c.successful === true ? "check" : missed ? "close" : "bolt"} size={12} color={missed ? colors.warning : colors.brandStrong} weight="bold" />
            <T variant="eyebrow" color={missed ? colors.warning : colors.brandStrong}>
              {missed ? t("detail.outcomeMissed") : t("detail.outcome")}
            </T>
          </Row>
          <T variant="body" selectable>
            {c.outcome}
          </T>
        </View>
      ) : null}

      {c.purpose === "question" && c.answer ? (
        <Section label={t("detail.yourAnswer")}>
          <T variant="body" selectable>
            {c.answer}
          </T>
        </Section>
      ) : null}

      {c.summary ? (
        <Section label={t("detail.summary")}>
          <T variant="body" selectable style={{ opacity: 0.88 }}>
            {c.summary}
          </T>
        </Section>
      ) : null}

      {active ? (
        <View style={[styles.waiting, { borderColor: colors.border }]}>
          <LiveDot size={8} />
          <T variant="footnote" muted style={{ flex: 1 }}>
            {c.status === "processing" ? t("detail.processing") : t("detail.waiting")}
          </T>
        </View>
      ) : null}

      {c.hasAudio ? (
        <View style={styles.hint}>
          <Icon name="display" size={13} color={colors.textMuted} />
          <T variant="footnote" muted style={{ flex: 1 }}>
            {t("detail.recording")}
          </T>
        </View>
      ) : null}

      {c.transcript.length > 0 ? <Transcript call={c} /> : null}
    </ScrollView>
  );
}

function Transcript({ call: c }: { call: PhoneCall }) {
  const colors = useColors();
  const { t } = useTranslation("calls");
  const other = c.contactName || (c.direction === "inbound" ? t("detail.caller") : t("detail.them"));
  return (
    <Section label={t("detail.transcript")}>
      <View style={{ gap: 6, marginTop: 4 }}>
        {c.transcript.map((turn, i) => {
          const mine = turn.speaker === "agent";
          const first = i === 0 || c.transcript[i - 1]!.speaker !== turn.speaker;
          return (
            <View key={i} style={{ alignItems: mine ? "flex-end" : "flex-start", paddingTop: first && i > 0 ? 10 : 0 }}>
              {first ? (
                <T variant="caption" muted style={{ fontWeight: "600", marginBottom: 4, marginHorizontal: 4 }}>
                  {mine ? "Godmode" : other}
                </T>
              ) : null}
              <View style={[styles.turnRow, mine && { flexDirection: "row-reverse" }]}>
                <View
                  style={[
                    styles.bubble,
                    mine
                      ? { backgroundColor: colors.sunken, borderBottomRightRadius: 6 }
                      : { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth, borderBottomLeftRadius: 6 },
                  ]}
                >
                  <T variant="callout" selectable>
                    {turn.text}
                  </T>
                </View>
                <T variant="caption" color={colors.textFaint} style={{ fontVariant: ["tabular-nums"], paddingBottom: 4 }}>
                  {formatCallTime(turn.at)}
                </T>
              </View>
            </View>
          );
        })}
      </View>
    </Section>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <T variant="eyebrow" muted>
        {label}
      </T>
      {children}
    </View>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.fact}>
      <T variant="caption" muted>
        {label}
      </T>
      {children}
    </View>
  );
}

function FactText({ children }: { children: ReactNode }) {
  return (
    <T variant="subhead" numberOfLines={1} style={{ fontVariant: ["tabular-nums"] }}>
      {children}
    </T>
  );
}

function LiveTimer({ since }: { since: string }) {
  const now = useNow(1000);
  return <FactText>{formatCallTime((now - new Date(since).getTime()) / 1000)}</FactText>;
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 80,
    gap: space.xl,
  },
  hero: {
    alignItems: "center",
    gap: space.xs,
    paddingTop: space.sm,
  },
  tile: {
    width: 56,
    height: 56,
    borderRadius: 18,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: space.sm,
  },
  facts: {
    flexDirection: "row",
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  fact: {
    flex: 1,
    gap: 4,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  callout: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: space.md,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
  outcome: {
    gap: 8,
    padding: space.lg,
    borderRadius: radius.lg,
    borderCurve: "continuous",
  },
  waiting: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: "dashed",
  },
  hint: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: 4,
  },
  turnRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    maxWidth: "88%",
  },
  bubble: {
    flexShrink: 1,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 18,
    borderCurve: "continuous",
  },
});
