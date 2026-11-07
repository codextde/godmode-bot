import { formatDistanceToNowStrict } from "date-fns";
import { StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { AutomationEvent, AutomationEventSource, AutomationEventStatus } from "@godmode/shared";
import { Icon, type IconName } from "./icon";
import { Badge, Row, T, type Tone } from "./ui";
import { RowPressable } from "./row-pressable";
import { dateLocale } from "@/lib/i18n";
import { licenseText } from "@/lib/license-text";
import { radius, space, useColors } from "@/lib/theme";

const EVENT_SOURCES = {
  schedule: { label: "automation.source.schedule", icon: "clock" },
  app: { label: "automation.source.app", icon: "layers" },
  webhook: { label: "automation.source.webhook", icon: "link" },
  condition: { label: "automation.source.condition", icon: "eye" },
  manual: { label: "automation.source.manual", icon: "hand" },
} as const satisfies Record<AutomationEventSource, { label: string; icon: IconName }>;

const EVENT_STATUS = {
  pending: { label: "automation.eventStatus.pending", tone: "warning" },
  running: { label: "automation.eventStatus.running", tone: "brand" },
  done: { label: "automation.eventStatus.done", tone: "success" },
  failed: { label: "automation.eventStatus.failed", tone: "danger" },
  skipped: { label: "automation.eventStatus.skipped", tone: "neutral" },
} as const satisfies Record<AutomationEventStatus, { label: string; tone: Tone }>;

const ago = (iso: string) => formatDistanceToNowStrict(new Date(iso), { addSuffix: true, locale: dateLocale() });

/** What started (or skipped) an automation: its source, how it went, when; `automation`: whose event it was. */
export function EventRow({ event, automation, onPress }: { event: AutomationEvent; automation?: string; onPress?: () => void }) {
  const c = useColors();
  const { t } = useTranslation("automations");
  const source = EVENT_SOURCES[event.source] ?? EVENT_SOURCES.manual;
  const status = EVENT_STATUS[event.status] ?? EVENT_STATUS.pending;
  return (
    <RowPressable
      disabled={!onPress}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityHint={onPress ? t("automation.openRunChat") : undefined}
      onPress={onPress}
      style={styles.event}
    >
      <View style={[styles.eventIcon, { backgroundColor: c.sunken }]}>
        <Icon name={source.icon} size={13} color={c.textMuted} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        {automation ? (
          <T variant="caption" muted numberOfLines={1} style={{ fontWeight: "600" }}>
            {automation}
          </T>
        ) : null}
        <T variant="subhead" style={{ fontWeight: "500" }} numberOfLines={2}>
          {event.title || t(source.label)}
        </T>
        <Row style={{ gap: space.sm, flexWrap: "wrap" }}>
          <Badge label={t(status.label)} tone={status.tone} live={event.status === "running"} />
          <T variant="caption" muted>
            {t(source.label)} · {ago(event.createdAt)}
          </T>
        </Row>
        {event.note ? (
          <T variant="footnote" color={event.status === "failed" ? c.danger : c.textMuted}>
            {event.status === "failed" ? licenseText(event.note) : event.note}
          </T>
        ) : null}
      </View>
      {onPress ? <Icon name="chevron" size={11} color={c.textFaint} style={{ marginTop: 4 }} /> : null}
    </RowPressable>
  );
}

const styles = StyleSheet.create({
  event: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  eventIcon: {
    width: 28,
    height: 28,
    borderRadius: radius.sm,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
});
