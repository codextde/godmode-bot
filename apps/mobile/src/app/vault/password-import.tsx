import { FlashList } from "@shopify/flash-list";
import { useMutation, useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { Alert, Pressable, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { PasswordImportPreview, PasswordImportResult, PasswordImportRow, PasswordImportSource } from "@godmode/shared";
import { FilterChips } from "@/components/filter-chips";
import { Group, PickerRow } from "@/components/form";
import { NeedsFullAccess, useFullAccess } from "@/components/full-access";
import { Icon } from "@/components/icon";
import { SheetHeader } from "@/components/secret-parts";
import { Badge, Button, EmptyState, Hairline, Row, T, tap, type Tone } from "@/components/ui";
import { api, ApiError, errorText } from "@/lib/api";
import { clearPickerLeftovers, FileTooBig, pickSecretFile } from "@/lib/picked-file";
import { qk } from "@/lib/query";
import { isCancelled, withGrant } from "@/lib/secrets";
import { fullVaultApi, isVaultLocked, refreshVault, type PickedFile } from "@/lib/vault";
import { radius, space, useColors } from "@/lib/theme";

type Filter = "all" | "new" | "update" | "unchanged" | "conflict";
type Stage =
  | { kind: "pick" }
  | { kind: "review"; file: PickedFile; preview: PasswordImportPreview; scope: string }
  | { kind: "done"; fileName: string; result: PasswordImportResult };

const SOURCE_NAMES: Record<PasswordImportSource, string> = {
  chrome: "Chrome",
  "1password": "1Password",
  bitwarden: "Bitwarden",
  apple: "Apple Passwords",
  firefox: "Firefox",
  lastpass: "LastPass",
  dashlane: "Dashlane",
  protonpass: "Proton Pass",
  keepass: "KeePass",
  csv: "CSV",
};

const EXPORT_FILE = /\.(csv|1pux|txt|zip|json)$/i;
/** The computer's limit for an export. */
const MAX_EXPORT_BYTES = 512 * 1024 * 1024;
/** An export can be older than the vault, so replacing a saved password is always picked by hand. */
const preselected = (r: PasswordImportRow) => r.action !== "unchanged" && !r.conflictKey && !r.replacesPassword;
const needsChoice = (r: PasswordImportRow) => !!r.conflictKey && r.action !== "unchanged";

/** The computer wants the vault password before it compares an export: asked first, so a big file is sent once. */
const grantFirst = <T,>(call: (grant: string) => Promise<T>) =>
  withGrant((grant) => (grant ? call(grant) : Promise.reject(new ApiError(403, "", "grant_required"))));

/** Logins from another password manager's export, like the desktop's import: pick the file, review, import. */
export default function PasswordImport() {
  const c = useColors();
  const { fullAccess } = useFullAccess();
  if (fullAccess === false) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        <NeedsFullAccess />
      </View>
    );
  }
  return <ImportFlow />;
}

