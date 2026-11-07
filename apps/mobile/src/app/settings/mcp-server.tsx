import { router, Stack, useLocalSearchParams, useNavigation } from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";
import { useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { McpServer, McpServerInput, McpTransport } from "@godmode/shared";
import { AdminQueryState, FullAccessGate } from "@/components/admin";
import { Group, Segmented, SwitchRow } from "@/components/form";
import { HeaderActions } from "@/components/header-actions";
import { InfoRow } from "@/components/status-rows";
import { ActionRow, SecretRowEditor, TestResult, TextRow, useScopeRows, type Scope } from "@/components/tool-form";
import { EmptyState } from "@/components/ui";
import { errorText } from "@/lib/api";
import { useMcpServers } from "@/lib/integrations";
import {
  ENV_KEY_PATTERN,
  formatArgs,
  HEADER_KEY_PATTERN,
  NAME_PATTERN,
  newRow,
  parseArgs,
  refreshTools,
  rowsFromKeys,
  rowsProblem,
  rowsToRecord,
  toolsAdmin,
  TRANSPORTS,
  type McpTestResult,
  type SecretRow,
} from "@/lib/tools-admin";
import { space } from "@/lib/theme";

interface Form {
  name: string;
  description: string;
  transport: McpTransport;
  command: string;
  args: string;
  url: string;
  env: SecretRow[];
  headers: SecretRow[];
  scope: Scope;
  enabled: boolean;
}

const fromServer = (s: McpServer | null): Form => ({
  name: s?.name ?? "",
  description: s?.description ?? "",
  transport: s?.transport ?? "stdio",
  command: s?.command ?? "",
  args: s ? formatArgs(s.args) : "",
  url: s?.url ?? "",
  env: s ? rowsFromKeys(s.envKeys) : [],
  headers: s ? rowsFromKeys(s.headerKeys) : [],
  scope: { workspaceId: s?.workspaceId ?? null, agentId: s?.agentId ?? null },
  enabled: s?.enabled ?? true,
});

/** Settings → Integrations → an MCP server: added, edited, tested and deleted like on the desktop (full access only). */
export default function McpServerScreen() {
  const { t } = useTranslation("tools");
  const { id } = useLocalSearchParams<{ id?: string }>();
  const servers = useMcpServers();
  const current = id ? servers.data?.find((s) => s.id === id) : undefined;
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={styles.content}
    >
      <Stack.Screen options={{ title: id ? (current?.name ?? "") : t("mcp.addTitle"), headerLargeTitleEnabled: false }} />
      <FullAccessGate>
        {id ? (
          <AdminQueryState query={servers} errorTitle={t("loadFailed")}>
            {(list) => {
              const server = list.find((s) => s.id === id);
              if (!server) return <EmptyState icon="network" title={t("mcp.notFound")} />;
              return server.source === "composio" ? <Managed server={server} /> : <McpForm key={server.id} server={server} />;
            }}
          </AdminQueryState>
        ) : (
          <McpForm server={null} />
        )}
      </FullAccessGate>
    </ScrollView>
  );
}

