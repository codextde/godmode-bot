import { router } from "expo-router";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Agent, ComposioConnection, ComposioTriggerType } from "@godmode/shared";
import { ChoiceRow, Group, PickerRow, SwitchRow, type Option } from "./form";
import { Icon } from "./icon";
import { appName } from "./routine-row";
import { Badge, Button, Card, ErrorState, Row, SkeletonRows, T, tap } from "./ui";
import { errorText } from "@/lib/api";
import {
  appTriggerProblems,
  connectionUsableBy,
  EMPTY_APP_TRIGGER,
  useAppTriggerSchema,
  type AppTriggerDraft,
} from "@/lib/automation-admin";
import { useAgents } from "@/lib/hooks";
import { useComposioConnections, useComposioStatus } from "@/lib/integrations";
import { defaultConfig, jsonText, schemaFields, type ConfigState, type SchemaField } from "@/lib/schema-form";
import { fonts, radius, space, useColors } from "@/lib/theme";
import { useWorkspace } from "@/lib/workspace";

const SEARCH_FROM = 7;
const NONE = "__none";

/** Pick a connected account the agent may use, the event it reacts to, and that event's settings (desktop: app-trigger-fields.tsx). */
export function AppTriggerFields({
  value,
  onChange,
  agent,
  showProblems,
  title,
  onRemove,
}: {
  value: AppTriggerDraft;
  onChange: (value: AppTriggerDraft) => void;
  agent: Agent | undefined;
  showProblems: boolean;
  /** Another event of the same automation: its own heading and a way to take it out. */
  title?: string;
  onRemove?: () => void;
}) {
  const c = useColors();
  const { t } = useTranslation(["automations", "common"]);
  const status = useComposioStatus();
  const ready = !!status.data?.configured && status.data.valid !== false;
  const connectionsQ = useComposioConnections();
  const schema = useAppTriggerSchema(value);
  const problems = appTriggerProblems(value, schema);
  const scopeOf = useScopeLabel();
  const connections = useMemo(() => connectionsQ.data ?? [], [connectionsQ.data]);
  const options = useMemo(
    () => (agent ? connections.filter((x) => connectionUsableBy(x, agent) && (x.status.toUpperCase() === "ACTIVE" || x.id === value.connectionId)) : []),
    [connections, agent, value.connectionId],
  );

  const heading = title ? (
    <Row style={styles.heading}>
      <T variant="eyebrow" muted style={{ flex: 1 }}>
        {title}
      </T>
      {onRemove ? (
        <Pressable accessibilityRole="button" accessibilityLabel={t("appTrigger.removeEvent")} hitSlop={8} onPress={onRemove}>
          <Icon name="close" size={14} color={c.textMuted} />
        </Pressable>
      ) : null}
    </Row>
  ) : null;

  if (status.isLoading || (ready && connectionsQ.isLoading)) {
    return (
      <View>
        {heading}
        <Card>
          <SkeletonRows count={2} avatar={30} />
        </Card>
      </View>
    );
  }
  if (status.isError) return <ErrorState title={t("appTrigger.composioFailed")} error={errorText(status.error)} onRetry={() => void status.refetch()} />;
  if (!ready) return <ConnectHint title={t("appTrigger.connectFirstTitle")} body={t("appTrigger.connectFirstDescription")} action={t("appTrigger.setUpComposio")} to="/settings/composio" />;
  if (connectionsQ.isError) return <ErrorState title={t("appTrigger.accountsFailed")} error={errorText(connectionsQ.error)} onRetry={() => void connectionsQ.refetch()} />;
  if (!agent) {
    return (
      <T variant="footnote" muted>
        {t("appTrigger.chooseAgentFirst")}
      </T>
    );
  }
  if (options.length === 0) {
    const elsewhere = connections.some((x) => x.status.toUpperCase() === "ACTIVE");
    return elsewhere ? (
      <ConnectHint title={t("appTrigger.noUsableTitle", { name: agent.name })} body={t("appTrigger.noUsableDescription", { name: agent.name })} action={t("appTrigger.connectApp")} to="/settings/composio-connect" />
    ) : (
      <ConnectHint title={t("appTrigger.noAppsTitle")} body={t("appTrigger.noAppsDescription")} action={t("appTrigger.connectApp")} to="/settings/composio-connect" />
    );
  }

  const pickConnection = (id: string) => {
    const picked = options.find((x) => x.id === id);
    if (!picked) return;
    onChange(picked.toolkit === value.toolkit ? { ...value, connectionId: picked.id } : { ...EMPTY_APP_TRIGGER, connectionId: picked.id, toolkit: picked.toolkit });
  };
  const pickTrigger = (type: ComposioTriggerType) => onChange({ ...value, triggerSlug: type.slug, triggerName: type.name, config: defaultConfig(schemaFields(type.config)) });
  const accountOptions: Option<string>[] = options.map((x) => ({ value: x.id, label: appName(x.toolkit), detail: connectionDetail(x, scopeOf) }));

  return (
    <View style={{ gap: space.md }}>
      {heading}
      {value.connectionId ? (
        <Group>
          <PickerRow icon="layers" title={t("appTrigger.account")} value={value.connectionId} options={accountOptions} onChange={pickConnection} />
        </Group>
      ) : (
        <Group title={t("appTrigger.account")} footer={showProblems ? (problems.connection ?? undefined) : undefined}>
          {accountOptions.map((o) => (
            <ChoiceRow key={o.value} icon="layers" title={o.label} detail={o.detail} selected={false} onPress={() => pickConnection(o.value)} />
          ))}
        </Group>
      )}
      {value.toolkit ? (
        <EventPicker key={value.toolkit} toolkit={value.toolkit} schema={schema} selectedSlug={value.triggerSlug} onPick={pickTrigger} problem={showProblems ? problems.trigger : null} />
      ) : null}
      {problems.schema ? (
        <Row style={{ gap: space.sm }}>
          {schema.failed ? <Icon name="warning" size={14} color={c.danger} /> : <ActivityIndicator size="small" color={c.textMuted} />}
          <T variant="footnote" color={schema.failed ? c.danger : c.textMuted} style={{ flex: 1 }}>
            {schema.failed ? t("appTrigger.settingsFailedHint", { problem: problems.schema }) : problems.schema}
          </T>
          {schema.failed ? (
            <Pressable accessibilityRole="button" hitSlop={8} onPress={schema.retry}>
              <T variant="footnote" color={c.brandStrong} style={{ fontWeight: "600" }}>
                {t("common:actions.retry")}
              </T>
            </Pressable>
          ) : null}
        </Row>
      ) : null}
      {schema.triggerType && schema.fields.length ? (
        <SchemaFields
          title={t("common:words.settings")}
          fields={schema.fields}
          state={value.config}
          onChange={(config) => onChange({ ...value, config })}
          problems={problems.config}
          showProblems={showProblems}
        />
      ) : null}
    </View>
  );
}

