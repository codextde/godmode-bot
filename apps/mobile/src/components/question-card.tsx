import { format } from "date-fns";
import { createContext, useContext, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, TextInput, View } from "react-native";
import type { AnswerQuestionInput, MessageBlock } from "@godmode/shared";
import { Icon } from "./icon";
import { Markdown } from "./markdown";
import { T, tap } from "./ui";
import { ApiError, api, errorText } from "@/lib/api";
import { useLive } from "@/lib/live";
import { qk, queryClient } from "@/lib/query";
import { radius, space, type, useColors } from "@/lib/theme";

type QuestionBlock = Extract<MessageBlock, { type: "question" }>;

/** What a chat tells its messages: whose chat it is and which question its run stands still for. */
export interface ChatScopeValue {
  conversationId: string;
  agentName: string;
  openQuestionId: string | null;
}

export const ChatScope = createContext<ChatScopeValue | null>(null);

/** Answer a question with an option, a decision or text; the run that asked continues with it. */
export async function answerQuestion(id: string, input: AnswerQuestionInput, conversationId?: string): Promise<boolean> {
  try {
    const { question, run } = await api.questions.answer(id, input);
    useLive.getState().runStarted(run);
    void queryClient.invalidateQueries({ queryKey: qk.questions });
    void queryClient.invalidateQueries({ queryKey: qk.bootstrap });
    void queryClient.invalidateQueries({ queryKey: qk.conversation(conversationId ?? question.conversationId) });
    return true;
  } catch (err) {
    void queryClient.invalidateQueries({ queryKey: qk.questions });
    if (conversationId) void queryClient.invalidateQueries({ queryKey: qk.conversation(conversationId) });
    const settled = err instanceof ApiError && err.code === "question_closed";
    Alert.alert(settled ? "Already settled" : "Couldn't send your answer", errorText(err));
    return false;
  }
}

/**
 * A question or an approval the agent asked. While the run waits for it: one tap on an option, or Approve / Decline
 * (with a note). Afterwards it is the record of what was asked and answered.
 */
