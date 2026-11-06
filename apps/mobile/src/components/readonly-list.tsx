import { FlashList } from "@shopify/flash-list";
import { Stack } from "expo-router";
import { memo, type ReactElement, type ReactNode } from "react";
import { Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Icon, type IconName } from "./icon";
import { EmptyState, ErrorState, Hairline, Row, SkeletonRows, T, tap } from "./ui";
import { errorText } from "@/lib/api";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { isOutdated } from "@/lib/vault";
import { radius, space, useColors } from "@/lib/theme";

/**
 * A list the phone only reads (logins, keys, servers, plugins…): pull to refresh, an optional search, and the states
 * in between — loading, an older Godmode on the computer, an error, nothing found, nothing yet.
 */
export function ReadonlyList<T>({
  title,
  query,
  items,
  keyOf,
  renderRow,
  search,
  icon,
  emptyTitle,
  emptyBody,
  failedTitle,
  header,
  inset = 64,
  extraData,
  inline,
}: {
  title: string;
  /** A small title (a folder, a detail), not Settings' large one. */
  inline?: boolean;
  query: { isLoading: boolean; isError: boolean; error: unknown; refetch: () => Promise<unknown> };
  items: T[];
  keyOf: (item: T) => string;
  renderRow: (item: T) => ReactElement;
  search?: { placeholder: string; value: string; onChange: (next: string) => void };
  icon: IconName;
  emptyTitle: string;
  emptyBody?: string;
  failedTitle: string;
  header?: ReactNode;
  inset?: number;
  extraData?: unknown;
}) {
  const { t } = useTranslation("vault");
  const pull = usePullRefresh(query.refetch);
  const searching = !!search?.value.trim();
  return (
    <>
      <Stack.Title>{title}</Stack.Title>
      {inline ? <Stack.Screen options={{ headerLargeTitleEnabled: false }} /> : null}
      {search ? (
        <Stack.SearchBar placeholder={search.placeholder} hideWhenScrolling onChangeText={(e) => search.onChange(e.nativeEvent.text)} onCancelButtonPress={() => search.onChange("")} />
      ) : null}
      <FlashList
        data={query.isLoading ? [] : items}
        keyExtractor={keyOf}
        extraData={extraData}
        renderItem={({ item, index }) => (
          <>
            {index > 0 && <Hairline inset={inset} />}
            {renderRow(item)}
          </>
        )}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        // Lists re-sort and filter as they load and search: keep the top, not the rows that were on screen.
        maintainVisibleContentPosition={{ disabled: true }}
        contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: 80 }}
        refreshControl={<RefreshControl {...pull} />}
        ListHeaderComponent={header ? <View style={{ paddingHorizontal: space.sm, paddingTop: space.sm, paddingBottom: space.md }}>{header}</View> : null}
        ListEmptyComponent={
          query.isLoading ? (
            <View style={{ paddingTop: space.md }}>
              <SkeletonRows count={6} avatar={36} />
            </View>
          ) : isOutdated(query.error) ? (
            <EmptyState icon={icon} title={t("list.outdatedTitle")} body={t("list.outdatedBody")} />
          ) : query.isError ? (
            <ErrorState title={failedTitle} error={errorText(query.error)} onRetry={() => void query.refetch()} />
          ) : searching ? (
            <EmptyState icon="search" title={t("list.noMatch", { query: search!.value.trim() })} />
          ) : (
            <EmptyState icon={icon} title={emptyTitle} body={emptyBody} />
          )
        }
      />
    </>
  );
}

/** One read-only row: a tile, a title with what matters below it, and a badge or value at the end. */
export const ListRow = memo(function ListRow({
  icon,
  tint,
  lead,
  title,
  lines = [],
  trailing,
  onPress,
  accessibilityLabel,
  grouped,
}: {
  icon?: IconName;
  tint?: string;
  lead?: ReactNode;
  title: string;
  lines?: (string | null | undefined | false)[];
  trailing?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  /** Inside a Group card: its rows' insets, no corners of its own. */
  grouped?: boolean;
}) {
  const c = useColors();
  const rowStyle = grouped ? [styles.row, styles.grouped] : styles.row;
  const shown = lines.filter((l): l is string => !!l);
  const body = (
    <>
      {lead ?? (
        <View style={[styles.tile, { backgroundColor: c.sunken }]}>
          <Icon name={icon ?? "doc"} size={17} color={tint ?? c.text} />
        </View>
      )}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T variant="callout" numberOfLines={1} style={{ fontWeight: "500" }}>
          {title}
        </T>
        {shown.map((line, i) => (
          <T key={i} variant="footnote" muted numberOfLines={1}>
            {line}
          </T>
        ))}
      </View>
      {trailing ? <Row style={{ gap: space.sm, flexShrink: 0 }}>{trailing}</Row> : null}
      {onPress ? <Icon name="chevron" size={12} color={c.textFaint} weight="semibold" /> : null}
    </>
  );
  if (!onPress) {
    return (
      <View style={rowStyle}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [rowStyle, pressed && { backgroundColor: c.sunken }]}
    >
      {body}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
  grouped: {
    paddingHorizontal: space.lg,
    borderRadius: 0,
  },
  tile: {
    width: 36,
    height: 36,
    borderRadius: 11,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
});