function connectionDetail(x: ComposioConnection, scopeOf: (x: ComposioConnection) => string): string {
  const inactive = x.status.toUpperCase() !== "ACTIVE";
  return [scopeOf(x), inactive ? x.status.toLowerCase() : null].filter(Boolean).join(" · ");
}

/** "Global", the workspace's name or the agent's name: who may use a connected account. */
export function useScopeLabel() {
  const { t } = useTranslation("automations");
  const { byId } = useAgents();
  const { workspaces } = useWorkspace();
  return (x: Pick<ComposioConnection, "agentId" | "workspaceId">) =>
    x.agentId
      ? (byId.get(x.agentId)?.name ?? t("appTrigger.scope.oneAgent"))
      : x.workspaceId
        ? (workspaces.find((w) => w.id === x.workspaceId)?.name ?? t("appTrigger.scope.workspace"))
        : t("appTrigger.scope.global");
}

function ConnectHint({ title, body, action, to }: { title: string; body: string; action: string; to: "/settings/composio" | "/settings/composio-connect" }) {
  const c = useColors();
  return (
    <View style={[styles.hint, { borderColor: c.border, backgroundColor: c.surface }]}>
      <Icon name="plug" size={20} color={c.textMuted} />
      <T variant="callout" style={{ fontWeight: "600" }}>
        {title}
      </T>
      <T variant="footnote" muted>
        {body}
      </T>
      <Button title={action} icon="external" variant="secondary" onPress={() => router.push(to)} style={{ alignSelf: "flex-start", marginTop: space.xs }} />
    </View>
  );
}

function KindBadge({ kind }: { kind: ComposioTriggerType["kind"] }) {
  const { t } = useTranslation("automations");
  if (!kind) return null;
  return <Badge label={kind === "webhook" ? t("appTrigger.instant") : t("appTrigger.everyFewMin")} tone={kind === "webhook" ? "brand" : "neutral"} dot={false} />;
}