function ImportFlow() {
  const c = useColors();
  const { t } = useTranslation(["vault", "common"]);
  const workspaces = useQuery({ queryKey: qk.workspaces, queryFn: api.workspaces });
  const [stage, setStage] = useState<Stage>({ kind: "pick" });
  const [workspaceId, setWorkspaceId] = useState("");
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [error, setError] = useState<string | null>(null);

  // The export holds every password in plain text: it lives in memory only, and copies an interrupted pick left go.
  useEffect(clearPickerLeftovers, []);

  const workspaceOptions = useMemo(
    () => [{ value: "", label: t("loginEdit.allWorkspaces") }, ...(workspaces.data ?? []).map((w) => ({ value: w.id, label: w.name }))],
    [workspaces.data, t],
  );

  const failed = (err: unknown, title: string) => {
    if (isCancelled(err)) return;
    if (isVaultLocked(err)) Alert.alert(t("passwordImport.vaultLocked"));
    else Alert.alert(title, errorText(err));
  };

  const preview = useMutation({
    mutationFn: async ({ file, scope }: { file: PickedFile; scope: string }) => ({
      file,
      scope,
      preview: await grantFirst((grant) => fullVaultApi.previewPasswordImport(file, scope || null, grant)),
    }),
    onMutate: () => setError(null),
    onSuccess: ({ file, scope, preview: p }) => {
      if (!p.rows.length) {
        setError(p.total === 0 ? t("passwordImport.noEntries", { file: file.name }) : t("passwordImport.noLogins", { file: file.name }));
        setStage({ kind: "pick" });
        return;
      }
      setSelected(new Set(p.rows.filter(preselected).map((r) => r.id)));
      setStage({ kind: "review", file, preview: p, scope });
    },
    onError: (err) => {
      if (stage.kind === "review") setWorkspaceId(stage.scope);
      failed(err, t("passwordImport.readFailed"));
    },
  });

  const run = useMutation({
    mutationFn: ({ file, scope, ids }: { file: PickedFile; scope: string; ids: number[] }) =>
      grantFirst((grant) => fullVaultApi.importPasswords(file, scope || null, ids, grant)).then((result) => ({ file, result })),
    onSuccess: ({ file, result }) => {
      refreshVault();
      setStage({ kind: "done", fileName: file.name, result });
    },
    onError: (err) => failed(err, t("passwordImport.failed")),
  });

  const choose = async () => {
    try {
      const picked = await pickSecretFile(MAX_EXPORT_BYTES, (f) => f.bytes());
      if (!picked) return;
      if (/\.dash$/i.test(picked.name)) return setError(t("passwordImport.dashBackup"));
      if (!EXPORT_FILE.test(picked.name) && picked.mime !== "text/csv") return setError(t("passwordImport.wrongFile"));
      preview.mutate({ file: { name: picked.name, mime: picked.mime, bytes: picked.data }, scope: workspaceId });
    } catch (err) {
      setError(err instanceof FileTooBig ? t("passwordImport.tooBig") : errorText(err));
    }
  };

  const changeScope = (next: string) => {
    setWorkspaceId(next);
    if (stage.kind === "review") preview.mutate({ file: stage.file, scope: next });
  };

  const ids = stage.kind === "review" ? stage.preview.rows.filter((r) => r.action !== "unchanged" && selected.has(r.id)).map((r) => r.id) : [];
  const busy = preview.isPending || run.isPending;

  const header =
    stage.kind === "review" ? (
      <SheetHeader
        title={t("passwordImport.title")}
        action={ids.length ? t("passwordImport.importCount", { count: ids.length }) : t("passwordImport.nothingSelected")}
        ready={ids.length > 0 && !preview.isPending}
        busy={run.isPending}
        onAction={() => run.mutate({ file: stage.file, scope: stage.scope, ids })}
      />
    ) : stage.kind === "done" ? (
      <SheetHeader title={t("passwordImport.title")} action={t("common:actions.done")} onAction={() => router.back()} />
    ) : (
      <SheetHeader title={t("passwordImport.title")} busy={preview.isPending} />
    );

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <View style={styles.head}>{header}</View>
      {stage.kind === "done" ? (
        <Done result={stage.result} fileName={stage.fileName} />
      ) : stage.kind === "review" ? (
        <Review
          file={stage.file}
          preview={stage.preview}
          selected={selected}
          onSelected={setSelected}
          refreshing={preview.isPending}
          scope={
            <Locked locked={busy}>
              <Group>
                <PickerRow icon="layers" title={t("passwordImport.saveTo")} value={workspaceId} options={workspaceOptions} onChange={changeScope} />
              </Group>
            </Locked>
          }
          onChangeFile={() => !busy && setStage({ kind: "pick" })}
        />
      ) : (
        <View style={styles.pick}>
          <Locked locked={busy}>
            <Group>
              <PickerRow icon="layers" title={t("passwordImport.saveTo")} value={workspaceId} options={workspaceOptions} onChange={setWorkspaceId} />
            </Group>
          </Locked>
          <View style={styles.center}>
            <EmptyState
              icon="doc"
              title={t("passwordImport.chooseTitle")}
              action={<Button title={preview.isPending ? t("passwordImport.reading") : t("passwordImport.choose")} icon="doc" loading={preview.isPending} onPress={() => void choose()} />}
            />
            {error ? (
              <Row style={styles.error}>
                <Icon name="warning" size={14} color={c.danger} />
                <T variant="footnote" color={c.danger} style={{ flexShrink: 1 }}>
                  {error}
                </T>
              </Row>
            ) : null}
          </View>
        </View>
      )}
    </View>
  );
}

