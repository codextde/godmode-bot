import { router, Stack, useLocalSearchParams, useNavigation } from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";
import { useEffect, useState } from "react";
import { Alert, Linking, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { ApiTool, ApiToolAuth, ApiToolInput, ApiToolTestResult } from "@godmode/shared";
import { AdminQueryState, FullAccessGate } from "@/components/admin";
import { Group, LinkRow, Segmented, SwitchRow } from "@/components/form";
import { HeaderActions } from "@/components/header-actions";
import { InfoRow } from "@/components/status-rows";
import { ActionRow, TestResult, TextRow, useScopeRows, type Scope } from "@/components/tool-form";
import { EmptyState } from "@/components/ui";
import { errorText } from "@/lib/api";
import { API_TOOL_PRESETS, presetById, type ApiToolPreset } from "@/lib/api-tool-presets";
import { t as translate } from "@/lib/i18n";
import { useApiTools } from "@/lib/integrations";
import { isCancelled, withConfirmedGrant } from "@/lib/secrets";
import {
  BEARER,
  ENV_VAR_PATTERN,
  HEADER_KEY_PATTERN,
  hostOf,
  keyModeOf,
  refreshTools,
  SECRET_NAME_PATTERN,
  suggestEnvVar,
  toolsAdmin,
  type KeyMode,
} from "@/lib/tools-admin";
import { space } from "@/lib/theme";

interface Form {
  name: string;
  description: string;
  apiKey: string;
  removeKey: boolean;
  baseUrl: string;
  keyMode: KeyMode;
  headerName: string;
  prefix: string;
  queryName: string;
  docs: string;
  docsUrl: string;
  testPath: string;
  envOn: boolean;
  envVar: string;
  scope: Scope;
}

function fromTool(tool: ApiTool | null, preset?: ApiToolPreset): Form {
  if (!tool && preset) return fromPreset(preset);
  const mode = tool ? keyModeOf(tool.auth) : "bearer";
  return {
    name: tool?.name ?? "",
    description: tool?.description ?? "",
    apiKey: "",
    removeKey: false,
    baseUrl: tool?.baseUrl ?? "",
    keyMode: mode,
    headerName: tool?.auth.in === "header" && mode === "header" ? tool.auth.name : "x-api-key",
    prefix: tool?.auth.in === "header" && mode === "header" ? tool.auth.prefix : "",
    queryName: tool?.auth.in === "query" ? tool.auth.name : "key",
    docs: tool?.docs ?? "",
    docsUrl: tool?.docsUrl ?? "",
    testPath: tool?.testPath ?? "",
    envOn: !!tool?.envVar,
    envVar: tool?.envVar ?? (tool ? suggestEnvVar(tool.name) : ""),
    scope: { workspaceId: tool?.workspaceId ?? null, agentId: tool?.agentId ?? null },
  };
}

function fromPreset(p: ApiToolPreset): Form {
  const mode = keyModeOf(p.auth);
  return {
    name: p.name,
    description: translate(p.description, { ns: "tools" }),
    apiKey: "",
    removeKey: false,
    baseUrl: p.baseUrl,
    keyMode: mode,
    headerName: mode === "header" ? p.auth.name : "x-api-key",
    prefix: mode === "header" ? p.auth.prefix : "",
    queryName: p.auth.in === "query" ? p.auth.name : "key",
    docs: p.docs,
    docsUrl: p.docsUrl,
    testPath: p.testPath,
    envOn: false,
    envVar: p.envVar,
    scope: { workspaceId: null, agentId: null },
  };
}

function authOf(f: Form): ApiToolAuth {
  if (f.keyMode === "bearer") return BEARER;
  if (f.keyMode === "query") return { in: "query", name: f.queryName.trim(), prefix: "" };
  return { in: "header", name: f.headerName.trim(), prefix: f.prefix };
}

/** Settings → Integrations → an API tool: its key (write-only), where it goes and how agents use it (full access only). */
export default function ApiToolScreen() {
  const { t } = useTranslation("tools");
  const { id, preset, agentId, workspaceId } = useLocalSearchParams<{ id?: string; preset?: string; agentId?: string; workspaceId?: string }>();
  const scope = agentId ? { agentId, workspaceId: workspaceId || null } : undefined;
  const tools = useApiTools();
  const current = id ? tools.data?.find((x) => x.id === id) : undefined;
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={styles.content}
    >
      <Stack.Screen options={id ? { title: current?.name ?? "", headerLargeTitleEnabled: false } : { headerLargeTitleEnabled: false }} />
      <FullAccessGate>
        {id ? (
          <AdminQueryState query={tools} errorTitle={t("loadFailed")}>
            {(list) => {
              const tool = list.find((x) => x.id === id);
              return tool ? <ToolForm key={tool.id} tool={tool} /> : <EmptyState icon="link" title={t("api.notFound")} />;
            }}
          </AdminQueryState>
        ) : preset ? (
          <ToolForm key={preset} tool={null} preset={presetById(preset)} scope={scope} />
        ) : (
          <PresetPicker scope={scope} />
        )}
      </FullAccessGate>
    </ScrollView>
  );
}

