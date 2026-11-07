import { useQuery } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { BrowserProfile, ChromeImportResult, LocalChromeProfile } from "@godmode/shared";
import { AdminQueryState, FullAccessGate } from "@/components/admin";
import { CloseButton } from "@/components/close-button";
import { ChoiceRow, Group, PickerRow, Segmented } from "@/components/form";
import { ActionRow, TestResult, TextRow } from "@/components/tool-form";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { intlLocale } from "@/lib/i18n";
import { domainOf, machinesApi, mk } from "@/lib/machines";
import { FileTooBig, pickSecretFile } from "@/lib/picked-file";
import { qk, queryClient } from "@/lib/query";
import { space } from "@/lib/theme";

type Source = "chrome" | "json";
const MAX_FILE = 20 * 1024 * 1024;

/**
 * Sessions into a browser profile, like the desktop's Import sessions card: from a Chrome profile on the computer (all
 * sites or a few), or from a cookie export pasted or picked here (full access).
 */
export default function BrowserImport() {
  const { t } = useTranslation("machines");
  const { id } = useLocalSearchParams<{ id?: string }>();
  const profiles = useQuery({ queryKey: qk.browserProfiles, queryFn: api.browser.profiles });
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={styles.content}
    >
      <Stack.Screen options={{ title: t("import.title"), headerLargeTitleEnabled: false }} />
      <CloseButton />
      <FullAccessGate>
        <AdminQueryState query={profiles} errorTitle={t("browser.loadFailed")}>
          {(list) => (list.length ? <Importer profiles={list} initial={list.find((p) => p.id === id)?.id ?? list.find((p) => p.isDefault)?.id ?? list[0]!.id} /> : <EmptyState style={styles.state} icon="globe" title={t("import.createFirst")} />)}
        </AdminQueryState>
      </FullAccessGate>
    </ScrollView>
  );
}