function Review({
  file,
  preview,
  selected,
  onSelected,
  refreshing,
  scope,
  onChangeFile,
}: {
  file: PickedFile;
  preview: PasswordImportPreview;
  selected: Set<number>;
  onSelected: (next: Set<number>) => void;
  refreshing: boolean;
  scope: ReactNode;
  onChangeFile: () => void;
}) {
  const c = useColors();
  const { t } = useTranslation("vault");
  const [chosen, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [showSkipped, setShowSkipped] = useState(false);

  const counts = useMemo(() => {
    const n: Record<Filter, number> = { all: 0, new: 0, update: 0, unchanged: 0, conflict: 0 };
    for (const r of preview.rows) {
      n.all++;
      n[r.action]++;
      if (needsChoice(r)) n.conflict++;
    }
    return n;
  }, [preview.rows]);
  const filter = chosen === "conflict" && counts.conflict === 0 ? "all" : chosen;
  const heldBack = preview.rows.filter((r) => r.replacesPassword && !r.conflictKey && !selected.has(r.id)).length;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return preview.rows.filter(
      (r) =>
        (filter === "all" || (filter === "conflict" ? needsChoice(r) : r.action === filter)) &&
        (!q || [r.name, r.username, r.existingName ?? "", ...r.domains].join(" ").toLowerCase().includes(q)),
    );
  }, [preview.rows, filter, query]);
  const bulk = visible.filter((r) => r.action !== "unchanged" && !r.conflictKey);
  const allOn = bulk.length > 0 && bulk.every((r) => selected.has(r.id));

  const toggle = (row: PasswordImportRow) => {
    const next = new Set(selected);
    if (next.has(row.id)) next.delete(row.id);
    else {
      if (row.conflictKey) for (const r of preview.rows) if (r.conflictKey === row.conflictKey) next.delete(r.id);
      next.add(row.id);
    }
    onSelected(next);
  };
  const toggleAll = () => {
    const next = new Set(selected);
    for (const r of bulk) if (allOn) next.delete(r.id);
    else next.add(r.id);
    onSelected(next);
  };

  const filters = (["all", "new", "update", "unchanged", "conflict"] as const)
    .filter((f) => f !== "conflict" || counts.conflict > 0)
    .map((f) => ({ id: f, label: t(`passwordImport.filters.${f}`), count: counts[f] }));

  const listHeader = (
    <View style={styles.listHead}>
      <Group>
        <Row style={styles.fileRow}>
          <View style={[styles.fileTile, { backgroundColor: c.sunken }]}>
            <Icon name="table" size={17} color={c.text} />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <T variant="callout" numberOfLines={1} style={{ fontWeight: "500" }}>
              {file.name}
            </T>
            <T variant="footnote" muted numberOfLines={1}>
              {t("passwordImport.summary", {
                source: SOURCE_NAMES[preview.source],
                entries: t("passwordImport.entries", { count: preview.total }),
                logins: t("passwordImport.logins", { count: preview.rows.length }),
              })}
            </T>
          </View>
          <Pressable accessibilityRole="button" hitSlop={8} disabled={refreshing} onPress={onChangeFile}>
            <T variant="subhead" color={c.brandStrong} style={{ fontWeight: "600" }}>
              {t("passwordImport.changeFile")}
            </T>
          </Pressable>
        </Row>
      </Group>
      {scope}
      {counts.conflict > 0 && filter !== "conflict" ? <Callout text={t("passwordImport.conflictCallout")} onPress={() => setFilter("conflict")} /> : null}
      {heldBack > 0 && filter !== "update" ? <Callout text={t("passwordImport.heldBack", { count: heldBack })} onPress={() => setFilter("update")} /> : null}
      <FilterChips filters={filters} value={filter} onChange={setFilter} />
      <Row style={{ gap: space.md }}>
        <View style={[styles.search, { backgroundColor: c.sunken }]}>
          <Icon name="search" size={14} color={c.textMuted} />
          <TextInput
            accessibilityLabel={t("passwordImport.searchPlaceholder")}
            value={query}
            onChangeText={setQuery}
            placeholder={t("passwordImport.searchPlaceholder")}
            placeholderTextColor={c.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            style={[styles.searchInput, { color: c.text }]}
          />
        </View>
        {bulk.length ? (
          <Pressable accessibilityRole="button" hitSlop={8} onPress={toggleAll}>
            <T variant="subhead" color={c.brandStrong} style={{ fontWeight: "600" }}>
              {allOn ? t("passwordImport.selectNone") : t("passwordImport.selectAll")}
            </T>
          </Pressable>
        ) : null}
      </Row>
    </View>
  );

  return (
    <View style={{ flex: 1, opacity: refreshing ? 0.5 : 1 }}>
      <FlashList
        data={visible}
        keyExtractor={(r) => String(r.id)}
        extraData={selected}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: 40 }}
        ListHeaderComponent={listHeader}
        renderItem={({ item, index }) => (
          <>
            {index > 0 && <Hairline inset={44} />}
            <ImportRow row={item} checked={selected.has(item.id)} onToggle={toggle} />
          </>
        )}
        ListEmptyComponent={<EmptyState icon="search" title={t("passwordImport.nothingMatches")} />}
        ListFooterComponent={
          preview.skipped.length ? (
            <View style={{ paddingTop: space.lg }}>
              <Pressable accessibilityRole="button" accessibilityState={{ expanded: showSkipped }} onPress={() => setShowSkipped((v) => !v)} style={styles.skippedHead}>
                <T variant="footnote" muted style={{ flex: 1 }}>
                  {t("passwordImport.leftOut", { count: preview.skipped.length })}
                </T>
                <Icon name={showSkipped ? "up" : "down"} size={12} color={c.textFaint} />
              </Pressable>
              {showSkipped
                ? preview.skipped.slice(0, 300).map((s, i) => (
                    <Row key={i} style={styles.skippedRow}>
                      <T variant="footnote" numberOfLines={1} style={{ flex: 1 }}>
                        {s.name || s.url || t("passwordImport.untitled")}
                      </T>
                      <T variant="footnote" muted numberOfLines={1} style={{ maxWidth: "50%" }}>
                        {s.reason}
                      </T>
                    </Row>
                  ))
                : null}
            </View>
          ) : null
        }
      />
    </View>
  );
}