/** A new tool starts from one of the desktop's presets or from scratch. */
function PresetPicker({ scope }: { scope?: Scope }) {
  const { t } = useTranslation("tools");
  const carried = scope?.agentId ? { agentId: scope.agentId, ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}) } : {};
  return (
    <>
      <Stack.Screen options={{ title: t("api.addTitle") }} />
      <Group>
        {API_TOOL_PRESETS.map((p) => (
          <LinkRow key={p.id} icon={p.icon} title={p.name} detail={t(p.tagline)} onPress={() => router.replace({ pathname: "/settings/api-tool", params: { preset: p.id, ...carried } })} />
        ))}
        <LinkRow icon="wrench" title={t("presets.custom")} onPress={() => router.replace({ pathname: "/settings/api-tool", params: { preset: "custom", ...carried } })} />
      </Group>
    </>
  );
}

function ToolForm({ tool, preset, scope }: { tool: ApiTool | null; preset?: ApiToolPreset; scope?: Scope }) {
  const { t } = useTranslation(["tools", "common"]);
  const navigation = useNavigation();
  const [saved, setSaved] = useState<ApiTool | null>(tool);
  const [base, setBase] = useState(() => ({ ...fromTool(tool, preset), ...(scope ? { scope } : {}) }));
  const [form, setForm] = useState<Form>(base);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [result, setResult] = useState<ApiToolTestResult | null>(null);
  const [leaving, setLeaving] = useState(false);
  const dirty = !leaving && JSON.stringify(form) !== JSON.stringify(base);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const scopeRows = useScopeRows(form.scope, (scope) => set("scope", scope));
  const keySaved = !!saved?.hasKey && !form.removeKey;

  useEffect(() => {
    if (leaving) router.back();
  }, [leaving]);

  usePreventRemove(dirty, ({ data }) => {
    Alert.alert(t("discard.title"), undefined, [
      { text: t("discard.keep"), style: "cancel" },
      { text: t("discard.discard"), style: "destructive", onPress: () => navigation.dispatch(data.action) },
    ]);
  });

  const problem = (): string | null => {
    const key = form.apiKey.trim();
    if (!form.name.trim()) return t("errors.toolName");
    if (key && (key.length < 8 || /\s/.test(key))) return t("errors.apiKey");
    const url = form.baseUrl.trim();
    if (url) {
      try {
        const u = new URL(url);
        if (u.protocol !== "https:" && u.protocol !== "http:") return t("errors.baseUrlProtocol");
        if (u.search || u.hash) return t("errors.baseUrlQuery");
      } catch {
        return t("errors.baseUrlInvalid");
      }
    } else if (!form.envOn) return t("errors.baseUrlMissing");
    if (form.keyMode === "header" && !HEADER_KEY_PATTERN.test(form.headerName.trim())) return t("errors.headerName");
    if (form.keyMode === "query" && !/^[A-Za-z0-9_.~[\]-]+$/.test(form.queryName.trim())) return t("errors.queryName");
    if (form.envOn && (!ENV_VAR_PATTERN.test(form.envVar.trim()) || !SECRET_NAME_PATTERN.test(form.envVar.trim()))) return t("errors.envVar");
    if (form.docsUrl.trim()) {
      try {
        new URL(form.docsUrl.trim());
      } catch {
        return t("errors.docsUrl");
      }
    }
    if (form.testPath.trim() && !url) return t("errors.testPath");
    return null;
  };

  const save = async (): Promise<ApiTool | null> => {
    const wrong = problem();
    if (wrong) {
      Alert.alert(t("errors.title"), wrong);
      return null;
    }
    const key = form.apiKey.trim();
    const input: ApiToolInput = {
      workspaceId: form.scope.workspaceId,
      agentId: form.scope.agentId,
      name: form.name.trim(),
      description: form.description.trim(),
      docs: form.docs.trim(),
      docsUrl: form.docsUrl.trim(),
      baseUrl: form.baseUrl.trim(),
      auth: authOf(form),
      testPath: form.testPath.trim(),
      envVar: form.envOn ? form.envVar.trim() : null,
      ...(key ? { apiKey: key } : form.removeKey ? { apiKey: "" } : {}),
    };
    try {
      // The saved key would go somewhere new (another address, the runs' environment): Face ID and the vault password first.
      const next = saved
        ? await withConfirmedGrant(t("api.grantReason", { name: saved.name }), (grant) => toolsAdmin.apiTools.update(saved.id, input, grant))
        : await toolsAdmin.apiTools.create({ ...input, preset: preset?.id ?? null });
      refreshTools();
      return next;
    } catch (err) {
      if (!isCancelled(err)) Alert.alert(t("api.saveFailed"), errorText(err));
      return null;
    }
  };

  const saveAndClose = async () => {
    if (busy) return;
    setBusy("save");
    const next = await save();
    setBusy(null);
    if (next) setLeaving(true);
  };

  const test = async () => {
    if (busy) return;
    setBusy("test");
    setResult(null);
    let current = saved;
    if (!current || dirty) {
      current = await save();
      if (!current) return setBusy(null);
      const next = fromTool(current);
      setSaved(current);
      setBase(next);
      setForm(next);
    }
    try {
      setResult(await toolsAdmin.apiTools.test(current.id));
    } catch (err) {
      setResult({ ok: false, status: null, ms: 0, message: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (enabled: boolean) => {
    if (!saved) return;
    const before = saved;
    setSaved({ ...saved, enabled });
    try {
      setSaved(await toolsAdmin.apiTools.update(saved.id, { enabled }));
      refreshTools();
    } catch (err) {
      setSaved(before);
      Alert.alert(t("api.saveFailed"), errorText(err));
    }
  };

  const remove = () => {
    if (!saved) return;
    Alert.alert(t("api.deleteTitle", { name: saved.name }), t("api.deleteBody"), [
      { text: t("common:actions.cancel"), style: "cancel" },
      {
        text: t("common:actions.delete"),
        style: "destructive",
        onPress: async () => {
          try {
            await toolsAdmin.apiTools.remove(saved.id);
            refreshTools();
            setLeaving(true);
          } catch (err) {
            Alert.alert(t("api.deleteFailed"), errorText(err));
          }
        },
      },
    ]);
  };

  const host = hostOf(form.baseUrl);
  const auth = authOf(form);
  const from = preset ?? presetById(saved?.preset);
  const preview = auth.in === "query" ? `${host || "api.example.com"}/…?${auth.name || "key"}=••••••••` : `${auth.name || "header"}: ${auth.prefix}••••••••`;
  const canTest = !!form.testPath.trim() && !!form.baseUrl.trim();

  return (
    <>
      {tool ? null : <Stack.Screen options={{ title: saved ? saved.name : (preset?.name ?? t("api.addTitle")) }} />}
      {dirty || !saved ? <HeaderActions actions={[{ icon: "check", label: t("common:actions.save"), prominent: true, onPress: () => void saveAndClose() }]} /> : null}

      <Group title={t("api.whatItIs")}>
        <TextRow
          label={t("fields.name")}
          value={form.name}
          onChange={(v) => set("name", v)}
          onBlur={() => {
            if (!form.envVar.trim() && form.name.trim()) set("envVar", suggestEnvVar(form.name));
          }}
          placeholder={t("api.namePlaceholder")}
        />
        <TextRow label={t("api.useFor")} value={form.description} onChange={(v) => set("description", v)} placeholder={t("api.useForPlaceholder")} multiline maxLength={2000} />
      </Group>

      {saved ? (
        <Group>
          <SwitchRow icon="power" title={t("api.enabled")} value={saved.enabled} onChange={(v) => void toggle(v)} />
        </Group>
      ) : null}

      <Group title={t("api.key")} footer={form.removeKey ? t("api.keyWillBeRemoved") : t("api.encrypted")}>
        <TextRow
          label={t("api.key")}
          value={form.apiKey}
          onChange={(v) => setForm((f) => ({ ...f, apiKey: v, removeKey: false }))}
          placeholder={keySaved ? t("api.keySavedPlaceholder") : (from?.keyPlaceholder ?? t("api.keyPlaceholder"))}
          secure
          stacked
        />
        {from && !keySaved ? (
          <ActionRow icon="external" title={t("presets.getKeyAt", { site: from.keyUrl.label })} onPress={() => void Linking.openURL(from.keyUrl.href).catch(() => undefined)} />
        ) : null}
        {saved?.hasKey && !form.apiKey ? (
          form.removeKey ? (
            <ActionRow icon="reply" title={t("api.keepKey")} onPress={() => set("removeKey", false)} />
          ) : (
            <ActionRow icon="trash" title={t("api.removeKey")} tone="danger" onPress={() => set("removeKey", true)} />
          )
        ) : null}
      </Group>

      <Group title={t("api.whereKeyGoes")} footer={form.baseUrl.trim().startsWith("http://") ? t("api.insecure") : t("api.addressHint")}>
        <TextRow label={t("api.address")} value={form.baseUrl} onChange={(v) => set("baseUrl", v)} placeholder="https://api.example.com" mono stacked keyboardType="url" />
        <View style={styles.segment}>
          <Segmented
            options={[
              { value: "bearer", label: t("api.bearer") },
              { value: "header", label: t("api.header") },
              { value: "query", label: t("api.query") },
            ]}
            value={form.keyMode}
            onChange={(v) => set("keyMode", v)}
          />
        </View>
        {form.keyMode === "header" ? <TextRow label={t("api.headerName")} value={form.headerName} onChange={(v) => set("headerName", v)} mono /> : null}
        {form.keyMode === "header" ? <TextRow label={t("api.prefix")} value={form.prefix} onChange={(v) => set("prefix", v)} placeholder="Token " mono /> : null}
        {form.keyMode === "query" ? <TextRow label={t("api.paramName")} value={form.queryName} onChange={(v) => set("queryName", v)} mono /> : null}
        <InfoRow label={t("api.preview")} value={preview} mono />
      </Group>

      <Group title={t("api.howToUse")}>
        <TextRow label={t("api.docs")} value={form.docs} onChange={(v) => set("docs", v)} placeholder={t("api.docsPlaceholder")} mono multiline minHeight={120} maxLength={100_000} />
        <TextRow label={t("api.docsLink")} value={form.docsUrl} onChange={(v) => set("docsUrl", v)} placeholder="https://docs.example.com/api" mono stacked keyboardType="url" />
      </Group>

      <Group title={t("scope.title")}>
        {scopeRows}
      </Group>

      <Group title={t("api.advanced")} footer={form.envOn ? t("api.envHint") : undefined}>
        <SwitchRow
          icon="terminal"
          title={t("api.envTitle")}
          value={form.envOn}
          onChange={(v) => setForm((f) => ({ ...f, envOn: v, envVar: f.envVar.trim() || suggestEnvVar(f.name) }))}
        />
        {form.envOn ? (
          <TextRow label={t("api.variable")} value={form.envVar} onChange={(v) => set("envVar", v.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))} mono />
        ) : null}
        <TextRow label={t("api.testRequest")} value={form.testPath} onChange={(v) => set("testPath", v)} placeholder="/v1/models" mono />
      </Group>

      {canTest ? (
        <Group>
          <ActionRow icon="bolt" title={busy === "test" ? t("api.testing") : dirty || !saved ? t("mcp.saveAndTest") : t("api.test")} busy={busy === "test"} onPress={() => void test()} />
          {result && busy !== "test" ? (
            <TestResult ok={result.ok} title={result.ok ? t("api.keyWorks") : t("api.testFailed")} body={[result.status ? `HTTP ${result.status}` : null, result.message].filter(Boolean).join(" · ")} />
          ) : null}
        </Group>
      ) : null}

      {saved ? (
        <Group>
          <ActionRow icon="trash" title={t("api.delete")} tone="danger" onPress={remove} />
        </Group>
      ) : null}
    </>
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
});