function Importer({ profiles, initial }: { profiles: BrowserProfile[]; initial: string }) {
  const { t } = useTranslation("machines");
  const [targetId, setTargetId] = useState(initial);
  const [source, setSource] = useState<Source>("chrome");
  const [result, setResult] = useState<{ result: ChromeImportResult; from: string } | null>(null);
  const target = profiles.find((p) => p.id === targetId) ?? profiles[0]!;

  const done = (res: ChromeImportResult, from: string) => {
    setResult({ result: res, from });
    void queryClient.invalidateQueries({ queryKey: qk.browserProfiles });
    void Haptics.notificationAsync(res.imported > 0 ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
  };

  return (
    <>
      <Group>
        <PickerRow
          icon="globe"
          title={t("import.into")}
          value={target.id}
          options={profiles.map((p) => ({ value: p.id, label: p.name, detail: p.isDefault ? t("import.defaultTag") : undefined }))}
          onChange={(next) => {
            setTargetId(next);
            setResult(null);
          }}
        />
      </Group>

      {result ? (
        <Result result={result.result} from={result.from} onAgain={() => setResult(null)} />
      ) : (
        <>
          <View style={styles.segment}>
            <Segmented
              options={[
                { value: "chrome", label: t("import.fromChrome") },
                { value: "json", label: t("import.cookiesJson") },
              ]}
              value={source}
              onChange={setSource}
            />
          </View>
          {source === "chrome" ? <FromChrome target={target} onDone={done} /> : <FromJson target={target} onDone={done} />}
        </>
      )}
    </>
  );
}

function FromChrome({ target, onDone }: { target: BrowserProfile; onDone: (res: ChromeImportResult, from: string) => void }) {
  const { t } = useTranslation("machines");
  const chrome = useQuery({ queryKey: mk.chromeProfiles, queryFn: machinesApi.browser.chromeProfiles, staleTime: 60_000 });
  const [picked, setPicked] = useState<LocalChromeProfile | null>(null);
  const [sites, setSites] = useState("");
  const [busy, setBusy] = useState(false);
  const domains = [...new Set(sites.split(/[\s,]+/).map(domainOf).filter((d) => d.includes(".")))];

  const run = async () => {
    if (!picked || busy) return;
    setBusy(true);
    try {
      onDone(await machinesApi.browser.import(target.id, { sourcePath: picked.path, domains: domains.length ? domains : undefined }), `${picked.browser} · ${picked.name}`);
    } catch (err) {
      Alert.alert(t("import.failed"), errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const list = chrome.data ?? [];
  return (
    <>
      <Group title={t("import.chromeProfile")}>
        {chrome.isLoading ? (
          <SkeletonRows count={2} avatar={30} />
        ) : chrome.isError ? (
          <ErrorState title={t("import.lookFailed")} error={errorText(chrome.error)} onRetry={() => void chrome.refetch()} />
        ) : list.length ? (
          list.map((p) => (
            <ChoiceRow
              key={p.path}
              icon="globe"
              title={p.name}
              detail={[p.email ?? t("import.notSignedIn"), `${p.browser} · ${p.profileDir}`].join("\n")}
              selected={picked?.path === p.path}
              onPress={() => setPicked(p)}
            />
          ))
        ) : (
          <EmptyState icon="globe" title={t("import.noChrome")} body={t("import.noChromeBody")} />
        )}
      </Group>

      {picked ? (
        <Group title={t("import.onlySites")} footer={t("import.keychain", { name: target.name })}>
          <TextRow label={t("import.sites")} value={sites} onChange={setSites} placeholder="github.com, notion.so" keyboardType="url" multiline minHeight={56} />
          <ActionRow
            icon="download"
            title={busy ? t("import.importing") : domains.length ? t("import.importSites", { count: domains.length }) : t("import.importAll")}
            busy={busy}
            onPress={() => void run()}
          />
        </Group>
      ) : null}
    </>
  );
}

/** The JSON as given, or with the curly quotes the iOS keyboard types made straight. */
function validJson(text: string): string | null {
  for (const candidate of [text, text.replace(/[“”„]/g, '"').replace(/[‘’]/g, "'")]) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Not this one.
    }
  }
  return null;
}

function FromJson({ target, onDone }: { target: BrowserProfile; onDone: (res: ChromeImportResult, from: string) => void }) {
  const { t } = useTranslation("machines");
  const [json, setJson] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const trimmed = json.trim();
  const payload = trimmed ? validJson(trimmed) : null;
  const invalid = !!trimmed && !payload;

  const pick = async () => {
    try {
      const file = await pickSecretFile(MAX_FILE, (f) => f.text());
      if (!file) return;
      setJson(file.data);
      setFileName(file.name);
    } catch (err) {
      Alert.alert(t("import.cantRead"), err instanceof FileTooBig ? t("import.tooLarge") : errorText(err));
    }
  };

  const run = async () => {
    if (!payload || busy) return;
    setBusy(true);
    try {
      onDone(await machinesApi.browser.import(target.id, { cookiesJson: payload }), fileName ?? t("import.pastedJson"));
      setJson("");
      setFileName(null);
    } catch (err) {
      Alert.alert(t("import.failed"), errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Group footer={invalid ? t("import.invalidJson") : t("import.jsonHint")}>
      <TextRow
        label={fileName ?? t("import.cookiesJson")}
        value={json}
        onChange={(v) => {
          setJson(v);
          setFileName(null);
        }}
        placeholder='[{ "name": "session", "value": "…", "domain": ".example.com", "path": "/" }]'
        mono
        multiline
        minHeight={120}
      />
      <ActionRow icon="doc" title={t("import.chooseFile")} onPress={() => void pick()} />
      {payload ? <ActionRow icon="download" title={busy ? t("import.importing") : t("import.importInto", { name: target.name })} busy={busy} onPress={() => void run()} /> : null}
    </Group>
  );
}

function Result({ result, from, onAgain }: { result: ChromeImportResult; from: string; onAgain: () => void }) {
  const { t } = useTranslation("machines");
  const n = (v: number) => v.toLocaleString(intlLocale());
  const ok = result.imported > 0;
  return (
    <Group footer={ok ? t("import.signedIn") : undefined}>
      <TestResult
        ok={ok}
        title={ok ? t("import.imported", { count: result.imported, n: n(result.imported) }) : t("import.noneImported")}
        body={[t("import.from", { source: from }), result.skipped > 0 ? t("import.skipped", { n: n(result.skipped) }) : null].filter(Boolean).join(" · ")}
        items={result.domains}
      />
      <ActionRow icon="plus" title={t("import.importMore")} onPress={onAgain} />
    </Group>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
  segment: {
    paddingHorizontal: space.xs,
  },
  state: {
    paddingTop: 60,
  },
});
