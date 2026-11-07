import { router } from "expo-router";
import { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { validateCron } from "@godmode/shared";
import { CronBuilder } from "@/components/cron-builder";
import { SheetHeader } from "@/components/secret-parts";
import { LoadingState } from "@/components/ui";
import { patchSettings, useSettings } from "@/lib/setup";
import { space, useColors } from "@/lib/theme";

/** Settings → Memory: any schedule for dreaming, like the desktop's "Custom…" cron field. */
export default function DreamSchedule() {
  const c = useColors();
  const saved = useSettings().data?.memory.dreaming.cron;
  if (saved === undefined) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        <LoadingState />
      </View>
    );
  }
  return <Editor initial={saved} />;
}

function Editor({ initial }: { initial: string }) {
  const c = useColors();
  const { t } = useTranslation(["manage", "common"]);
  const [cron, setCron] = useState(initial);
  const [busy, setBusy] = useState(false);
  const tidy = cron.trim().replace(/\s+/g, " ");
  const [problem, setProblem] = useState<string | null>(null);
  const invalid = !!validateCron(tidy) || !!problem;

  const save = async () => {
    setBusy(true);
    const ok = await patchSettings({ memory: { dreaming: { cron: tidy } } });
    setBusy(false);
    if (ok) router.back();
  };

  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <SheetHeader title={t("dreaming.title")} action={t("common:actions.save")} ready={!invalid && tidy !== initial.trim().replace(/\s+/g, " ")} busy={busy} onAction={() => void save()} />
      <CronBuilder value={initial} onChange={setCron} onProblemChange={setProblem} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    justifyContent: "center",
    padding: space.lg,
  },
  content: {
    padding: space.lg,
    paddingBottom: 48,
    gap: space.xl,
  },
});
