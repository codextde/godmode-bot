import { useMemo, useState } from "react";
import { Link } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { ArrowUpRight, Boxes, ChevronDown, Clock, RefreshCw, Search, TriangleAlert, Zap } from "lucide-react";
import type { Agent, ComposioConnection, ComposioTriggerType } from "@godmode/shared";
import { t as translate } from "@/i18n";
import { useAllAgents, useComposioTriggerType, useComposioTriggerTypes, useWorkspaces } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { useComposioConnections, useComposioStatus } from "@/components/integrations/composio-tab";
import { QueryError } from "@/components/integrations/query-error";
import { prettySlug, ToolkitLogo, toolkitLogoUrl } from "@/components/integrations/toolkit-logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { configProblems, defaultConfig, JsonSchemaForm, schemaFields, type ConfigState } from "./json-schema-form";

export interface AppTriggerDraft {
  connectionId: string;
  toolkit: string;
  triggerSlug: string;
  triggerName: string;
  config: ConfigState;
}

export const EMPTY_APP_TRIGGER: AppTriggerDraft = { connectionId: "", toolkit: "", triggerSlug: "", triggerName: "", config: { values: {}, json: {} } };

/**
 * Accounts an agent may watch — the core's rule: an agent-pinned account only for that agent, otherwise global
 * accounts and those of the agent's workspace. Accounts without a Composio account id can't have triggers.
 */
export function connectionUsableBy(connection: ComposioConnection, agent: Agent): boolean {
  if (!connection.connectedAccountId) return false;
  return connection.agentId ? connection.agentId === agent.id : !connection.workspaceId || connection.workspaceId === agent.workspaceId;
}

/**
 * The chosen trigger type and its config fields. Looked up in the toolkit's list, falling back to the single
 * trigger endpoint (for an automation whose trigger type isn't listed anymore).
 */
export function useAppTriggerSchema(app: AppTriggerDraft) {
  const list = useComposioTriggerTypes(app.toolkit || null);
  const listed = list.data?.find((t) => t.slug === app.triggerSlug);
  const single = useComposioTriggerType(app.triggerSlug || null, list.isFetched && !listed);
  const triggerType = listed ?? single.data ?? null;
  const fields = useMemo(() => schemaFields(triggerType?.config), [triggerType]);
  // A picked event whose settings aren't known yet can't be validated, so it can't be saved either.
  const failed = !!app.triggerSlug && !triggerType && list.isFetched && single.isError;
  const loading = !!app.triggerSlug && !triggerType && !failed;
  return { list, triggerType, fields, loading, failed, retry: () => (list.isError ? list.refetch() : single.refetch()) };
}

export type AppTriggerSchema = ReturnType<typeof useAppTriggerSchema>;

/** Why the app trigger can't be saved yet, per part. */
export function appTriggerProblems(app: AppTriggerDraft, schema: AppTriggerSchema) {
  return {
    connection: !app.connectionId ? translate("automations:appTrigger.pickAccount") : null,
    trigger: !app.triggerSlug ? translate("automations:appTrigger.pickEvent") : null,
    schema: schema.loading
      ? translate("automations:appTrigger.loadingSettings")
      : schema.failed
        ? translate("automations:appTrigger.settingsFailed")
        : null,
    config: schema.triggerType ? configProblems(schema.fields, app.config) : {},
  };
}

const TRIGGER_SEARCH_THRESHOLD = 7;

