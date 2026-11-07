import { router } from "expo-router";
import { useMemo, useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { SshManagedKey } from "@godmode/shared";
import { useFullAccess } from "@/components/full-access";
import { HeaderActions } from "@/components/header-actions";
import { Icon } from "@/components/icon";
import { ListRow, ReadonlyList } from "@/components/readonly-list";
import { confirmDelete, RowMenu, type MenuItem } from "@/components/secret-parts";
import { TextPrompt } from "@/components/text-prompt";
import { Badge, Row, T, tap } from "@/components/ui";
import { ApiError, errorText } from "@/lib/api";
import { queryClient } from "@/lib/query";
import { copyPlain } from "@/lib/secrets";
import { fullVaultApi, useSshKeys, vk } from "@/lib/vault";
import { space, useColors } from "@/lib/theme";

const SEARCH_ABOVE = 6;

const refresh = () => void queryClient.invalidateQueries({ queryKey: vk.sshKeys });

/**
 * Keys in ~/.ssh of the computer: name, type and fingerprint; the public half can be copied. With full access keys are
 * made, parked, loaded into the agent and deleted here too. Private keys never leave the computer.
 */
export default function SshKeys() {
  const { t } = useTranslation(["vault", "common"]);
  const [asking, setAsking] = useState<SshManagedKey | null>(null);
  const c = useColors();
  const { fullAccess } = useFullAccess();
  const overview = useSshKeys();
  const agentOn = !!overview.data?.agent.available;
  const [search, setSearch] = useState("");
  const keys = overview.data?.keys;
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const hits = q ? (keys ?? []).filter((k) => [k.name, k.comment, k.fingerprint ?? "", ...k.hosts].some((v) => v.toLowerCase().includes(q))) : (keys ?? []);
    return [...hits].sort((a, b) => Number(b.enabled) - Number(a.enabled));
  }, [keys, search]);

  const copy = async (key: SshManagedKey) => {
    if (!key.publicKey) return;
    tap();
    await copyPlain(key.publicKey);
    Alert.alert(t("sshKeys.copied"), key.name);
  };
  const failed = (title: string) => (err: unknown) => Alert.alert(title, errorText(err));
  const run = (call: Promise<unknown>, failTitle: string) => void call.then(refresh, failed(failTitle));

  const load = (key: SshManagedKey, loaded: boolean, passphrase?: string) =>
    fullVaultApi.setSshKeyLoaded(key.name, loaded, passphrase).then(refresh, (err: unknown) => {
      if (err instanceof ApiError && err.code === "ssh_key_passphrase_required" && process.env.EXPO_OS === "android") return setAsking(key);
      if (err instanceof ApiError && err.code === "ssh_key_passphrase_required" && process.env.EXPO_OS === "ios") {
        Alert.prompt(t("sshKeys.passphraseTitle", { name: key.name }), undefined, [
          { text: t("common:actions.cancel"), style: "cancel" },
          { text: t("sshKeys.load"), onPress: (value?: string) => value && void load(key, true, value) },
        ], "secure-text");
        return;
      }
      failed(t("sshKeys.changeFailed"))(err);
    });

  const menu = (k: SshManagedKey): MenuItem[] => {
    const items: MenuItem[] = [];
    const open = () => router.push({ pathname: "/vault/ssh-key-edit", params: { name: k.name } });
    if (k.publicKey) items.push({ label: t("sshKeys.copyPublicShort"), icon: "copy", onPress: () => void copy(k) });
    items.push({ label: t("common:actions.edit"), icon: "pencil", onPress: open });
    if (k.publicKey) items.push({ label: t("sshEdit.addToServer"), icon: "server", onPress: open });
    if (agentOn && k.enabled && k.hasPrivate) {
      items.push(k.inAgent ? { label: t("sshKeys.unload"), icon: "minus", onPress: () => void load(k, false) } : { label: t("sshKeys.load"), icon: "plus", onPress: () => void load(k, true) });
    }
    if (k.looseMode) items.push({ label: t("sshKeys.fixPermissions"), icon: "lock", onPress: () => run(fullVaultApi.updateSshKey(k.name, { fixPermissions: true }), t("sshKeys.changeFailed")) });
    items.push(
      k.enabled
        ? { label: t("sshKeys.park"), icon: "archive", onPress: () => run(fullVaultApi.updateSshKey(k.name, { enabled: false }), t("sshKeys.changeFailed")) }
        : { label: t("sshKeys.restore"), icon: "unarchive", onPress: () => run(fullVaultApi.updateSshKey(k.name, { enabled: true }), t("sshKeys.changeFailed")) },
    );
    items.push({
      label: t("common:actions.delete"),
      icon: "trash",
      destructive: true,
      onPress: () =>
        confirmDelete(t("sshKeys.deleteTitle", { name: k.name }), t("sshKeys.deleteBody"), t("common:actions.delete"), t("common:actions.cancel"), () =>
          run(fullVaultApi.deleteSshKey(k.name), t("sshKeys.deleteFailed")),
        ),
    });
    return items;
  };

  return (
    <>
      <TextPrompt
        open={!!asking}
        title={t("sshKeys.passphraseTitle", { name: asking?.name ?? "" })}
        label={t("sshKeys.load")}
        secure
        onSubmit={(value) => {
          setAsking(null);
          if (asking && value) void load(asking, true, value);
        }}
        onClose={() => setAsking(null)}
      />
      {fullAccess ? (
        <HeaderActions
          actions={[{ icon: "plus", label: t("sshKeys.newKey"), onPress: () => router.push("/vault/ssh-key-new") }]}
          menu={[{ icon: "doc", title: t("sshImport.title"), onPress: () => router.push("/vault/ssh-key-import") }]}
        />
      ) : null}
      <ReadonlyList<SshManagedKey>
        title={t("sshKeys.title")}
        query={overview}
        items={shown}
        keyOf={(k) => k.name}
        extraData={[fullAccess, agentOn]}
        search={(keys?.length ?? 0) > SEARCH_ABOVE ? { placeholder: t("sshKeys.search"), value: search, onChange: setSearch } : undefined}
        icon="sshKey"
        emptyTitle={t("sshKeys.emptyTitle")}
        failedTitle={t("sshKeys.loadFailed")}
        offTitle={t("sshKeys.off")}
        header={
          overview.data ? (
            <Row style={{ gap: space.sm }}>
              <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: agentOn ? c.success : c.textFaint }} />
              <T variant="footnote" muted>
                {agentOn ? t("sshKeys.agentLoaded", { count: overview.data.agent.loaded }) : t("sshKeys.agentOff")}
              </T>
            </Row>
          ) : undefined
        }
        renderRow={(k) => (
          <ListRow
            icon="sshKey"
            title={k.name}
            lines={[[k.algorithm === "unknown" ? null : k.algorithm.toUpperCase(), k.bits ? t("sshKeys.bits", { bits: k.bits }) : null, k.comment || null].filter(Boolean).join(" · "), k.fingerprint]}
            badges={
              !k.hasPrivate || k.format === "putty" ? (
                <>
                  {k.hasPrivate ? null : <Badge label={t("sshKeys.publicOnly")} dot={false} />}
                  {k.format === "putty" ? <Badge label="PuTTY" dot={false} /> : null}
                </>
              ) : null
            }
            trailing={
              <>
                {!k.enabled ? <Badge label={t("sshKeys.parked")} dot={false} /> : k.inAgent ? <Badge label={t("sshKeys.loaded")} tone="success" dot={false} /> : null}
                {fullAccess ? (
                  <RowMenu label={t("sshKeys.actionsFor", { name: k.name })} items={menu(k)} />
                ) : k.publicKey ? (
                  <Pressable accessibilityRole="button" accessibilityLabel={t("sshKeys.copyPublic", { name: k.name })} hitSlop={10} onPress={() => void copy(k)}>
                    <Icon name="copy" size={17} color={c.textMuted} />
                  </Pressable>
                ) : null}
              </>
            }
          />
        )}
      />
    </>
  );
}
