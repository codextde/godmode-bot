import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import { DatePicker, Host } from "@expo/ui/swift-ui";
import { datePickerStyle, labelsHidden, tint } from "@expo/ui/swift-ui/modifiers";
import { addHours, format } from "date-fns";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { refreshFollowup } from "@/components/followup-row";
import { Group } from "@/components/form";
import { Button, Row, T, tap } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { useNow } from "@/lib/hooks";
import { dateLocale } from "@/lib/i18n";
import { radius, space, useColors, useIsDark } from "@/lib/theme";

/** The desktop asks for at least this much ahead. */
const MIN_AHEAD = 60_000;

/** Continue a chat at a date and time of your own, when none of the presets fits. */
export default function FollowupTimeSheet() {
  const c = useColors();
  const dark = useIsDark();
  const { t } = useTranslation("chat");
  const { conversationId = "", dueAt = "" } = useLocalSearchParams<{ conversationId: string; dueAt?: string }>();
  const [at, setAt] = useState(() => {
    const due = new Date(dueAt);
    return due.getTime() - Date.now() >= MIN_AHEAD ? due : addHours(new Date(), 1);
  });
  const [picking, setPicking] = useState<"date" | "time" | null>(null);
  const [busy, setBusy] = useState(false);
  const ios = process.env.EXPO_OS === "ios";
  const now = useNow(15_000);
  const ok = at.getTime() - now >= MIN_AHEAD;

  const save = () => {
    tap();
    setBusy(true);
    api.conversations.followup
      .move(conversationId, at.toISOString())
      .then(() => {
        refreshFollowup(conversationId);
        router.back();
      })
      .catch((err: unknown) => {
        setBusy(false);
        Alert.alert(t("thread.followup.moveFailed"), errorText(err));
      });
  };

  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.content}>
      <T variant="title">{t("followupTime.title")}</T>
      <Group>
        <Row style={styles.row}>
          <T variant="callout" style={{ flex: 1 }}>
            {t("followupTime.dateAndTime")}
          </T>
          {ios ? (
            <Host matchContents colorScheme={dark ? "dark" : "light"}>
              <DatePicker
                selection={at}
                range={{ start: new Date(now) }}
                displayedComponents={["date", "hourAndMinute"]}
                onDateChange={setAt}
                modifiers={[labelsHidden(), datePickerStyle("compact"), tint(c.brand)]}
              />
            </Host>
          ) : (
            <>
              <Part label={t("followupTime.date")} value={format(at, "P", { locale: dateLocale() })} onPress={() => setPicking("date")} />
              <Part label={t("followupTime.time")} value={format(at, "p", { locale: dateLocale() })} onPress={() => setPicking("time")} />
            </>
          )}
        </Row>
      </Group>
      <Button title={t("followupTime.set")} onPress={save} disabled={!ok} loading={busy} />
      {picking ? (
        <DateTimePicker
          value={at}
          mode={picking}
          minimumDate={new Date(now)}
          accentColor={c.brand}
          onValueChange={(_, next) => {
            setPicking(null);
            setAt(next);
          }}
          onDismiss={() => setPicking(null)}
        />
      ) : null}
    </ScrollView>
  );
}

function Part({ label, value, onPress }: { label: string; value: string; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      hitSlop={6}
      onPress={() => {
        tap();
        onPress();
      }}
      style={[styles.part, { backgroundColor: c.sunken }]}
    >
      <T variant="subhead">{value}</T>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.xl, paddingBottom: 48, gap: space.lg },
  row: { gap: space.sm, minHeight: 52, paddingHorizontal: space.lg, paddingVertical: space.sm },
  part: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.sm, borderCurve: "continuous" },
});
