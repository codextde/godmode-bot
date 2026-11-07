import { useQuery } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router, Stack, useLocalSearchParams, useNavigation } from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { SshAuthMethod, SshGeneratedKey, SshHostKey, SshLocalKey, SshServer, SshServerInput, SshServerPatch, SshTestResult } from "@godmode/shared";
import { AdminQueryState, FullAccessGate } from "@/components/admin";
import { ChoiceRow, Group, Segmented, SwitchRow } from "@/components/form";
import { HeaderActions } from "@/components/header-actions";
import { Icon } from "@/components/icon";
import { ListRow } from "@/components/readonly-list";
import { CommandGroup, UsedByGroup } from "@/components/ssh-server-extras";
import { ActionRow, TestResult, TextRow } from "@/components/tool-form";
import { EmptyState, T, tap } from "@/components/ui";
import { errorText } from "@/lib/api";
import { useSshServers } from "@/lib/integrations";
import { copyPlain } from "@/lib/secrets";
import { keyTypeLabel, looksLikePublicKey, parseSshTarget, putServer, refreshServers, shortFingerprint, sk, sshAdmin } from "@/lib/ssh-admin";
import { space, useColors } from "@/lib/theme";

type KeySource = { kind: "paste" } | { kind: "local"; key: SshLocalKey } | { kind: "generated"; key: SshGeneratedKey };
type Tested = { sig: string; result: SshTestResult } | { sig: string; error: string };

/** Settings → SSH servers → a server: added, edited, tested and deleted like on the desktop (full access only). */
export default function SshServerScreen() {
  const { t } = useTranslation("ssh");
  const { id } = useLocalSearchParams<{ id?: string }>();
  const servers = useSshServers();
  const current = id ? servers.data?.find((s) => s.id === id) : undefined;
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={styles.content}
    >
      <Stack.Screen options={{ title: id ? (current?.name ?? "") : t("form.addTitle"), headerLargeTitleEnabled: false }} />
      <FullAccessGate>
        {id ? (
          <AdminQueryState query={servers} errorTitle={t("loadFailed")}>
            {(list) => {
              const server = list.find((s) => s.id === id);
              return server ? <ServerForm key={server.id} server={server} /> : <EmptyState icon="server" title={t("form.notFound")} />;
            }}
          </AdminQueryState>
        ) : (
          <ServerForm server={null} />
        )}
      </FullAccessGate>
    </ScrollView>
  );
}

