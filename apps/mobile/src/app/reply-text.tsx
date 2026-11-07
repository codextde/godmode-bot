import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, EmptyState, LoadingState, T, tap } from "@/components/ui";
import { fetchConversation } from "@/lib/chat-cache";
import { quoteOf } from "@/lib/chat-blocks";
import { quoteInto } from "@/lib/composer";
import { qk } from "@/lib/query";
import { fonts, space, useColors } from "@/lib/theme";

/**
 * Pick the words to quote: the phone's text selection has no room for an action of the app's own, so a reply opens here
 * as text to select from, and Quote puts the selection (or all of it) into the message being written.
 */
export default function ReplyTextSheet() {
  const c = useColors();
  const { t } = useTranslation("components");
  const insets = useSafeAreaInsets();
  const { conversationId = "", messageId = "" } = useLocalSearchParams<{ conversationId: string; messageId: string }>();
  const conversation = useQuery({ queryKey: qk.conversation(conversationId), queryFn: () => fetchConversation(conversationId), enabled: !!conversationId, staleTime: Infinity });
  const text = conversation.data?.messages.find((m) => m.id === messageId)?.content.trim() ?? "";
  const [range, setRange] = useState({ start: 0, end: 0 });
  const picked = text.slice(range.start, range.end).trim();

  const quote = () => {
    tap();
    router.back();
    quoteInto(conversationId, quoteOf(picked || text));
  };

  if (!text) {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        {conversation.isLoading ? <LoadingState /> : <EmptyState icon="quote" title={t("message.nothingToQuote")} />}
      </View>
    );
  }
  return (
    <View style={[styles.fill, { backgroundColor: c.background }]}>
      <T variant="title">{t("message.quotePart")}</T>
      {/* Android selects text only in a field it could edit: there the field stays as it is by being controlled. */}
      <TextInput
        value={text}
        onChangeText={() => undefined}
        editable={process.env.EXPO_OS !== "ios"}
        showSoftInputOnFocus={false}
        caretHidden
        multiline
        scrollEnabled
        onSelectionChange={(e) => setRange(e.nativeEvent.selection)}
        accessibilityLabel={t("message.quotePart")}
        style={[styles.text, { color: c.text }]}
      />
      <View style={{ paddingBottom: Math.max(insets.bottom, space.md) }}>
        <Button title={picked ? t("message.quoteSelection") : t("message.quoteAll")} onPress={quote} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: "center", padding: space.lg },
  fill: { flex: 1, gap: space.md, paddingHorizontal: space.xl, paddingTop: 28 },
  text: { flex: 1, fontFamily: fonts.regular, fontSize: 16, lineHeight: 23, textAlignVertical: "top", padding: 0 },
});