function McpForm({ server }: { server: McpServer | null }) {
  const { t } = useTranslation(["tools", "common"]);
  const navigation = useNavigation();
  const [start] = useState(() => fromServer(server));
  const [form, setForm] = useState<Form>(start);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<McpTestResult | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [savedId, setSavedId] = useState(server?.id ?? null);
  const [base, setBase] = useState(start);
  const dirty = !leaving && JSON.stringify(form) !== JSON.stringify(base);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const stdio = form.transport === "stdio";
  const scopeRows = useScopeRows(form.scope, (scope) => set("scope", scope));

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
    const name = form.name.trim();
    if (!name) return t("errors.nameMissing");
    if (!NAME_PATTERN.test(name)) return t("errors.nameInvalid");
    if (stdio && !form.command.trim()) return t("errors.commandMissing");
    if (!stdio) {
      try {
        const u = new URL(form.url.trim());
        if (u.protocol !== "http:" && u.protocol !== "https:") return t("errors.urlProtocol");
      } catch {
        return t("errors.urlInvalid");
      }
    }
    const rows = stdio ? rowsProblem(form.env, ENV_KEY_PATTERN) : rowsProblem(form.headers, HEADER_KEY_PATTERN);
    if (!rows) return null;
    if (rows.kind === "needsName") return stdio ? t("errors.envNeedsName") : t("errors.headerNeedsName");
    if (rows.kind === "duplicate") return t("errors.duplicate", { key: rows.key });
    return stdio ? t("errors.envInvalid", { key: rows.key }) : t("errors.headerInvalid", { key: rows.key });
  };

  /** Saves the form; the saved server, or null when it couldn't be. */
  const save = async (): Promise<McpServer | null> => {
    const wrong = problem();
    if (wrong) {
      Alert.alert(t("errors.title"), wrong);
      return null;
    }
    const input: McpServerInput = {
      workspaceId: form.scope.workspaceId,
      agentId: form.scope.agentId,
      name: form.name.trim(),
      description: form.description.trim(),
      transport: form.transport,
      command: stdio ? form.command.trim() : "",
      args: stdio ? parseArgs(form.args) : [],
      url: stdio ? "" : form.url.trim(),
      env: stdio ? rowsToRecord(form.env) : {},
      headers: stdio ? {} : rowsToRecord(form.headers),
      enabled: form.enabled,
    };
    setSaving(true);
    try {
      const saved = savedId ? await toolsAdmin.mcp.update(savedId, input) : await toolsAdmin.mcp.create(input);
      refreshTools();
      return saved;
    } catch (err) {
      Alert.alert(t("mcp.saveFailed"), errorText(err));
      return null;
    } finally {
      setSaving(false);
    }
  };

  const saveAndClose = async () => {
    if (saving) return;
    if (await save()) setLeaving(true);
  };

  const test = async () => {
    if (testing || saving) return;
    setTesting(true);
    setResult(null);
    let id = savedId;
    if (!id || dirty) {
      const saved = await save();
      if (!saved) return setTesting(false);
      id = saved.id;
      const next = fromServer(saved);
      setSavedId(saved.id);
      setBase(next);
      setForm(next);
    }
    try {
      setResult(await toolsAdmin.mcp.test(id));
    } catch (err) {
      setResult({ ok: false, error: errorText(err) });
    } finally {
      setTesting(false);
    }
  };

  const remove = () => {
    if (!savedId) return;
    Alert.alert(t("mcp.deleteTitle", { name: form.name || server?.name }), t("mcp.deleteBody"), [
      { text: t("common:actions.cancel"), style: "cancel" },
      {
        text: t("common:actions.delete"),
        style: "destructive",
        onPress: async () => {
          try {
            await toolsAdmin.mcp.remove(savedId);
            refreshTools();
            setLeaving(true);
          } catch (err) {
            Alert.alert(t("mcp.deleteFailed"), errorText(err));
          }
        },
      },
    ]);
  };

  const argCount = parseArgs(form.args).length;
  const outcome = result;

  return (
    <>
      {server ? null : <Stack.Screen options={{ title: savedId ? base.name : t("mcp.addTitle") }} />}
      {dirty || !savedId ? <HeaderActions actions={[{ icon: "check", label: t("common:actions.save"), prominent: true, onPress: () => void saveAndClose() }]} /> : null}

      <Group>
        <TextRow label={t("fields.name")} value={form.name} onChange={(v) => set("name", v)} placeholder={t("mcp.namePlaceholder")} mono />
        <TextRow label={t("fields.description")} value={form.description} onChange={(v) => set("description", v)} placeholder={t("mcp.descriptionPlaceholder")} />
      </Group>

      <Group title={t("mcp.transport")}>
        <View style={styles.segment}>
          <Segmented options={TRANSPORTS.map((tr) => ({ value: tr, label: t(`transports.${tr}.label`) }))} value={form.transport} onChange={(v) => set("transport", v)} />
        </View>
      </Group>

      {stdio ? (
        <Group footer={`${t("mcp.argumentsHint")}${argCount ? ` ${t("mcp.argumentCount", { count: argCount })}` : ""}`}>
          <TextRow
            label={t("mcp.command")}
            value={form.command}
            onChange={(v) => set("command", v)}
            onBlur={() => {
              // A whole command line pasted into Command splits into the program and its arguments.
              const parts = parseArgs(form.command.trim());
              if (parts.length > 1 && !form.args.trim()) setForm((f) => ({ ...f, command: parts[0]!, args: formatArgs(parts.slice(1)) }));
            }}
            placeholder="npx"
            mono
          />
          <TextRow label={t("mcp.arguments")} value={form.args} onChange={(v) => set("args", v)} placeholder="-y @scope/mcp-server --flag value" mono multiline />
        </Group>
      ) : (
        <Group>
          <TextRow label="URL" value={form.url} onChange={(v) => set("url", v)} placeholder="https://example.com/mcp" mono stacked keyboardType="url" />
        </Group>
      )}

      <SecretGroup
        title={stdio ? t("mcp.envVars") : t("mcp.headers")}
        rows={stdio ? form.env : form.headers}
        onChange={(rows) => set(stdio ? "env" : "headers", rows)}
        keyPlaceholder={stdio ? "API_KEY" : "Authorization"}
        valuePlaceholder={stdio ? undefined : t("mcp.headerValuePlaceholder")}
        addLabel={stdio ? t("mcp.addVariable") : t("mcp.addHeader")}
        upperCase={stdio}
      />

      <Group title={t("scope.title")}>
        {scopeRows}
      </Group>

      <Group>
        <SwitchRow icon="power" title={t("mcp.enabled")} value={form.enabled} onChange={(v) => set("enabled", v)} />
      </Group>

      <Group>
        <ActionRow icon="bolt" title={testing ? t("mcp.connecting") : dirty || !savedId ? t("mcp.saveAndTest") : t("mcp.test")} busy={testing} onPress={() => void test()} />
        {outcome && !testing ? (
          outcome.ok ? (
            <TestResult ok title={t("mcp.connected", { count: outcome.tools?.length ?? 0 })} body={outcome.tools?.length ? undefined : t("mcp.noTools")} items={outcome.tools} />
          ) : (
            <TestResult ok={false} title={t("mcp.testFailed")} body={outcome.error || t("mcp.unknownError")} />
          )
        ) : null}
      </Group>

      {savedId ? (
        <Group>
          <ActionRow icon="trash" title={t("mcp.delete")} tone="danger" onPress={remove} />
        </Group>
      ) : null}
    </>
  );
}

