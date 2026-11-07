import { router } from "expo-router";
import { StyleSheet, View } from "react-native";
import { Trans, useTranslation } from "react-i18next";
import { Icon } from "./icon";
import { StripAction } from "./turn-end";
import { T, tap } from "./ui";
import { radius, space, useColors } from "@/lib/theme";

/** In place of the composer in an agent's dream log or auto reviews: the computer takes no messages there. */
export function DreamLogNote({ agentId, name, review }: { agentId: string; name: string; review: boolean }) {
  const c = useColors();
  const { t } = useTranslation("chat");
  return (
    <View style={[styles.note, { backgroundColor: c.surface, borderColor: c.border }]}>
      <Icon name={review ? "review" : "moon"} size={16} color={c.textMuted} />
      <T variant="footnote" muted style={{ flex: 1 }}>
        <Trans t={t} i18nKey={review ? "conv.reviewLog" : "conv.dreamLog"} values={{ name }} components={{ b: <T variant="footnote" style={{ fontWeight: "600" }} /> }} />
      </T>
      <StripAction
        label={t("conv.newChat")}
        onPress={() => {
          tap();
          router.push({ pathname: "/compose", params: { agentId } });
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  note: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: space.lg,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
});
