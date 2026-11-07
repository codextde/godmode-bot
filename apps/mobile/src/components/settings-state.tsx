import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Group } from "./form";
import type { IconName } from "./icon";
import { EmptyState, ErrorState, Skeleton } from "./ui";
import { ApiError, errorText } from "@/lib/api";
import { space } from "@/lib/theme";

/** An older Godmode on the computer refuses what the phone asked for. */
export const isOutdated = (err: unknown) => err instanceof ApiError && err.code === "device_forbidden";

/** Grouped rows while a settings screen loads: the shape of what comes. */
export function FormSkeleton({ groups = 2, rows = 3 }: { groups?: number; rows?: number }) {
  const { t } = useTranslation("components");
  return (
    <View style={styles.skeleton} accessibilityRole="progressbar" accessibilityLabel={t("ui.loading")}>
      {Array.from({ length: groups }, (_, g) => (
        <Group key={g}>
          {Array.from({ length: rows }, (_, i) => (
            <View key={i} style={styles.row}>
              <Skeleton width={30} height={30} radius={9} />
              <View style={{ flex: 1, gap: 6 }}>
                <Skeleton width={`${58 - ((i * 13 + g * 7) % 24)}%`} height={13} />
                <Skeleton width={`${34 - ((i * 11) % 14)}%`} height={10} />
              </View>
            </View>
          ))}
        </Group>
      ))}
    </View>
  );
}

/** The screen's data, or what stands in its way: loading, an older Godmode on the computer, or an error to retry. */
export function QueryState<T>({
  query,
  icon,
  errorTitle,
  skeleton,
  children,
}: {
  query: UseQueryResult<T>;
  icon: IconName;
  errorTitle: string;
  skeleton?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  const { t } = useTranslation("settings");
  if (query.data !== undefined) return <>{children(query.data)}</>;
  if (query.isLoading || query.isPending) return <>{skeleton ?? <FormSkeleton />}</>;
  if (isOutdated(query.error)) return <EmptyState icon={icon} title={t("phone.outdatedTitle")} />;
  return <ErrorState title={errorTitle} error={errorText(query.error)} onRetry={() => void query.refetch()} />;
}

const styles = StyleSheet.create({
  skeleton: {
    gap: space.xl,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 12,
  },
});
