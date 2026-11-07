import { useMutation, useQuery } from "@tanstack/react-query";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { format } from "date-fns";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { CharacterAvatar } from "@/components/character";
import { NeedsFullAccess, needsFullAccess, useFullAccess } from "@/components/full-access";
import { Icon } from "@/components/icon";
import { Button, Card, T, tap } from "@/components/ui";
import { errorText } from "@/lib/api";
import { chatExtrasApi, MAX_CHAT_FILE_BYTES, takeChatImport } from "@/lib/chat-extras";
import { pickAgent } from "@/lib/desktop-parity";
import { useAgents } from "@/lib/hooks";
import { dateLocale } from "@/lib/i18n";
import { qk, queryClient } from "@/lib/query";
import { agentsFor, useWorkspace } from "@/lib/workspace";
import { fonts, radius, space, useColors } from "@/lib/theme";

/** Open a chat a colleague shared (a `.godmode-chat` file or its code) and continue it with one of your agents. */
export default function ChatImport() {
  const c = useColors();
  const { t } = useTranslation(["chat", "common"]);
  const { fullAccess } = useFullAccess();
  const { data: agents } = useAgents();
  const { id: workspaceId, project } = useWorkspace();
  const usable = agentsFor(agents ?? [], workspaceId)
    .filter((a) => a.enabled)
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  const [picked, setPicked] = useState<string | undefined>();
  const agent = pickAgent(usable, picked);
  const [given] = useState(takeChatImport);
  const [file, setFile] = useState<{ name: string; data: string } | null>(given?.name ? { name: given.name, data: given.data } : null);
  const [code, setCode] = useState(given && !given.name ? given.data : "");
  // A pasted code is looked at once typing stops.
  const [settled, setSettled] = useState(code.trim());
  useEffect(() => {
    const timer = setTimeout(() => setSettled(code.trim()), 400);
    return () => clearTimeout(timer);
  }, [code]);
  const payload = file?.data ?? (settled || null);
  // A chat file runs to megabytes: as a query key it would be hashed on every render, so it is counted instead.
  const [previewed, setPreviewed] = useState({ payload, number: 0 });
  if (previewed.payload !== payload) setPreviewed({ payload, number: previewed.number + 1 });
  const preview = useQuery({
    queryKey: ["chat-import-preview", previewed.number, payload?.length],
    queryFn: () => chatExtrasApi.previewImport(payload!),
    enabled: !!payload && fullAccess === true,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });
  const projectId = project && agent && (!agent.workspaceId || agent.workspaceId === project.workspaceId) ? project.id : null;
  const importChat = useMutation({
    mutationFn: () => chatExtrasApi.import({ data: payload!, agentId: agent!.id, workspaceId, projectId }),
    onSuccess: (chat) => {
      void queryClient.invalidateQueries({ queryKey: qk.conversations });
      router.dismiss();
      router.push({ pathname: "/chat/[id]", params: { id: chat.id } });
    },
    onError: (err) => Alert.alert(t("import.error"), errorText(err)),
  });

  if (fullAccess === false || needsFullAccess(preview.error)) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        <NeedsFullAccess />
      </View>
    );
  }

  const pickFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false, type: "*/*" });
      if (result.canceled || !result.assets[0]) return;
      const asset = result.assets[0];
      const picked = new File(asset.uri);
      try {
        if ((asset.size ?? picked.size ?? 0) > MAX_CHAT_FILE_BYTES) throw new Error(t("import.tooBig"));
        setFile({ name: asset.name, data: await picked.text() });
        setCode("");
      } finally {
        try {
          if (picked.exists) picked.delete();
        } catch {
          // The system clears its copies too.
        }
      }
    } catch (err) {
      Alert.alert(t("import.error"), errorText(err));
    }
  };

  const p = preview.data;
  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <View style={{ gap: space.xs }}>
        <T variant="title">{t("import.title")}</T>
        <T variant="subhead" muted>
          {t("import.description")}
        </T>
      </View>

      {file ? (
        <Card style={styles.file}>
          <Icon name="attach" size={16} color={c.textMuted} />
          <T variant="callout" numberOfLines={1} style={{ flex: 1 }}>
            {file.name}
          </T>
          <Pressable accessibilityRole="button" hitSlop={8} onPress={() => setFile(null)}>
            <T variant="callout" color={c.brandStrong} style={{ fontWeight: "600" }}>
              {t("import.change")}
            </T>
          </Pressable>
        </Card>
      ) : (
        <>
          <Button title={t("import.pickFile")} icon="doc" variant="outline" onPress={() => void pickFile()} />
          <TextInput
            accessibilityLabel={t("import.pasteLabel")}
            value={code}
            onChangeText={setCode}
            placeholder={t("import.pastePlaceholder")}
            placeholderTextColor={c.textFaint}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            style={[styles.code, { color: c.text, backgroundColor: c.surface, borderColor: c.border }]}
          />
        </>
      )}

      {payload && preview.isError ? (
        <T variant="footnote" color={c.danger}>
          {errorText(preview.error)}
        </T>
      ) : null}
      {p ? (
        <Card style={styles.preview}>
          <T variant="headline">{p.title}</T>
          <T variant="footnote" muted>
            {[t("import.messages", { count: p.messages }), p.files > 0 ? t("import.files", { count: p.files }) : null, p.withContext ? t("import.withContext") : null].filter(Boolean).join(" · ")}
          </T>
          <T variant="footnote" muted>
            {t("import.from", { agent: p.agentName || "-", date: format(new Date(p.exportedAt), "PPp", { locale: dateLocale() }) })}
          </T>
        </Card>
      ) : null}

      <View style={{ gap: space.sm }}>
        <T variant="eyebrow" muted style={{ paddingHorizontal: space.xs }}>
          {t("import.continueWith")}
        </T>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
          {usable.map((a) => {
            const active = a.id === agent?.id;
            return (
              <Pressable
                key={a.id}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => {
                  tap();
                  setPicked(a.id);
                }}
                style={[styles.chip, { backgroundColor: active ? c.primary : c.sunken }]}
              >
                <CharacterAvatar agent={a} size={24} />
                <T variant="subhead" numberOfLines={1} color={active ? c.onPrimary : c.text} style={{ fontWeight: "600" }}>
                  {a.name}
                </T>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      <Button title={t("import.submit")} loading={importChat.isPending} disabled={!p || !agent} onPress={() => importChat.mutate()} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, justifyContent: "center" },
  content: { padding: space.xl, paddingBottom: 48, gap: space.lg },
  file: { flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.md },
  code: { minHeight: 88, maxHeight: 160, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, borderCurve: "continuous", padding: space.md, fontFamily: fonts.mono, fontSize: 12 },
  preview: { padding: space.lg, gap: 4 },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, height: 36, paddingLeft: 8, paddingRight: 14, borderRadius: radius.pill },
});