/** The event to react to: the picked one with Change, or the app's events to choose from. */
function EventPicker({
  toolkit,
  schema,
  selectedSlug,
  onPick,
  problem,
}: {
  toolkit: string;
  schema: ReturnType<typeof useAppTriggerSchema>;
  selectedSlug: string;
  onPick: (type: ComposioTriggerType) => void;
  problem: string | null;
}) {
  const c = useColors();
  const { t } = useTranslation(["automations", "common"]);
  const [open, setOpen] = useState(!selectedSlug);
  const [search, setSearch] = useState("");
  const app = appName(toolkit);
  const query = schema.list;
  const types = query.data ?? [];
  const selected = schema.triggerType;
  const q = search.trim().toLowerCase();
  const visible = q ? types.filter((type) => `${type.name} ${type.description}`.toLowerCase().includes(q)) : types;

  if (!open && selectedSlug) {
    return (
      <View style={{ gap: space.sm }}>
        <Group title={t("appTrigger.event")}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("appTrigger.changeEvent")}
            onPress={() => {
              tap();
              setOpen(true);
            }}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
          >
            <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
              <Row style={{ gap: space.sm, flexWrap: "wrap" }}>
                <T variant="callout" style={{ fontWeight: "600" }}>
                  {selected?.name ?? selectedSlug}
                </T>
                <KindBadge kind={selected?.kind ?? null} />
              </Row>
              {selected?.description ? (
                <T variant="footnote" muted numberOfLines={3}>
                  {selected.description}
                </T>
              ) : null}
            </View>
            <T variant="footnote" color={c.brandStrong} style={{ fontWeight: "600" }}>
              {t("appTrigger.change")}
            </T>
          </Pressable>
        </Group>
        {selected?.kind === "poll" ? (
          <T variant="footnote" muted>
            {t("appTrigger.pollHint", { app })}
          </T>
        ) : null}
        {selected?.requiresWebhookSetup ? (
          <View style={[styles.notice, { backgroundColor: c.warningSoft, borderColor: c.warning }]}>
            <Icon name="warning" size={14} color={c.warning} />
            <View style={{ flex: 1, gap: 4 }}>
              <T variant="footnote" style={{ fontWeight: "600" }}>
                {t("appTrigger.needsSetup", { app })}
              </T>
              {selected.instructions ? (
                <T variant="footnote" muted>
                  {selected.instructions}
                </T>
              ) : null}
            </View>
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <View style={{ gap: space.sm }}>
      <Row style={{ justifyContent: "space-between" }}>
        <T variant="eyebrow" muted>
          {t("appTrigger.event")}
        </T>
        {selectedSlug ? (
          <Pressable accessibilityRole="button" hitSlop={8} onPress={() => setOpen(false)}>
            <T variant="footnote" color={c.brandStrong} style={{ fontWeight: "600" }}>
              {t("appTrigger.keep", { name: selected?.name ?? t("appTrigger.currentEvent") })}
            </T>
          </Pressable>
        ) : null}
      </Row>
      {query.isLoading ? (
        <Card>
          <SkeletonRows count={3} avatar={0} />
        </Card>
      ) : query.isError ? (
        <ErrorState title={t("appTrigger.eventsFailed", { app })} error={errorText(query.error)} onRetry={() => void query.refetch()} />
      ) : types.length === 0 ? (
        <T variant="footnote" muted>
          {t("appTrigger.noEvents", { app })}
        </T>
      ) : (
        <>
          {types.length >= SEARCH_FROM ? (
            <View style={[styles.search, { backgroundColor: c.sunken }]}>
              <Icon name="search" size={14} color={c.textMuted} />
              <TextInput
                accessibilityLabel={t("appTrigger.searchLabel", { app })}
                value={search}
                onChangeText={setSearch}
                placeholder={t("appTrigger.searchPlaceholder", { app })}
                placeholderTextColor={c.textFaint}
                autoCorrect={false}
                clearButtonMode="while-editing"
                style={[styles.searchInput, { color: c.text }]}
              />
            </View>
          ) : null}
          <Group>
            {visible.map((type) => (
              <ChoiceRow
                key={type.slug}
                title={type.name}
                detail={[type.kind === "webhook" ? t("appTrigger.instant") : type.kind === "poll" ? t("appTrigger.everyFewMin") : null, type.description].filter(Boolean).join(" · ") || undefined}
                selected={type.slug === selectedSlug}
                onPress={() => {
                  onPick(type);
                  setOpen(false);
                }}
              />
            ))}
            {visible.length === 0 ? (
              <T variant="footnote" muted style={{ padding: space.lg, textAlign: "center" }}>
                {t("appTrigger.noMatch", { app, query: search.trim() })}
              </T>
            ) : null}
          </Group>
        </>
      )}
      {problem ? (
        <T variant="footnote" color={c.danger}>
          {problem}
        </T>
      ) : null}
    </View>
  );
}

/** A form made from a JSON schema's fields: switches, choices, text and numbers, and JSON for the rest. */
export function SchemaFields({
  title,
  fields,
  state,
  onChange,
  problems,
  showProblems,
}: {
  title?: string;
  fields: SchemaField[];
  state: ConfigState;
  onChange: (state: ConfigState) => void;
  problems: Record<string, string>;
  showProblems: boolean;
}) {
  const { t } = useTranslation("automations");
  const setValue = (key: string, v: unknown) => {
    const values = { ...state.values };
    if (v === undefined || v === null || v === "") delete values[key];
    else values[key] = v;
    onChange({ ...state, values });
  };
  const setJson = (key: string, text: string) => onChange({ ...state, json: { ...state.json, [key]: text } });
  const shown = Object.entries(problems).filter(([key]) => showProblems && fields.some((f) => f.key === key));

  return (
    <Group title={title} footer={shown.length ? shown.map(([key, p]) => `${fields.find((f) => f.key === key)?.title}: ${p}`).join("\n") : undefined}>
      {fields.map((f) => {
        const problem = showProblems ? problems[f.key] : undefined;
        if (f.kind === "boolean") {
          return <SwitchRow key={f.key} title={f.title} detail={f.description || undefined} value={state.values[f.key] === true} onChange={(v) => setValue(f.key, v)} />;
        }
        if (f.kind === "enum") {
          const options: Option<string>[] = [...(f.required ? [] : [{ value: NONE, label: t("schemaForm.notSet") }]), ...f.options.map((o) => ({ value: String(o), label: String(o) }))];
          const current = state.values[f.key];
          return (
            <PickerRow
              key={f.key}
              title={f.title}
              detail={f.description || undefined}
              value={current === undefined ? (f.required ? "" : NONE) : String(current)}
              options={options}
              onChange={(v) => setValue(f.key, v === NONE ? undefined : f.options.find((o) => String(o) === v))}
            />
          );
        }
        if (f.kind === "json") {
          return <FieldInput key={f.key} field={f} text={jsonText(state, f.key)} onText={(text) => setJson(f.key, text)} problem={problem} multiline />;
        }
        if (f.kind === "number" || f.kind === "integer") {
          return <NumberInput key={f.key} field={f} value={state.values[f.key]} onValue={(v) => setValue(f.key, v)} problem={problem} />;
        }
        return <FieldInput key={f.key} field={f} text={typeof state.values[f.key] === "string" ? (state.values[f.key] as string) : String(state.values[f.key] ?? "")} onText={(text) => setValue(f.key, text)} problem={problem} />;
      })}
    </Group>
  );
}

function NumberInput({ field, value, onValue, problem }: { field: SchemaField; value: unknown; onValue: (v: number | undefined) => void; problem?: string }) {
  // The typed text stays as typed ("1." on the way to "1.5"); the value is its number.
  const [text, setText] = useState(value === undefined ? "" : String(value));
  return (
    <FieldInput
      field={field}
      text={text}
      keyboard={field.kind === "integer" ? "number-pad" : "decimal-pad"}
      onText={(next) => {
        setText(next);
        const raw = next.trim().replace(",", ".");
        onValue(raw === "" ? undefined : Number(raw));
      }}
      problem={problem}
    />
  );
}

function FieldInput({
  field: f,
  text,
  onText,
  problem,
  multiline,
  keyboard,
}: {
  field: SchemaField;
  text: string;
  onText: (text: string) => void;
  problem?: string;
  multiline?: boolean;
  keyboard?: "number-pad" | "decimal-pad";
}) {
  const c = useColors();
  const { t } = useTranslation("common");
  return (
    <View style={styles.field}>
      <Row style={{ gap: 6 }}>
        <T variant="footnote" muted style={{ fontWeight: "500" }}>
          {f.title}
        </T>
        {!f.required ? (
          <T variant="caption" color={c.textFaint}>
            {t("words.optional")}
          </T>
        ) : null}
      </Row>
      <TextInput
        accessibilityLabel={f.title}
        value={text}
        onChangeText={onText}
        placeholder={multiline ? '{ "key": "value" }' : f.placeholder || undefined}
        placeholderTextColor={c.textFaint}
        keyboardType={keyboard}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        multiline={multiline}
        scrollEnabled={false}
        style={[
          styles.input,
          { color: c.text, backgroundColor: c.sunken, borderColor: problem ? c.danger : "transparent" },
          multiline && { fontFamily: fonts.mono, fontSize: 13, minHeight: 80, textAlignVertical: "top" },
        ]}
      />
      {f.description ? (
        <T variant="caption" muted numberOfLines={4}>
          {f.description}
        </T>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  heading: {
    gap: space.sm,
    paddingHorizontal: 4,
    marginBottom: space.xs,
  },
  hint: {
    gap: space.xs,
    padding: space.lg,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: "dashed",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 52,
    paddingHorizontal: space.lg,
    paddingVertical: 11,
  },
  notice: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.md,
    height: 38,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 0,
  },
  field: {
    gap: 6,
    paddingHorizontal: space.lg,
    paddingVertical: 11,
  },
  input: {
    fontSize: 15,
    paddingHorizontal: space.md,
    paddingVertical: 9,
    borderRadius: radius.md,
    borderCurve: "continuous",
    borderWidth: 1,
  },
});