export function QuestionCard({ question: q, streaming }: { question: QuestionBlock; streaming?: boolean }) {
  const c = useColors();
  const scope = useContext(ChatScope);
  const [pressed, setPressed] = useState<string | null>(null);
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");

  const approval = q.kind === "approval";
  const open = q.status === "open";
  const answerable = open && !streaming && scope?.openQuestionId === q.id;
  const lost = open && !streaming && !!scope && scope.openQuestionId !== q.id;
  const agentName = scope?.agentName ?? "The agent";
  const busy = pressed !== null;

  const send = (key: string, input: AnswerQuestionInput) => {
    if (busy) return;
    tap();
    setPressed(key);
    void answerQuestion(q.id, input, scope?.conversationId).finally(() => setPressed(null));
  };
  const decide = (decision: "approve" | "decline") => send(decision, { decision, ...(note.trim() ? { note: note.trim() } : {}) });

  if (q.status === "withdrawn" || lost) {
    return (
      <View style={[styles.card, styles.withdrawn, { borderColor: c.borderStrong }]}>
        <T variant="eyebrow" muted>
          {approval ? "Approval withdrawn" : "Question withdrawn"}
        </T>
        <T variant="subhead" muted style={{ textDecorationLine: "line-through" }}>
          {q.title}
        </T>
        <T variant="footnote" muted>
          The run was stopped before this was answered.
        </T>
      </View>
    );
  }

  const chosen = q.answer?.optionId ? q.options.find((o) => o.id === q.answer!.optionId) : undefined;
  const approved = q.status === "approved";

  return (
    <View style={[styles.card, { backgroundColor: open ? c.warningSoft : c.surface, borderColor: open ? c.warning : c.border }]} accessibilityRole="summary">
      <View style={styles.head}>
        <Icon name={approval ? "shield" : "warning"} size={13} color={open ? c.warning : c.textMuted} />
        <T variant="eyebrow" color={open ? c.warning : c.textMuted}>
          {approval ? (open ? "Needs your OK" : "Approval") : "Question"}
        </T>
      </View>
      <T variant="body" style={{ fontWeight: "600" }} selectable>
        {q.title}
      </T>
      {q.body ? (
        approval ? (
          <T variant="footnote" muted selectable>
            <T variant="footnote" style={{ fontWeight: "600" }}>
              Why{" "}
            </T>
            {q.body}
          </T>
        ) : (
          <Markdown text={q.body} color={c.textMuted} />
        )
      ) : null}
      {approval && q.affects ? (
        <T variant="footnote" muted selectable>
          <T variant="footnote" style={{ fontWeight: "600" }}>
            Affects{" "}
          </T>
          {q.affects}
        </T>
      ) : null}

      {!approval && q.options.length > 0 && (
        <View style={{ gap: 6, marginTop: 2 }}>
          {q.options.map((o, i) => {
            const picked = chosen?.id === o.id;
            const primary = open && !!o.recommended;
            const fg = primary ? c.onPrimary : c.text;
            return (
              <Pressable
                key={o.id}
                accessibilityRole="button"
                accessibilityLabel={`${o.label}${o.recommended ? ", recommended" : ""}`}
                accessibilityState={{ disabled: !answerable || busy, selected: picked }}
                disabled={!answerable || busy}
                onPress={() => send(o.id, { optionId: o.id })}
                style={({ pressed: down }) => [
                  styles.option,
                  { backgroundColor: primary ? c.primary : c.surface, borderColor: picked ? c.brand : c.border, opacity: down ? 0.7 : !open && !picked ? 0.5 : 1 },
                ]}
              >
                <View style={[styles.number, { borderColor: primary ? c.onPrimary : c.borderStrong }]}>
                  {pressed === o.id ? (
                    <ActivityIndicator size="small" color={fg} />
                  ) : picked ? (
                    <Icon name="check" size={11} color={c.brandStrong} weight="bold" />
                  ) : (
                    <T variant="caption" color={fg} style={{ fontWeight: "600" }}>
                      {i + 1}
                    </T>
                  )}
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T variant="subhead" color={fg} style={{ fontWeight: "600" }}>
                    {o.label}
                  </T>
                  {o.description ? (
                    <T variant="footnote" color={fg} style={{ opacity: 0.72 }}>
                      {o.description}
                    </T>
                  ) : null}
                </View>
                {o.recommended ? (
                  <T variant="caption" color={fg} style={{ opacity: 0.72, fontWeight: "600" }}>
                    Recommended
                  </T>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      )}

      {approval && open && (
        <View style={{ gap: space.sm, marginTop: 2 }}>
          {noting && (
            <TextInput
              autoFocus
              multiline
              value={note}
              onChangeText={setNote}
              placeholder={`Note for ${agentName} (optional)`}
              placeholderTextColor={c.textFaint}
              accessibilityLabel={`Note for ${agentName}`}
              maxLength={2000}
              style={[type.subhead, styles.note, { color: c.text, backgroundColor: c.surface, borderColor: c.border }]}
            />
          )}
          <View style={styles.decide}>
            <Decision label="Approve" icon="check" primary busy={pressed === "approve"} disabled={!answerable || busy} onPress={() => decide("approve")} />
            <Decision label="Decline" icon="close" busy={pressed === "decline"} disabled={!answerable || busy} onPress={() => decide("decline")} />
            {!noting && answerable ? (
              <Pressable accessibilityRole="button" hitSlop={8} onPress={() => setNoting(true)} style={{ paddingHorizontal: 6 }}>
                <T variant="footnote" muted style={{ fontWeight: "600" }}>
                  Add a note
                </T>
              </Pressable>
            ) : null}
          </View>
        </View>
      )}

      {open ? (
        <T variant="footnote" muted>
          {streaming || !answerable
            ? `${agentName} is finishing the step it was in…`
            : approval
              ? "Or reply below: your message counts as the answer."
              : q.options.length
                ? "Or type your own answer below."
                : "Reply below to answer."}
        </T>
      ) : q.answer ? (
        <View style={[styles.settled, { borderTopColor: c.border }]}>
          <Icon name={q.status === "declined" ? "close" : "check"} size={12} color={approved ? c.brandStrong : c.textMuted} weight="bold" />
          <T variant="footnote" color={approved ? c.brandStrong : c.textMuted} style={{ flex: 1 }} selectable>
            {approved ? "You approved" : q.status === "declined" ? "You declined" : chosen ? `You chose ${chosen.label}` : "You answered"}
            {q.answer.via === "phone" ? " from your phone" : ""} · {format(new Date(q.answer.at), "HH:mm")}
            {q.answer.text && !chosen ? `\n${q.answer.text}` : ""}
          </T>
        </View>
      ) : null}
    </View>
  );
}

function Decision({ label, icon, primary, busy, disabled, onPress }: { label: string; icon: "check" | "close"; primary?: boolean; busy: boolean; disabled: boolean; onPress: () => void }) {
  const c = useColors();
  const fg = primary ? c.onPrimary : c.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.decision, { backgroundColor: primary ? c.primary : c.surface, borderColor: primary ? c.primary : c.borderStrong, opacity: disabled && !busy ? 0.45 : pressed ? 0.75 : 1 }]}
    >
      {busy ? <ActivityIndicator size="small" color={fg} /> : <Icon name={icon} size={13} color={fg} weight="bold" />}
      <T variant="subhead" color={fg} style={{ fontWeight: "600" }}>
        {label}
      </T>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: 8,
    padding: space.md,
    borderRadius: radius.md,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  withdrawn: {
    borderStyle: "dashed",
    gap: 4,
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 44,
    paddingHorizontal: space.md,
    paddingVertical: 9,
    borderRadius: radius.sm,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  number: {
    width: 22,
    height: 22,
    borderRadius: 7,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  note: {
    minHeight: 64,
    padding: space.md,
    borderRadius: radius.sm,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    textAlignVertical: "top",
  },
  decide: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  decision: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 40,
    minWidth: 104,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  settled: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