/** Pick a connected account the agent may use, the event it should react to, and that event's settings. */
export function AppTriggerFields({
  value,
  onChange,
  agent,
  showProblems,
}: {
  value: AppTriggerDraft;
  onChange: (value: AppTriggerDraft) => void;
  /** Who does the work; only accounts in its reach can be watched. */
  agent: Agent | undefined;
  showProblems: boolean;
}) {
  const { t } = useTranslation(["automations", "common"]);
  const status = useComposioStatus();
  const ready = !!status.data?.configured && status.data.valid !== false;
  const connectionsQ = useComposioConnections(ready);
  const schema = useAppTriggerSchema(value);
  const { list, triggerType, fields } = schema;
  const problems = appTriggerProblems(value, schema);

  const connections = useMemo(() => connectionsQ.data ?? [], [connectionsQ.data]);
  // Active accounts in the agent's reach — plus the saved one even if it's no longer active, so editing doesn't
  // silently switch it.
  const options = useMemo(
    () =>
      agent
        ? connections.filter((c) => connectionUsableBy(c, agent) && (c.status.toUpperCase() === "ACTIVE" || c.id === value.connectionId))
        : [],
    [connections, agent, value.connectionId],
  );
  const listLogo = list.data?.find((type) => type.toolkitLogo)?.toolkitLogo;
  const logoOf = (toolkit: string) => (toolkit === value.toolkit && listLogo) || toolkitLogoUrl(toolkit);

  if (status.isLoading || (ready && connectionsQ.isLoading)) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-9 w-full rounded-md" />
        <Skeleton className="h-24 w-full rounded-lg" />
      </div>
    );
  }
  if (status.isError) return <QueryError error={status.error} onRetry={() => status.refetch()} title={t("appTrigger.composioFailed")} />;
  if (!ready) {
    return (
      <ConnectHint
        title={t("appTrigger.connectFirstTitle")}
        description={t("appTrigger.connectFirstDescription")}
        action={t("appTrigger.setUpComposio")}
      />
    );
  }
  if (connectionsQ.isError) return <QueryError error={connectionsQ.error} onRetry={() => connectionsQ.refetch()} title={t("appTrigger.accountsFailed")} />;
  if (!agent) {
    return (
      <p className="rounded-lg border border-dashed bg-card/60 px-3 py-2.5 text-sm text-muted-foreground">
        {t("appTrigger.chooseAgentFirst")}
      </p>
    );
  }
  if (options.length === 0) {
    const elsewhere = connections.some((c) => c.status.toUpperCase() === "ACTIVE");
    return elsewhere ? (
      <ConnectHint
        title={t("appTrigger.noUsableTitle", { name: agent.name })}
        description={t("appTrigger.noUsableDescription", { name: agent.name })}
        action={t("appTrigger.connectApp")}
      />
    ) : (
      <ConnectHint
        title={t("appTrigger.noAppsTitle")}
        description={t("appTrigger.noAppsDescription")}
        action={t("appTrigger.connectApp")}
      />
    );
  }

  const pickConnection = (id: string) => {
    const c = options.find((x) => x.id === id);
    if (!c) return;
    const sameToolkit = c.toolkit === value.toolkit;
    onChange(sameToolkit ? { ...value, connectionId: c.id } : { ...EMPTY_APP_TRIGGER, connectionId: c.id, toolkit: c.toolkit });
  };

  const pickTrigger = (type: ComposioTriggerType) =>
    onChange({ ...value, triggerSlug: type.slug, triggerName: type.name, config: defaultConfig(schemaFields(type.config)) });

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="automation-connection" className="text-xs text-muted-foreground">
            {t("appTrigger.account")}
          </Label>
          <Link to="/settings/integrations" className="flex items-center gap-0.5 text-xs text-muted-foreground transition hover:text-foreground">
            {t("appTrigger.connectAnother")} <ArrowUpRight className="size-3" />
          </Link>
        </div>
        <Select value={value.connectionId} onValueChange={pickConnection}>
          <SelectTrigger
            id="automation-connection"
            className="h-10 w-full"
            aria-invalid={showProblems && !!problems.connection}
            aria-describedby={showProblems && problems.connection ? "automation-connection-error" : undefined}
          >
            <SelectValue placeholder={t("appTrigger.accountPlaceholder")} />
          </SelectTrigger>
          <SelectContent position="popper">
            {options.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                <ToolkitLogo src={logoOf(c.toolkit)} name={c.toolkit} size="sm" className="size-5 rounded-[5px] text-[10px] shadow-none" />
                <span>{prettySlug(c.toolkit)}</span>
                <ConnectionScope connection={c} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {showProblems && problems.connection && (
          <p id="automation-connection-error" className="text-xs text-destructive">
            {problems.connection}
          </p>
        )}
      </div>

      {value.toolkit && (
        <TriggerTypePicker
          key={value.toolkit}
          toolkit={value.toolkit}
          query={list}
          selected={triggerType}
          selectedSlug={value.triggerSlug}
          onPick={pickTrigger}
          problem={showProblems ? problems.trigger : null}
        />
      )}

      {problems.schema && (
        <div
          className={cn("flex items-center gap-2 text-xs", schema.failed ? "text-destructive" : "text-muted-foreground")}
          role={schema.failed ? "alert" : "status"}
        >
          {schema.failed ? <TriangleAlert className="size-3.5 shrink-0" /> : <Spinner className="size-3.5" aria-hidden />}
          <span className="min-w-0 flex-1">{schema.failed ? t("appTrigger.settingsFailedHint", { problem: problems.schema }) : problems.schema}</span>
          {schema.failed && (
            <Button type="button" size="xs" variant="outline" onClick={() => schema.retry()}>
              <RefreshCw /> {t("common:actions.retry")}
            </Button>
          )}
        </div>
      )}

      {triggerType && fields.length > 0 && (
        <div className="space-y-2.5">
          <div className="eyebrow">{t("common:words.settings")}</div>
          <JsonSchemaForm
            key={triggerType.slug}
            fields={fields}
            state={value.config}
            onChange={(config) => onChange({ ...value, config })}
            problems={problems.config}
            showProblems={showProblems}
            idPrefix="automation-config"
          />
        </div>
      )}
    </div>
  );
}

