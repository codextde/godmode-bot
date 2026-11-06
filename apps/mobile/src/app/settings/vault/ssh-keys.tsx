import * as Clipboard from "expo-clipboard";
import { Alert, Pressable } from "react-native";
import { useTranslation } from "react-i18next";
import type { SshManagedKey } from "@godmode/shared";
import { Icon } from "@/components/icon";
import { ListRow, ReadonlyList } from "@/components/readonly-list";
import { Badge, tap } from "@/components/ui";
import { useSshKeys } from "@/lib/vault";
import { useColors } from "@/lib/theme";

/** Keys in ~/.ssh of the computer: name, type and fingerprint; the public half can be copied. Private keys stay there. */
export default function SshKeys() {
  const { t } = useTranslation("vault");
  const c = useColors();
  const overview = useSshKeys();
  const copy = async (key: SshManagedKey) => {
    if (!key.publicKey) return;
    tap();
    await Clipboard.setStringAsync(key.publicKey);
    Alert.alert(t("sshKeys.copied"), key.name);
  };

  return (
    <ReadonlyList<SshManagedKey>
      title={t("sshKeys.title")}
      query={overview}
      items={overview.data?.keys ?? []}
      keyOf={(k) => k.name}
      icon="sshKey"
      emptyTitle={t("sshKeys.emptyTitle")}
      failedTitle={t("sshKeys.loadFailed")}
      renderRow={(k) => (
        <ListRow
          icon="sshKey"
          title={k.name}
          lines={[[k.algorithm === "unknown" ? null : k.algorithm.toUpperCase(), k.bits ? t("sshKeys.bits", { bits: k.bits }) : null, k.comment || null].filter(Boolean).join(" · "), k.fingerprint]}
          trailing={
            <>
              {!k.enabled ? <Badge label={t("sshKeys.parked")} dot={false} /> : k.inAgent ? <Badge label={t("sshKeys.loaded")} tone="success" dot={false} /> : null}
              {k.publicKey ? (
                <Pressable accessibilityRole="button" accessibilityLabel={t("sshKeys.copyPublic", { name: k.name })} hitSlop={10} onPress={() => void copy(k)}>
                  <Icon name="copy" size={17} color={c.textMuted} />
                </Pressable>
              ) : null}
            </>
          }
        />
      )}
    />
  );
}
