import { addDays, addHours, formatDistanceStrict, nextMonday, setHours, startOfHour } from "date-fns";
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, View } from "react-native";
import type { Agent, Followup } from "@godmode/shared";
import { CharacterAvatar } from "./character";
import { MenuSheet, type HeaderMenuItem } from "./header-actions";
import { Icon, type IconName } from "./icon";
import { openChat } from "./rows";
import { Card, Hairline, T, tap } from "./ui";
import { ApiError, api, errorText } from "@/lib/api";
import { whenText } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { useLive, useRunningChats } from "@/lib/live";
import { qk, queryClient } from "@/lib/query";
import { radius, space, useColors } from "@/lib/theme";

/** "in 3 hours", "in 12 minutes", "any moment" */
function followupIn(iso: string, now: number): string {
  if (new Date(iso).getTime() - now < 60_000) return "any moment";
  return `in ${formatDistanceStrict(new Date(iso), now, { roundingMethod: "floor" })}`;
}

function refresh(conversationId: string) {
  void queryClient.invalidateQueries({ queryKey: qk.followups });
  void queryClient.invalidateQueries({ queryKey: qk.conversation(conversationId) });
  void queryClient.invalidateQueries({ queryKey: qk.conversations, predicate: (q) => q.queryKey[1] !== "detail" });
}

const failed = (title: string) => (err: unknown) =>
  Alert.alert(title, err instanceof ApiError && err.code === "device_forbidden" ? "Update Godmode on your computer to change follow-ups from the phone." : errorText(err));

/** Like the desktop's time picker: the next hours, this evening, tomorrow morning, next Monday, a week. */
function moves(now: Date): { title: string; at: Date }[] {
  const morning = (d: Date) => setHours(startOfHour(d), 9);
  return [
    { title: "In 1 hour", at: addHours(now, 1) },
    { title: "In 3 hours", at: addHours(now, 3) },
    now.getHours() < 17 ? { title: "This evening", at: setHours(startOfHour(now), 18) } : { title: "In 12 hours", at: addHours(now, 12) },
    { title: "Tomorrow morning", at: morning(addDays(now, 1)) },
    { title: "Next Monday", at: morning(nextMonday(now)) },
    { title: "In a week", at: morning(addDays(now, 7)) },
  ];
}

/** Chats agents will pick up again on their own (followup_schedule), soonest first. Nothing when there are none. */
export function FollowupsSection({ followups, agents }: { followups: Followup[]; agents: Map<string, Agent> }) {
  const c = useColors();
  const now = useNow(30_000);
  const running = useRunningChats();
  if (!followups.length) return null;
  const sorted = [...followups].sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  return (
    <View>
      <View style={styles.heading}>
        <Icon name="clock" size={12} color={c.textMuted} />
        <T variant="eyebrow" muted>
          Follow-ups
        </T>
      </View>
      <T variant="footnote" muted style={styles.hint}>
        Chats your agents will pick up again on their own
      </T>
      <Card style={{ overflow: "hidden" }}>
        {sorted.map((f, i) => (
          <View key={f.conversationId}>
            {i > 0 && <Hairline inset={space.lg + 32 + space.md} />}
            <FollowupRow followup={f} agent={agents.get(f.agentId)} now={now} working={running.has(f.conversationId)} />
          </View>
        ))}
      </Card>
    </View>
  );
}

function FollowupRow({ followup: f, agent, now, working }: { followup: Followup; agent?: Agent; now: number; working: boolean }) {
  const c = useColors();
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const id = f.conversationId;
  const title = f.title || "A chat";

  const runNow = () => {
    setBusy(true);
    api.conversations.followup
      .runNow(id)
      .then((run) => {
        useLive.getState().runStarted(run);
        refresh(id);
      })
      .catch(failed("Couldn't continue now"))
      .finally(() => setBusy(false));
  };
  const move = (at: Date) => void api.conversations.followup.move(id, at.toISOString()).then(() => refresh(id), failed("Couldn't move the follow-up"));
  const cancel = () => {
    const before = queryClient.getQueryData<Followup[]>(qk.followups);
    queryClient.setQueryData<Followup[]>(qk.followups, (list) => list?.filter((x) => x.conversationId !== id));
    api.conversations.followup
      .cancel(id)
      .then(() => refresh(id))
      .catch((err) => {
        queryClient.setQueryData(qk.followups, before);
        failed("Couldn't cancel the follow-up")(err);
      });
  };
  const items: HeaderMenuItem[] = [
    ...(working ? [] : [{ icon: "play" as IconName, title: "Continue now", onPress: runNow }]),
    ...moves(new Date()).map((m) => ({ icon: "clock" as IconName, title: m.title, onPress: () => move(m.at) })),
    { icon: "close", title: "Cancel the follow-up", destructive: true, onPress: cancel },
  ];

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}, continues ${whenText(f.dueAt)}`}
        onPress={() => openChat(id)}
        style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
      >
        <CharacterAvatar agent={agent} size={32} running={working} />
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <T variant="subhead" numberOfLines={1} style={{ fontWeight: "600" }}>
            {title}
          </T>
          <T variant="footnote" muted numberOfLines={1}>
            {agent ? `${agent.name} · ` : ""}
            {working ? "Working in this chat right now" : `${whenText(f.dueAt)} · ${followupIn(f.dueAt, now)}`}
          </T>
          {f.note ? (
            <T variant="footnote" muted numberOfLines={2}>
              {f.note}
            </T>
          ) : null}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Continue “${title}” now`}
          accessibilityState={{ disabled: working || busy, busy }}
          hitSlop={6}
          // Not `disabled`: a press on it must not fall through to the row and open the chat.
          onPress={() => {
            if (working || busy) return;
            tap();
            runNow();
          }}
          style={({ pressed }) => [styles.action, { backgroundColor: c.sunken, opacity: busy ? 1 : working ? 0.4 : pressed ? 0.6 : 1 }]}
        >
          {busy ? <ActivityIndicator size="small" color={c.textMuted} /> : <Icon name="play" size={12} color={c.text} />}
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Change when “${title}” continues`}
          hitSlop={6}
          onPress={() => {
            tap();
            setMenu(true);
          }}
          style={({ pressed }) => [styles.action, { backgroundColor: c.sunken, opacity: pressed ? 0.6 : 1 }]}
        >
          <Icon name="more" size={14} color={c.text} />
        </Pressable>
      </Pressable>
      <MenuSheet items={items} open={menu} onClose={() => setMenu(false)} />
    </>
  );
}

const styles = StyleSheet.create({
  heading: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 4,
  },
  hint: {
    paddingHorizontal: 4,
    marginTop: 2,
    marginBottom: space.sm,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
  },
  action: {
    width: 32,
    height: 32,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
});