function ConnectionScope({ connection }: { connection: ComposioConnection }) {
  const { t } = useTranslation("automations");
  const { data: workspaces = [] } = useWorkspaces();
  const { data: agents = [] } = useAllAgents();
  const label = connection.agentId
    ? (agents.find((a) => a.id === connection.agentId)?.name ?? t("appTrigger.scope.oneAgent"))
    : connection.workspaceId
      ? (workspaces.find((w) => w.id === connection.workspaceId)?.name ?? t("appTrigger.scope.workspace"))
      : t("appTrigger.scope.global");
  const inactive = connection.status.toUpperCase() !== "ACTIVE";
  return (
    <span className={cn("text-xs text-muted-foreground", inactive && "text-warning")}>
      · {label}
      {inactive && ` · ${connection.status.toLowerCase()}`}
    </span>
  );
}

function ConnectHint({ title, description, action }: { title: string; description: string; action: string }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed bg-card/60 p-4 sm:flex-row sm:items-center">
      <div className="grid size-9 shrink-0 place-items-center rounded-lg border bg-card text-foreground shadow-card">
        <Boxes className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <Button asChild size="sm" variant="outline" className="shrink-0">
        <Link to="/settings/integrations">
          {action} <ArrowUpRight />
        </Link>
      </Button>
    </div>
  );
}

function KindBadge({ kind }: { kind: ComposioTriggerType["kind"] }) {
  const { t } = useTranslation("automations");
  if (!kind) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-[5px] border bg-card px-1.5 py-px text-[10px] font-medium text-muted-foreground">
      {kind === "webhook" ? <Zap className="size-3" /> : <Clock className="size-3" />}
      {kind === "webhook" ? t("appTrigger.instant") : t("appTrigger.everyFewMin")}
    </span>
  );
}