function SecretGroup({
  title,
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
  upperCase,
}: {
  title: string;
  rows: SecretRow[];
  onChange: (rows: SecretRow[]) => void;
  keyPlaceholder: string;
  valuePlaceholder?: string;
  addLabel: string;
  upperCase?: boolean;
}) {
  const { t } = useTranslation("tools");
  return (
    <Group title={title} footer={t("mcp.secretsHint")}>
      {rows.map((row) => (
        <SecretRowEditor
          key={row.uid}
          row={row}
          upperCase={upperCase}
          keyPlaceholder={keyPlaceholder}
          valuePlaceholder={valuePlaceholder}
          onChange={(patch) => onChange(rows.map((r) => (r.uid === row.uid ? { ...r, ...patch } : r)))}
          onRemove={() => onChange(rows.filter((r) => r.uid !== row.uid))}
        />
      ))}
      <ActionRow icon="plus" title={addLabel} onPress={() => onChange([...rows, newRow()])} />
    </Group>
  );
}

/** A server Composio set up: switched on or off, tested and deleted here; its apps are managed in Composio. */
function Managed({ server }: { server: McpServer }) {
  const { t } = useTranslation(["tools", "common"]);
  const [enabled, setEnabled] = useState(server.enabled);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<McpTestResult | null>(null);

  const toggle = async (next: boolean) => {
    setEnabled(next);
    try {
      await toolsAdmin.mcp.update(server.id, { enabled: next });
      refreshTools();
    } catch (err) {
      setEnabled(!next);
      Alert.alert(t("mcp.saveFailed"), errorText(err));
    }
  };

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult(await toolsAdmin.mcp.test(server.id));
    } catch (err) {
      setResult({ ok: false, error: errorText(err) });
    } finally {
      setTesting(false);
    }
  };

  const remove = () =>
    Alert.alert(t("mcp.deleteTitle", { name: server.name }), t("mcp.deleteBody"), [
      { text: t("common:actions.cancel"), style: "cancel" },
      {
        text: t("common:actions.delete"),
        style: "destructive",
        onPress: async () => {
          try {
            await toolsAdmin.mcp.remove(server.id);
            refreshTools();
            router.back();
          } catch (err) {
            Alert.alert(t("mcp.deleteFailed"), errorText(err));
          }
        },
      },
    ]);

  return (
    <>
      <Group footer={t("mcp.managedFooter")}>
        <InfoRow icon="layers" label="Composio" value={server.composio?.toolkits.join(", ") || undefined} />
        <SwitchRow
          icon="power"
          title={t("mcp.enabled")}
          value={enabled}
          onChange={(v) => void toggle(v)}
        />
      </Group>
      <Group>
        <ActionRow icon="bolt" title={testing ? t("mcp.connecting") : t("mcp.test")} busy={testing} onPress={() => void test()} />
        {result && !testing ? (
          result.ok ? (
            <TestResult ok title={t("mcp.connected", { count: result.tools?.length ?? 0 })} items={result.tools} />
          ) : (
            <TestResult ok={false} title={t("mcp.testFailed")} body={result.error || t("mcp.unknownError")} />
          )
        ) : null}
      </Group>
      <Group>
        <ActionRow icon="trash" title={t("mcp.delete")} tone="danger" onPress={remove} />
      </Group>
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
