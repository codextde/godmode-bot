import { useState, type ReactNode } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { SshAssignment, SshExecResult, SshServer } from "@godmode/shared";
import { CharacterAvatar } from "./character";
import { Group } from "./form";
import { Icon } from "./icon";
import { ActionRow, TestResult, TextRow } from "./tool-form";
import { T, tap } from "./ui";
import { errorText } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { qk, queryClient } from "@/lib/query";
import { putServer, sshAdmin } from "@/lib/ssh-admin";
import { space, useColors } from "@/lib/theme";

/** The agents and chats that use a server: taken off with a tap, agents added from the list. */
export function UsedByGroup({ server }: { server: SshServer }) {
  const { t } = useTranslation("ssh");
  const agents = useAgents();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const assigned = new Set(server.assignments.filter((a) => a.kind === "agent").map((a) => a.id));
  const others = (agents.data ?? []).filter((a) => !assigned.has(a.id));

  const set = async (kind: SshAssignment["kind"], id: string, on: boolean) => {
    setBusy(id);
    try {
      putServer(await sshAdmin.assign(server.id, { kind, id, assigned: on }));
      void queryClient.invalidateQueries({ queryKey: kind === "agent" ? qk.agents : qk.conversation(id) });
    } catch (err) {
      Alert.alert(t("usedBy.failed"), errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Group title={t("usedBy.title")}>
      {server.assignments.length ? null : (
        <View style={styles.row}>
          <T variant="subhead" muted>
            {t("usedBy.none")}
          </T>
        </View>
      )}
      {server.assignments.map((a) => (
        <Assigned
          key={`${a.kind}-${a.id}`}
          label={a.name || (a.kind === "agent" ? t("usedBy.agent") : t("usedBy.untitledChat"))}
          agent={a.kind === "agent" ? agents.byId.get(a.id) : undefined}
          busy={busy === a.id}
          removeLabel={t("usedBy.remove", { name: a.name })}
          onRemove={() => void set(a.kind, a.id, false)}
        />
      ))}
      {others.length ? <ActionRow icon={adding ? "up" : "plus"} title={t("usedBy.add")} onPress={() => setAdding((v) => !v)} /> : null}
      {adding
        ? others.map((a) => (
            <AddAgentRow key={a.id} name={a.name} busy={busy === a.id} onPress={() => void set("agent", a.id, true)}>
              <CharacterAvatar agent={a} size={26} />
            </AddAgentRow>
          ))
        : null}
    </Group>
  );
}

function Assigned({ label, agent, busy, removeLabel, onRemove }: { label: string; agent?: Parameters<typeof CharacterAvatar>[0]["agent"]; busy: boolean; removeLabel: string; onRemove: () => void }) {
  const c = useColors();
  return (
    <View style={[styles.row, busy && { opacity: 0.5 }]}>
      {agent ? <CharacterAvatar agent={agent} size={26} /> : <Icon name="chats" size={18} color={c.textMuted} />}
      <T variant="callout" numberOfLines={1} style={{ flex: 1, fontWeight: "500" }}>
        {label}
      </T>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={removeLabel}
        hitSlop={8}
        disabled={busy}
        onPress={() => {
          tap();
          onRemove();
        }}
      >
        <Icon name="closeCircle" size={18} color={c.textFaint} />
      </Pressable>
    </View>
  );
}

function AddAgentRow({ name, busy, onPress, children }: { name: string; busy: boolean; onPress: () => void; children: ReactNode }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      disabled={busy}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [styles.row, { backgroundColor: pressed ? c.sunken : c.surfaceAlt, opacity: busy ? 0.5 : 1 }]}
    >
      {children}
      <T variant="callout" numberOfLines={1} style={{ flex: 1 }}>
        {name}
      </T>
      <Icon name="plus" size={14} color={c.brandStrong} />
    </Pressable>
  );
}

/** One command as the server's user, with what it printed. */
export function CommandGroup({ server }: { server: SshServer }) {
  const { t } = useTranslation("ssh");
  const [command, setCommand] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ command: string; result: SshExecResult } | { command: string; error: string } | null>(null);

  const run = async () => {
    const cmd = command.trim();
    if (!cmd || running) return;
    setRunning(true);
    try {
      setResult({ command: cmd, result: await sshAdmin.exec(server.id, cmd) });
    } catch (err) {
      setResult({ command: cmd, error: errorText(err) });
    } finally {
      setRunning(false);
    }
  };

  const outcome = result && "result" in result ? result.result : null;
  const took = outcome ? (outcome.durationMs < 1000 ? `${outcome.durationMs} ms` : `${(outcome.durationMs / 1000).toFixed(1)} s`) : "";
  return (
    <Group title={t("command.title")} footer={t("command.runsAs", { user: server.username, host: server.host })}>
      <TextRow label={t("command.label")} value={command} onChange={setCommand} placeholder="uptime && df -h /" mono stacked />
      <ActionRow icon="play" title={running ? t("command.running") : t("command.run")} busy={running} onPress={() => void run()} />
      {result && !running ? (
        "error" in result ? (
          <TestResult ok={false} title={t("command.failed")} body={result.error} />
        ) : (
          <TestResult
            ok={outcome!.exitCode === 0 && !outcome!.timedOut}
            title={[`exit ${outcome!.exitCode ?? "–"}`, outcome!.timedOut ? t("command.timedOut") : null, took].filter(Boolean).join(" · ")}
            body={[outcome!.stdout, outcome!.stderr].filter(Boolean).join("\n").trim() || t("command.noOutput")}
          />
        )
      ) : null}
    </Group>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 50,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
  },
});