function ServerForm({ server }: { server: SshServer | null }) {
  const { t } = useTranslation(["ssh", "common", "tools"]);
  const c = useColors();
  const navigation = useNavigation();
  const [name, setName] = useState(server?.name ?? "");
  const [host, setHost] = useState(server?.host ?? "");
  const [port, setPort] = useState(String(server?.port ?? 22));
  const [username, setUsername] = useState(server?.username ?? "");
  const [auth, setAuth] = useState<SshAuthMethod>(server?.auth ?? "password");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [keySource, setKeySource] = useState<KeySource>({ kind: "paste" });
  const [replacingKey, setReplacingKey] = useState(false);
  const [pickLocal, setPickLocal] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [sudoPassword, setSudoPassword] = useState("");
  const [removeSudo, setRemoveSudo] = useState(false);
  const [description, setDescription] = useState(server?.description ?? "");
  const [installGodmode, setInstallGodmode] = useState(true);
  const [shareLogins, setShareLogins] = useState(server?.shareLogins ?? false);
  const [trustNewKey, setTrustNewKey] = useState(false);
  const [tested, setTested] = useState<Tested | null>(null);
  const [testing, setTesting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const exit = useRef<Parameters<typeof navigation.dispatch>[0] | null>(null);

  const localKeys = useQuery({ queryKey: sk.localKeys, queryFn: sshAdmin.localKeys, enabled: auth === "key", staleTime: 30_000, retry: false });

  const editing = !!server;
  const savedKey = server?.key && !replacingKey ? server.key : null;
  const savedPassword = !!server?.hasPassword;
  const portNum = Number(port);
  const newKeyGiven = keySource.kind !== "paste" || privateKey.trim() !== "";

  const secrets = (): Partial<SshServerInput> => {
    const out: Partial<SshServerInput> = {};
    if (auth === "password") {
      if (password) out.password = password;
      return out;
    }
    if (!savedKey) {
      if (keySource.kind === "local") out.privateKeyPath = keySource.key.path;
      else out.privateKey = keySource.kind === "generated" ? keySource.key.privateKey : privateKey;
      if (passphrase || server?.key) out.passphrase = passphrase;
    } else if (passphrase) out.passphrase = passphrase;
    if (sudoPassword) out.password = sudoPassword;
    else if (removeSudo && savedPassword) out.password = "";
    return out;
  };

  const problem = (forTest = false): string | null => {
    if (!forTest && !name.trim() && !host.trim()) return t("ssh:errors.name");
    if (!host.trim()) return t("ssh:errors.host");
    if (/\s|@/.test(host.trim())) return t("ssh:errors.hostOnly");
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return t("ssh:errors.port");
    if (!username.trim()) return t("ssh:errors.username");
    if (auth === "password" && !password && !(editing && savedPassword)) return t("ssh:errors.password");
    if (auth === "key" && !savedKey) {
      if (keySource.kind === "paste" && looksLikePublicKey(privateKey)) return t("ssh:errors.publicKey");
      if (!newKeyGiven) return t("ssh:errors.keyMissing");
    }
    return null;
  };

  const sig = JSON.stringify([host.trim(), portNum, username.trim(), auth, secrets()]);
  const current = tested?.sig === sig ? tested : null;
  const result = current && "result" in current ? current.result : null;
  const seenKey = result?.hostKey ?? null;
  const pinKey: SshHostKey | null = seenKey && ((result?.ok && !result.hostKeyChanged) || (result?.hostKeyChanged && trustNewKey)) ? seenKey : null;

  const baseInput = (): SshServerInput => ({
    name: name.trim() || host.trim(),
    host: host.trim(),
    port: portNum,
    username: username.trim(),
    auth,
    description: description.trim(),
    shareLogins,
    ...secrets(),
  });

  const patch: SshServerPatch = {};
  if (server) {
    const input = baseInput();
    if (input.name !== server.name) patch.name = input.name;
    if (input.host !== server.host) patch.host = input.host;
    if (input.port !== server.port) patch.port = input.port;
    if (input.username !== server.username) patch.username = input.username;
    if (input.auth !== server.auth) patch.auth = input.auth;
    if (input.description !== server.description) patch.description = input.description;
    if (input.shareLogins !== server.shareLogins) patch.shareLogins = input.shareLogins;
    Object.assign(patch, secrets());
    if (pinKey && (pinKey.fingerprint !== server.hostKey?.fingerprint || pinKey.type !== server.hostKey?.type)) patch.hostKey = pinKey;
  }
  const dirty = !leaving && (server ? Object.keys(patch).length > 0 : !!(name.trim() || host.trim() || username.trim() || password || privateKey || keySource.kind !== "paste"));
  const reconnects = ["host", "port", "username", "auth", "password", "privateKey", "privateKeyPath", "passphrase", "hostKey"].some((k) => k in patch);

  // Leaves once the form no longer holds the screen: the navigation that was stopped, or back.
  useEffect(() => {
    if (!leaving) return;
    if (exit.current) navigation.dispatch(exit.current);
    else router.back();
  }, [leaving, navigation]);

  usePreventRemove(dirty, ({ data }) => {
    Alert.alert(t("tools:discard.title"), undefined, [
      { text: t("tools:discard.keep"), style: "cancel" },
      {
        text: t("tools:discard.discard"),
        style: "destructive",
        onPress: () => {
          exit.current = data.action;
          setLeaving(true);
        },
      },
    ]);
  });

  const onHostBlur = () => {
    const parsed = parseSshTarget(host);
    if (!parsed) return;
    setHost(parsed.host);
    if (parsed.username) setUsername(parsed.username);
    if (parsed.port) setPort(String(parsed.port));
  };

  const test = async () => {
    if (testing) return;
    const wrong = problem(true);
    if (wrong) return Alert.alert(t("ssh:errors.title"), wrong);
    const input = { ...baseInput(), id: server?.id };
    if (trustNewKey && seenKey) input.hostKey = seenKey;
    const at = sig;
    setTesting(true);
    try {
      const res = await sshAdmin.try(input);
      setTrustNewKey(false);
      setTested({ sig: at, result: res });
      void Haptics.notificationAsync(res.ok ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Error).catch(() => undefined);
    } catch (err) {
      setTested({ sig: at, error: errorText(err) });
    } finally {
      setTesting(false);
    }
  };

  const generate = async () => {
    if (generating) return;
    setGenerating(true);
    try {
      const key = await sshAdmin.generateKey(`godmode-${(name.trim() || host.trim() || "server").toLowerCase().replace(/[^a-z0-9.-]+/g, "-")}`);
      setKeySource({ kind: "generated", key });
      setPrivateKey("");
      setPassphrase("");
      setPickLocal(false);
    } catch (err) {
      Alert.alert(t("ssh:form.generateFailed"), errorText(err));
    } finally {
      setGenerating(false);
    }
  };

  const clearKey = () => {
    setKeySource({ kind: "paste" });
    setPrivateKey("");
    setPassphrase("");
  };

  const save = async () => {
    if (saving) return;
    const wrong = problem();
    if (wrong) return Alert.alert(t("ssh:errors.title"), wrong);
    if (server && !Object.keys(patch).length) return setLeaving(true);
    setSaving(true);
    try {
      if (server) {
        const next = await sshAdmin.update(server.id, patch);
        putServer(next);
        if (reconnects) void sshAdmin.test(next.id).catch(() => undefined).finally(refreshServers);
      } else {
        const created = await sshAdmin.create({ ...baseInput(), ...(pinKey ? { hostKey: pinKey } : {}) });
        putServer(created);
        void sshAdmin.test(created.id).catch(() => undefined).finally(refreshServers);
        if (installGodmode) void sshAdmin.installGodmode(created.id).catch((err) => Alert.alert(t("ssh:form.installFailed"), errorText(err)));
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      setLeaving(true);
    } catch (err) {
      Alert.alert(server ? t("ssh:form.saveFailed") : t("ssh:form.addFailed"), errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const forgetHostKey = () =>
    Alert.alert(t("ssh:form.forgetHostKeyTitle"), t("ssh:form.forgetHostKeyBody"), [
      { text: t("common:actions.cancel"), style: "cancel" },
      {
        text: t("ssh:form.forgetHostKey"),
        style: "destructive",
        onPress: async () => {
          if (!server) return;
          try {
            putServer(await sshAdmin.update(server.id, { hostKey: null }));
          } catch (err) {
            Alert.alert(t("ssh:form.saveFailed"), errorText(err));
          }
        },
      },
    ]);

  const remove = () => {
    if (!server) return;
    const users = server.assignments.length;
    const body = [
      server.auth === "key" ? (server.hasPassword ? t("ssh:delete.bodyKeyAndSudo") : t("ssh:delete.bodyKey")) : t("ssh:delete.bodyPassword"),
      users === 1 ? (server.assignments[0]?.name ? t("ssh:delete.oneUser", { name: server.assignments[0].name }) : t("ssh:delete.oneUserFallback")) : null,
      users > 1 ? t("ssh:delete.manyUsers", { n: users }) : null,
    ]
      .filter(Boolean)
      .join(" ");
    Alert.alert(t("ssh:delete.title", { name: server.name }), body, [
      { text: t("common:actions.cancel"), style: "cancel" },
      {
        text: t("ssh:delete.confirm"),
        style: "destructive",
        onPress: async () => {
          try {
            await sshAdmin.remove(server.id);
            refreshServers();
            setLeaving(true);
          } catch (err) {
            Alert.alert(t("ssh:delete.failed"), errorText(err));
          }
        },
      },
    ]);
  };

  const keys = localKeys.data ?? [];
  const localEncrypted = keySource.kind === "local" && keySource.key.encrypted;

  return (
    <>
      {dirty || !server ? <HeaderActions actions={[{ icon: "check", label: t("common:actions.save"), prominent: true, onPress: () => void save() }]} /> : null}

      <Group>
        <TextRow label={t("ssh:form.name")} value={name} onChange={setName} placeholder={t("ssh:form.namePlaceholder")} maxLength={60} />
        <TextRow label={t("ssh:form.host")} value={host} onChange={setHost} onBlur={onHostBlur} placeholder="203.0.113.10" mono keyboardType="url" />
        <TextRow label={t("ssh:form.port")} value={port} onChange={(v) => setPort(v.replace(/\D/g, "").slice(0, 5))} mono keyboardType="number-pad" />
        <TextRow label={t("ssh:form.username")} value={username} onChange={setUsername} placeholder="root" mono />
      </Group>

      <Group title={t("ssh:form.signInWith")}>
        <View style={styles.segment}>
          <Segmented
            options={[
              { value: "password", label: t("ssh:form.password") },
              { value: "key", label: t("ssh:form.sshKey") },
            ]}
            value={auth}
            onChange={setAuth}
          />
        </View>
        {auth === "password" ? (
          <TextRow
            label={t("ssh:form.password")}
            value={password}
            onChange={setPassword}
            placeholder={editing && savedPassword ? t("ssh:form.savedKeep") : t("ssh:form.required")}
            secure
          />
        ) : null}
        {auth === "key" && savedKey ? (
          <ListRow
            grouped
            icon="sshKey"
            title={t("ssh:form.savedKey", { type: keyTypeLabel(savedKey.type) })}
            lines={[savedKey.fingerprint]}
            trailing={<Pill label={t("ssh:form.copyPublic")} onPress={() => void copyPlain(savedKey.publicKey)} />}
          />
        ) : null}
        {auth === "key" && savedKey ? <ActionRow icon="refresh" title={t("ssh:form.replaceKey")} onPress={() => setReplacingKey(true)} /> : null}
        {auth === "key" && !savedKey && keySource.kind !== "paste" ? (
          <ListRow
            grouped
            icon="sshKey"
            title={keySource.kind === "local" ? keySource.key.name : t("ssh:form.newKey")}
            lines={[`${keyTypeLabel(keySource.key.type)} · ${shortFingerprint(keySource.key.fingerprint, 24)}`]}
            trailing={<ClearButton label={t("ssh:form.useAnotherKey")} onPress={clearKey} />}
          />
        ) : null}
        {auth === "key" && !savedKey && keySource.kind === "paste" ? (
          <TextRow label={t("ssh:form.privateKey")} value={privateKey} onChange={setPrivateKey} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" mono multiline minHeight={88} />
        ) : null}
        {auth === "key" && !savedKey && keySource.kind === "paste" && keys.length ? (
          <ActionRow icon="laptop" title={t("ssh:form.fromThisComputer")} onPress={() => setPickLocal((v) => !v)} />
        ) : null}
        {auth === "key" && !savedKey && keySource.kind === "paste" && pickLocal
          ? keys.map((k) => (
              <ChoiceRow
                key={k.path}
                icon="sshKey"
                title={k.name}
                detail={[keyTypeLabel(k.type), k.fingerprint ? shortFingerprint(k.fingerprint, 20) : null, k.encrypted ? t("ssh:form.protected") : null].filter(Boolean).join(" · ")}
                selected={false}
                onPress={() => {
                  setKeySource({ kind: "local", key: k });
                  setPrivateKey("");
                  setPassphrase("");
                  setPickLocal(false);
                }}
              />
            ))
          : null}
        {auth === "key" && !savedKey && keySource.kind === "paste" ? (
          <ActionRow icon="key" title={generating ? t("ssh:form.generating") : t("ssh:form.generateKey")} busy={generating} onPress={() => void generate()} />
        ) : null}
        {auth === "key" && replacingKey ? (
          <ActionRow
            icon="reply"
            title={t("ssh:form.keepSavedKey")}
            onPress={() => {
              setReplacingKey(false);
              clearKey();
            }}
          />
        ) : null}
        {auth === "key" && keySource.kind !== "generated" && (!savedKey || savedKey.encrypted) ? (
          <TextRow
            label={t("ssh:form.passphrase")}
            value={passphrase}
            onChange={setPassphrase}
            placeholder={savedKey?.encrypted ? t("ssh:form.savedKeep") : localEncrypted ? t("ssh:form.required") : t("ssh:form.optional")}
            secure
          />
        ) : null}
        {auth === "key" ? (
          <TextRow
            label={t("ssh:form.sudoPassword")}
            value={sudoPassword}
            onChange={(v) => {
              setSudoPassword(v);
              if (v) setRemoveSudo(false);
            }}
            placeholder={removeSudo ? t("ssh:form.sudoRemoved") : editing && savedPassword ? t("ssh:form.savedKeep") : t("ssh:form.optional")}
            secure
          />
        ) : null}
        {auth === "key" && editing && savedPassword && !sudoPassword ? (
          <ActionRow icon={removeSudo ? "reply" : "trash"} title={removeSudo ? t("ssh:form.keepSudo") : t("ssh:form.removeSudo")} tone={removeSudo ? undefined : "danger"} onPress={() => setRemoveSudo((v) => !v)} />
        ) : null}
      </Group>

      {auth === "key" && keySource.kind === "generated" && !savedKey ? <AuthorizeGroup publicKey={keySource.key.publicKey} /> : null}

      <Group>
        <TextRow label={t("ssh:form.description")} value={description} onChange={setDescription} placeholder={t("ssh:form.descriptionPlaceholder")} multiline minHeight={72} maxLength={2000} />
      </Group>

      <Group>
        {!server ? <SwitchRow icon="package" title={t("ssh:form.installGodmode")} value={installGodmode} onChange={setInstallGodmode} /> : null}
        <SwitchRow icon="key" title={t("ssh:form.shareLogins")} detail={shareLogins ? t("ssh:form.shareLoginsOn") : undefined} value={shareLogins} onChange={setShareLogins} />
      </Group>

      <Group>
        <ActionRow icon="bolt" title={testing ? t("ssh:form.testing") : t("ssh:form.test")} busy={testing} onPress={() => void test()} />
        {current && !testing ? <TestOutcome tested={current} username={username.trim()} pinned={server?.hostKey ?? null} /> : null}
        {result?.hostKeyChanged && result.hostKey && !testing ? <SwitchRow icon="shield" title={t("ssh:result.trustNewKey")} value={trustNewKey} onChange={setTrustNewKey} /> : null}
      </Group>

      {server ? <UsedByGroup server={server} /> : null}
      {server ? <CommandGroup server={server} /> : null}

      {server ? (
        <Group>
          {server.hostKey ? <ActionRow icon="shield" title={t("ssh:form.forgetHostKey")} onPress={forgetHostKey} /> : null}
          <ActionRow icon="trash" title={t("ssh:delete.confirm")} tone="danger" onPress={remove} />
        </Group>
      ) : null}

      {saving ? (
        <View style={styles.saving}>
          <ActivityIndicator color={c.textMuted} />
        </View>
      ) : null}
    </>
  );
}

function TestOutcome({ tested, username, pinned }: { tested: Tested; username: string; pinned: SshHostKey | null }) {
  const { t } = useTranslation("ssh");
  if ("error" in tested) return <TestResult ok={false} title={t("result.couldNotConnect")} body={tested.error} />;
  const r = tested.result;
  if (r.hostKeyChanged && r.hostKey) {
    return <TestResult ok={false} title={t("result.hostKeyChangedTitle")} body={`${t("result.hostKeyChangedBody")}\n${keyTypeLabel(r.hostKey.type)} ${r.hostKey.fingerprint}`} />;
  }
  if (!r.ok) return <TestResult ok={false} title={r.stage ? t(`result.stage.${r.stage}`) : t("result.couldNotConnect")} body={r.error ?? undefined} />;
  const same = !!pinned && !!r.hostKey && pinned.fingerprint === r.hostKey.fingerprint;
  return (
    <TestResult
      ok
      title={[t("result.signedInAs", { user: username }), r.latencyMs !== null ? `${r.latencyMs} ms` : null].filter(Boolean).join(" · ")}
      body={[r.os, r.hostKey ? `${keyTypeLabel(r.hostKey.type)} ${r.hostKey.fingerprint}` : null, r.hostKey ? (same ? t("result.matchesPinned") : t("result.trustsOnly")) : null].filter(Boolean).join("\n")}
    />
  );
}

/** A new key works once its public half is on the server: the line to run there, and the key alone. */
function AuthorizeGroup({ publicKey }: { publicKey: string }) {
  const { t } = useTranslation("ssh");
  const command = `mkdir -p ~/.ssh && echo '${publicKey.trim()}' >> ~/.ssh/authorized_keys`;
  return (
    <Group title={t("authorize.title")}>
      <CodeRow text={command} label={t("authorize.copyCommand")} />
      <CodeRow text={publicKey.trim()} label={t("authorize.copyPublicKey")} />
    </Group>
  );
}

function CodeRow({ text, label }: { text: string; label: string }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => {
        tap();
        void copyPlain(text);
      }}
      style={({ pressed }) => [styles.code, pressed && { backgroundColor: c.sunken }]}
    >
      <T variant="mono" style={{ flex: 1, fontSize: 12 }} numberOfLines={4}>
        {text}
      </T>
      <Icon name="copy" size={15} color={c.textMuted} />
    </Pressable>
  );
}

function Pill({ label, onPress }: { label: string; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      hitSlop={6}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [styles.pill, { backgroundColor: c.sunken, opacity: pressed ? 0.7 : 1 }]}
    >
      <T variant="footnote" style={{ fontWeight: "600" }}>
        {label}
      </T>
    </Pressable>
  );
}

function ClearButton({ label, onPress }: { label: string; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={() => {
        tap();
        onPress();
      }}
      style={styles.clear}
    >
      <Icon name="closeCircle" size={18} color={c.textFaint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
  segment: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  code: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 12,
  },
  pill: {
    height: 30,
    paddingHorizontal: space.md,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  clear: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
  },
  saving: {
    alignItems: "center",
  },
});