const ImportRow = memo(function ImportRow({ row: r, checked, onToggle }: { row: PasswordImportRow; checked: boolean; onToggle: (row: PasswordImportRow) => void }) {
  const c = useColors();
  const { t } = useTranslation("vault");
  const inVault = r.action === "unchanged";
  const [label, tone]: [string, Tone] = inVault
    ? [t("passwordImport.filters.unchanged"), "neutral"]
    : r.conflictKey
      ? [t("passwordImport.filters.conflict"), "warning"]
      : r.action === "new"
        ? [t("passwordImport.filters.new"), "brand"]
        : [t("passwordImport.pillUpdate"), "sky"];
  const line = [r.passwordHint, r.username, r.domains.join(", "), r.rows > 1 ? t("passwordImport.merged", { n: r.rows }) : null, r.action === "update" ? r.changes.join(", ") : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: !inVault && checked, disabled: inVault }}
      accessibilityLabel={t("passwordImport.importRow", { name: r.name })}
      disabled={inVault}
      onPress={() => {
        tap();
        onToggle(r);
      }}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
    >
      <Icon name={!inVault && checked ? "checkFill" : "circle"} size={22} color={!inVault && checked ? c.brand : c.textFaint} style={{ opacity: inVault ? 0.4 : 1 }} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Row style={{ gap: 6 }}>
          <T variant="callout" numberOfLines={1} color={inVault ? c.textMuted : c.text} style={{ fontWeight: "500", flexShrink: 1 }}>
            {r.name}
          </T>
          {r.hasTotp ? <Icon name="shield" size={13} color={c.brandStrong} /> : null}
          {r.warning ? <Icon name="warning" size={13} color={c.warning} /> : null}
        </Row>
        {line ? (
          <T variant="footnote" muted numberOfLines={1}>
            {line}
          </T>
        ) : null}
      </View>
      <Badge label={label} tone={tone} dot={false} />
    </Pressable>
  );
});

function Callout({ text, onPress }: { text: string; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [styles.callout, { backgroundColor: c.warningSoft, opacity: pressed ? 0.7 : 1 }]}
    >
      <Icon name="warning" size={14} color={c.warning} />
      <T variant="footnote" style={{ flex: 1 }}>
        {text}
      </T>
      <Icon name="chevron" size={11} color={c.warning} weight="semibold" />
    </Pressable>
  );
}

/** Holds still while the export is read or imported: a workspace changed then would not be the one shown. */
function Locked({ locked, children }: { locked: boolean; children: ReactNode }) {
  return (
    <View pointerEvents={locked ? "none" : "auto"} style={{ opacity: locked ? 0.5 : 1 }}>
      {children}
    </View>
  );
}

function Done({ result, fileName }: { result: PasswordImportResult; fileName: string }) {
  const { t } = useTranslation("vault");
  const title = result.created
    ? t("passwordImport.result.imported", { count: result.created })
    : result.updated
      ? t("passwordImport.result.updated", { count: result.updated })
      : t("passwordImport.result.nothing");
  const details = [
    result.created && result.updated ? t("passwordImport.result.updatedDetail", { count: result.updated }) : "",
    result.totp ? t("passwordImport.result.totpLinked", { count: result.totp }) : "",
  ].filter(Boolean);
  return (
    <View style={[styles.pick, styles.center]}>
      <EmptyState icon="checkCircle" title={title} body={[details.join(" · "), t("passwordImport.plaintext", { file: fileName })].filter(Boolean).join("\n\n")} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    justifyContent: "center",
    padding: space.lg,
  },
  head: {
    paddingTop: 20,
    paddingHorizontal: space.xl,
    paddingBottom: space.md,
  },
  pick: {
    flex: 1,
    paddingHorizontal: space.xl,
    gap: space.xl,
  },
  center: {
    flex: 1,
    justifyContent: "center",
    paddingBottom: 120,
  },
  error: {
    gap: space.sm,
    alignItems: "flex-start",
    justifyContent: "center",
    paddingHorizontal: space.lg,
    marginTop: space.lg,
  },
  listHead: {
    gap: space.md,
    paddingBottom: space.md,
  },
  fileRow: {
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  fileTile: {
    width: 36,
    height: 36,
    borderRadius: 11,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
  callout: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
  search: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 8,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
  skippedHead: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: space.sm,
    paddingHorizontal: 4,
  },
  skippedRow: {
    gap: space.md,
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
});
