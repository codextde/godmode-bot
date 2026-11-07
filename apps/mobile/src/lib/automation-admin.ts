import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Agent, AutomationEvent, ComposioConnection, ComposioTriggerType, Routine, RoutineInput, ServerSettings, TestEventInput, WebhookRotateResult } from "@godmode/shared";
import { request } from "./api";
import { ik } from "./integrations";
import { qk, queryClient } from "./query";
import { configProblems, schemaFields, straightQuotes, type ConfigState } from "./schema-form";
import { t } from "./i18n";

/**
 * Automations as the desktop app sets them up (full-access phones): app and webhook triggers, test events and the
 * webhook's secret URL.
 */
export const automationAdmin = {
  /** `grant`: lifting `fillOnly` needs the vault password. */
  updateWithGrant: (id: string, input: Partial<RoutineInput>, grant?: string) =>
    request<Routine>("PATCH", `/api/routines/${encodeURIComponent(id)}`, input, 0, grant ? { "x-godmode-grant": grant } : undefined),
  /** App/webhook automations: a sample event that goes through the filter like a real one. */
  testEvent: (id: string, input: TestEventInput = {}) => request<AutomationEvent>("POST", `/api/routines/${encodeURIComponent(id)}/test-event`, input),
  /** Webhook automations: a new secret URL; the old one stops working. */
  rotateWebhook: (id: string) => request<WebhookRotateResult>("POST", `/api/routines/${encodeURIComponent(id)}/webhook/rotate`, {}),
  triggerTypes: (toolkit: string) => request<ComposioTriggerType[]>("GET", `/api/composio/trigger-types?toolkit=${encodeURIComponent(toolkit)}`),
  triggerType: (slug: string) => request<ComposioTriggerType>("GET", `/api/composio/trigger-types/${encodeURIComponent(slug)}`),
};

export const ak = {
  triggerTypes: (toolkit: string) => [...ik.composioStatus.slice(0, 2), "trigger-types", toolkit],
  triggerType: (slug: string) => [...ik.composioStatus.slice(0, 2), "trigger-type", slug],
};

/** Puts a rotated path into every cached automation list right away. */
export function patchWebhookPath(id: string, webhookPath: string) {
  queryClient.setQueriesData<Routine[]>({ queryKey: qk.routines }, (list) => (Array.isArray(list) ? list.map((r) => (r.id === id ? { ...r, webhookPath } : r)) : list));
  void queryClient.invalidateQueries({ queryKey: qk.routines });
}

/** The draft of one app event: the account, the event and its settings. */
export interface AppTriggerDraft {
  connectionId: string;
  toolkit: string;
  triggerSlug: string;
  triggerName: string;
  config: ConfigState;
}

export const EMPTY_APP_TRIGGER: AppTriggerDraft = { connectionId: "", toolkit: "", triggerSlug: "", triggerName: "", config: { values: {}, json: {} } };

/**
 * Accounts an agent may watch (the core's rule): an agent's own account only for it, otherwise global accounts and
 * those of its workspace. Accounts without a Composio account id can't have triggers.
 */
export function connectionUsableBy(connection: ComposioConnection, agent: Agent): boolean {
  if (!connection.connectedAccountId) return false;
  return connection.agentId ? connection.agentId === agent.id : !connection.workspaceId || connection.workspaceId === agent.workspaceId;
}

/** The chosen event's type and fields: from the app's list, else asked for by itself (an event no longer listed). */
export function useAppTriggerSchema(app: AppTriggerDraft) {
  const list = useQuery({ queryKey: ak.triggerTypes(app.toolkit), queryFn: () => automationAdmin.triggerTypes(app.toolkit), enabled: !!app.toolkit, staleTime: 5 * 60_000 });
  const listed = list.data?.find((x) => x.slug === app.triggerSlug);
  const single = useQuery({
    queryKey: ak.triggerType(app.triggerSlug),
    queryFn: () => automationAdmin.triggerType(app.triggerSlug),
    enabled: !!app.triggerSlug && list.isFetched && !listed,
    staleTime: 5 * 60_000,
  });
  const triggerType = listed ?? single.data ?? null;
  const fields = useMemo(() => schemaFields(triggerType?.config), [triggerType]);
  const failed = !!app.triggerSlug && !triggerType && list.isFetched && single.isError;
  const loading = !!app.triggerSlug && !triggerType && !failed;
  return { list, triggerType, fields, loading, failed, retry: () => void (list.isError ? list.refetch() : single.refetch()) };
}

export type AppTriggerSchema = ReturnType<typeof useAppTriggerSchema>;

/** Why an app event can't be saved yet, part by part. */
export function appTriggerProblems(app: AppTriggerDraft, schema: AppTriggerSchema) {
  return {
    connection: !app.connectionId ? t("automations:appTrigger.pickAccount") : null,
    trigger: !app.triggerSlug ? t("automations:appTrigger.pickEvent") : null,
    schema: schema.loading ? t("automations:appTrigger.loadingSettings") : schema.failed ? t("automations:appTrigger.settingsFailed") : null,
    config: schema.triggerType ? configProblems(schema.fields, app.config) : ({} as Record<string, string>),
  };
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * The webhook's full address as the computer receives it (the desktop shows the same). The phone's own link to the
 * computer doesn't take webhooks, so this is the computer's address: `local` when only the computer itself reaches it.
 */
export function webhookUrl(path: string, server: Pick<ServerSettings, "host" | "port"> | undefined): { url: string; local: boolean } {
  const raw = (server?.host ?? "").trim();
  const host = !raw || raw === "0.0.0.0" || raw === "::" ? "127.0.0.1" : raw;
  const shown = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const port = server?.port ? `:${server.port}` : "";
  return { url: `http://${shown}${port}${path}`, local: LOOPBACK.has(host) || host.endsWith(".localhost") };
}

export const SAMPLE_BODY = '{"event": "checkout.abandoned", "items": 2, "total": 128}';

export function curlFor(url: string): string {
  return `curl -X POST '${url}' \\\n  -H 'content-type: application/json' \\\n  -d '${SAMPLE_BODY}'`;
}

/**
 * Text that looks like JSON (starts with `{` or `[`) is sent parsed, anything else as plain text; empty = the core's
 * small example. `error` when JSON-looking text doesn't parse.
 */
export function parsePayload(text: string): { input: TestEventInput; error: string | null } {
  const raw = straightQuotes(text).trim();
  if (!raw) return { input: {}, error: null };
  if (!raw.startsWith("{") && !raw.startsWith("[")) return { input: { payload: raw }, error: null };
  try {
    return { input: { payload: JSON.parse(raw) as unknown }, error: null };
  } catch {
    return { input: {}, error: t("automations:testEvent.invalidJson") };
  }
}
