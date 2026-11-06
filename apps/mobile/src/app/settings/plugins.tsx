import { useMutation } from "@tanstack/react-query";
import { Alert, Switch } from "react-native";
import { useTranslation } from "react-i18next";
import type { Mod } from "@godmode/shared";
import { ListRow, ReadonlyList } from "@/components/readonly-list";
import { Badge, T, tap } from "@/components/ui";
import { errorText } from "@/lib/api";
import { ik, integrationsApi, usePlugins } from "@/lib/integrations";
import { queryClient } from "@/lib/query";
import { useSettings } from "@/lib/setup";
import { useColors } from "@/lib/theme";

/** Plugins and whether they run. One that runs can be switched off here; switching one on runs code and stays on the computer. */
export default function Plugins() {
  const { t } = useTranslation("integrations");
  const c = useColors();
  const list = usePlugins();
  const settings = useSettings();
  const off = settings.data?.plugins.enabled === false;
  const switchOff = useMutation({
    mutationFn: (mod: Mod) => integrationsApi.switchOff(mod.id),
    onMutate: (mod) => queryClient.setQueryData<Mod[]>(ik.plugins, (all) => all?.map((m) => (m.id === mod.id ? { ...m, enabled: false } : m))),
    onError: (err) => Alert.alert(t("plugins.switchFailed"), errorText(err)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ik.plugins }),
  });

  return (
    <ReadonlyList<Mod>
      title={t("plugins.title")}
      query={list}
      items={list.data ?? []}
      keyOf={(m) => m.id}
      icon="puzzle"
      emptyTitle={t("plugins.emptyTitle")}
      emptyBody={t("plugins.emptyBody")}
      failedTitle={t("plugins.loadFailed")}
      header={
        off ? (
          <T variant="footnote" muted>
            {t("plugins.allOff")}
          </T>
        ) : null
      }
      renderRow={(m) => (
        <ListRow
          icon="puzzle"
          tint={m.enabled ? c.brandStrong : undefined}
          title={m.title || m.name}
          lines={[m.description, m.source ? [m.source.repo, m.source.version].filter(Boolean).join(" · ") : null]}
          trailing={
            m.enabled ? (
              <Switch
                accessibilityLabel={t("plugins.switchOff", { name: m.title || m.name })}
                value
                onValueChange={(next) => {
                  if (next) return;
                  tap();
                  switchOff.mutate(m);
                }}
                trackColor={{ true: c.brand, false: c.sunken }}
              />
            ) : (
              <Badge label={m.needsReview ? t("plugins.draft") : t("off")} tone={m.needsReview ? "warning" : "neutral"} />
            )
          }
        />
      )}
    />
  );
}