function TriggerTypePicker({
  toolkit,
  query,
  selected,
  selectedSlug,
  onPick,
  problem,
}: {
  toolkit: string;
  query: ReturnType<typeof useComposioTriggerTypes>;
  selected: ComposioTriggerType | null;
  selectedSlug: string;
  onPick: (t: ComposioTriggerType) => void;
  problem: string | null;
}) {
  const { t } = useTranslation("automations");
  const [open, setOpen] = useState(!selectedSlug);
  const [search, setSearch] = useState("");
  const app = prettySlug(toolkit);
  const types = query.data ?? [];
  const q = search.trim().toLowerCase();
  const visible = q ? types.filter((type) => `${type.name} ${type.description}`.toLowerCase().includes(q)) : types;

  return (
    <div className="space-y-1.5">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <span id="automation-trigger-label" className="text-xs text-muted-foreground">
          {t("appTrigger.event")}
        </span>
        {open && selectedSlug && (
          <Button type="button" size="xs" variant="ghost" className="text-muted-foreground" onClick={() => setOpen(false)}>
            {t("appTrigger.keep", { name: selected?.name ?? t("appTrigger.currentEvent") })}
          </Button>
        )}
      </div>

      {!open && (selected || selectedSlug) ? (
        <div className="space-y-2">
          <div className="flex items-start gap-3 rounded-lg border border-foreground/25 bg-paper-2 p-3 ring-1 ring-foreground/10">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{selected?.name ?? selectedSlug}</span>
                <KindBadge kind={selected?.kind ?? null} />
              </div>
              {selected?.description && <p className="mt-0.5 text-xs text-muted-foreground">{selected.description}</p>}
            </div>
            <Button type="button" size="xs" variant="outline" onClick={() => setOpen(true)} aria-label={t("appTrigger.changeEvent")}>
              {t("appTrigger.change")} <ChevronDown />
            </Button>
          </div>
          {selected?.kind === "poll" && (
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Clock className="mt-px size-3.5 shrink-0" />
              {t("appTrigger.pollHint", { app })}
            </p>
          )}
          {selected?.requiresWebhookSetup && (
            <div className="rounded-lg border border-warning/25 bg-warning/[0.07] p-3 text-xs">
              <p className="flex items-start gap-1.5 font-medium text-foreground">
                <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" />
                {t("appTrigger.needsSetup", { app })}
              </p>
              {selected.instructions && <p className="mt-1.5 pl-5 whitespace-pre-line text-muted-foreground">{selected.instructions}</p>}
            </div>
          )}
        </div>
      ) : query.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded-lg" />
          ))}
        </div>
      ) : query.isError ? (
        <QueryError error={query.error} onRetry={() => query.refetch()} title={t("appTrigger.eventsFailed", { app })} />
      ) : types.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
          {t("appTrigger.noEvents", { app })}
        </p>
      ) : (
        <div className="space-y-2">
          {types.length >= TRIGGER_SEARCH_THRESHOLD && (
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("appTrigger.searchPlaceholder", { app })} aria-label={t("appTrigger.searchLabel", { app })} className="h-8 pl-9" />
            </div>
          )}
          <RadioGroup
            value={selectedSlug}
            onValueChange={(slug) => {
              const type = types.find((x) => x.slug === slug);
              if (!type) return;
              onPick(type);
              setOpen(false);
            }}
            aria-labelledby="automation-trigger-label"
            aria-invalid={!!problem}
            aria-describedby={problem ? "automation-trigger-error" : undefined}
            className="max-h-64 gap-1.5 overflow-y-auto rounded-lg border bg-card p-1.5 shadow-card"
          >
            <AnimatePresence initial={false}>
              {visible.map((type) => (
                <motion.div key={type.slug} layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <Label
                    htmlFor={`trigger-${type.slug}`}
                    className="flex cursor-pointer items-start gap-3 rounded-md p-2.5 font-normal transition-colors hover:bg-accent has-[[data-state=checked]]:bg-paper-2 has-[[data-state=checked]]:ring-1 has-[[data-state=checked]]:ring-foreground/15"
                  >
                    <RadioGroupItem id={`trigger-${type.slug}`} value={type.slug} className="mt-0.5" />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{type.name}</span>
                        <KindBadge kind={type.kind} />
                      </span>
                      {type.description && <span className="mt-0.5 line-clamp-2 block text-xs leading-snug text-muted-foreground">{type.description}</span>}
                    </span>
                  </Label>
                </motion.div>
              ))}
            </AnimatePresence>
            {visible.length === 0 && <p className="p-3 text-center text-xs text-muted-foreground">{t("appTrigger.noMatch", { app, query: search.trim() })}</p>}
          </RadioGroup>
        </div>
      )}
      {problem && (
        <p id="automation-trigger-error" className="text-xs text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}
