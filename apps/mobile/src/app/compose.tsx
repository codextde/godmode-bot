import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { Composer } from "@/components/composer";
import { T, tap } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { useLive } from "@/lib/live";
import { radius, space, useColors } from "@/lib/theme";

const IDEAS = ["Check my inbox and summarize what needs me", "Find the cheapest flight to Berlin next Friday", "What did you work on today?"];

/** A new chat: pick who does it, say what to do. */
export default function Compose() {
  const c = useColors();
  const { agentId } = useLocalSearchParams<{ agentId?: string }>();
  const { data: agents } = useAgents();
  const enabled = (agents ?? []).filter((a) => a.enabled);
  const [picked, setPicked] = useState<string | undefined>(agentId);
  const current = enabled.find((a) => a.id === picked) ?? enabled.find((a) => a.isDefault) ?? enabled[0];
  const [idea, setIdea] = useState("");

  const start = async (content: string) => {
    try {
      const result = await api.chat.start({ agentId: current?.id, content });
      useLive.getState().runStarted(result.run);
      router.dismiss();
      router.push({ pathname: "/chat/[id]", params: { id: result.conversation.id } });
    } catch (err) {
      Alert.alert("Couldn't start the chat", errorText(err));
      throw err;
    }
  };

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <T variant="title" style={{ paddingHorizontal: space.xl }}>
        New chat
      </T>
      <View style={styles.agents}>
        {enabled.map((a) => {
          const active = a.id === current?.id;
          return (
            <Pressable
              key={a.id}
              onPress={() => {
                tap();
                setPicked(a.id);
              }}
              style={[styles.chip, { backgroundColor: active ? c.primary : c.sunken }]}
            >
              <T style={{ fontSize: 16 }}>{a.avatar}</T>
              <T variant="subhead" color={active ? c.onPrimary : c.text} style={{ fontWeight: "600" }}>
                {a.name}
              </T>
            </Pressable>
          );
        })}
      </View>
      <View style={{ paddingHorizontal: space.md }}>
        <Composer key={idea} defaultValue={idea} onSend={start} autoFocus placeholder={current ? `What should ${current.name} do?` : "What should Godmode do?"} />
      </View>
      <View style={{ paddingHorizontal: space.xl, gap: space.sm }}>
        <T variant="eyebrow" muted>
          Try
        </T>
        {IDEAS.map((text) => (
          <Pressable key={text} onPress={() => {
              tap();
              setIdea(text);
            }} style={({ pressed }) => [styles.idea, { borderColor: c.border, opacity: pressed ? 0.6 : 1 }]}>
            <T variant="subhead" muted>
              {text}
            </T>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    paddingTop: 28,
    gap: space.lg,
  },
  agents: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.sm,
    paddingHorizontal: space.xl,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 36,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
  },
  idea: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
