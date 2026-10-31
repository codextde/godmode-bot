import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { Info, Save, FlaskConical } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { McpServer, McpServerInput, McpTransport } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toastApiError } from "@/components/vault/vault-utils";
import { t } from "@/i18n";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { KeyValueEditor, newRow, rowsError, rowsFromKeys, rowsToRecord, type KeyValueRow } from "./key-value-editor";
import {
  ENV_KEY_PATTERN,
  formatArgs,
  HEADER_KEY_PATTERN,
  NAME_PATTERN,
  parseArgs,
  TRANSPORTS,
  type McpPreset,
} from "./mcp-utils";
import { ScopePicker, useDefaultScope, type IntegrationScope } from "./scope-picker";

interface FormState {
  name: string;
  description: string;
  transport: McpTransport;
  command: string;
  argsText: string;
  url: string;
  env: KeyValueRow[];
  headers: KeyValueRow[];
  scope: IntegrationScope;
  enabled: boolean;
}

function fromServer(s: McpServer): FormState {
  return {
    name: s.name,
    description: s.description,
    transport: s.transport,
    command: s.command,
    argsText: formatArgs(s.args),
    url: s.url,
    env: rowsFromKeys(s.envKeys),
    headers: rowsFromKeys(s.headerKeys),
    scope: { workspaceId: s.workspaceId, agentId: s.agentId },
    enabled: s.enabled,
  };
}

function fromPreset(p: McpPreset | null, scope: IntegrationScope): FormState {
  return {
    name: p?.name ?? "",
    description: p ? t(p.description, { ns: "integrations" }) : "",
    transport: p?.transport ?? "stdio",
    command: p?.command ?? "",
    argsText: p?.args ? formatArgs(p.args) : "",
    url: p?.url ?? "",
    env: (p?.envKeys ?? []).map((k) => newRow(k)),
    headers: (p?.headerKeys ?? []).map((k) => newRow(k)),
    scope,
    enabled: true,
  };
}

function validate(f: FormState): Partial<Record<"name" | "command" | "url" | "env" | "headers" | "scope", string>> {
  const errors: ReturnType<typeof validate> = {};
  if (!f.name.trim()) errors.name = t("integrations:mcpDialog.errors.nameMissing");
  else if (!NAME_PATTERN.test(f.name.trim())) errors.name = t("integrations:mcpDialog.errors.nameInvalid");
  if (f.transport === "stdio") {
    if (!f.command.trim()) errors.command = t("integrations:mcpDialog.errors.commandMissing");
  } else {
    try {
      const u = new URL(f.url.trim());
      if (u.protocol !== "http:" && u.protocol !== "https:") errors.url = t("integrations:mcpDialog.errors.urlProtocol");
    } catch {
      errors.url = t("integrations:mcpDialog.errors.urlInvalid");
    }
  }
  const envErr = rowsError(f.env, ENV_KEY_PATTERN, "env");
  if (envErr) errors.env = envErr;
  const headerErr = rowsError(f.headers, HEADER_KEY_PATTERN, "header");
  if (headerErr) errors.headers = headerErr;
  return errors;
}

export type McpDialogState = { mode: "create"; preset: McpPreset | null } | { mode: "edit"; server: McpServer } | null;

/** Add / edit a custom MCP server. Secret env/header values are write-only. */
export function McpServerDialog({
  state,
  onOpenChange,
  onSaved,
}: {
  state: McpDialogState;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful save; `test` = the user chose "Save & test". */
  onSaved?: (server: McpServer, test: boolean) => void;
}) {
  const { t } = useTranslation(["integrations", "common"]);
  const qc = useQueryClient();
  const defaultScope = useDefaultScope();
  const [form, setForm] = useState<FormState>(() => fromPreset(null, defaultScope));
  const [touched, setTouched] = useState(false);
  // Keep the last target so the closing animation doesn't flash an empty form; reset when a new target opens.
  const [target, setTarget] = useState<McpDialogState>(null);
  if (state && state !== target) {
    setTarget(state);
    setTouched(false);
    setForm(state.mode === "edit" ? fromServer(state.server) : fromPreset(state.preset, defaultScope));
  }
  const editing = target?.mode === "edit" ? target.server : null;
  const preset = target?.mode === "create" ? target.preset : null;

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const errors = validate(form);
  const hasErrors = Object.keys(errors).length > 0;

  const save = useMutation({
    mutationFn: async ({ test }: { test: boolean }) => {
      const input: McpServerInput = {
        workspaceId: form.scope.workspaceId,
        agentId: form.scope.agentId,
        name: form.name.trim(),
        description: form.description.trim(),
        transport: form.transport,
        command: form.transport === "stdio" ? form.command.trim() : "",
        args: form.transport === "stdio" ? parseArgs(form.argsText) : [],
        url: form.transport === "stdio" ? "" : form.url.trim(),
        env: form.transport === "stdio" ? rowsToRecord(form.env) : {},
        headers: form.transport === "stdio" ? {} : rowsToRecord(form.headers),
        enabled: form.enabled,
      };
      const server = editing ? await api.mcpServers.update(editing.id, input) : await api.mcpServers.create(input);
      return { server, test };
    },
    onSuccess: ({ server, test }) => {
      void qc.invalidateQueries({ queryKey: qk.mcpServers });
      toast.success(editing ? t("mcpDialog.saved", { name: server.name }) : t("mcpDialog.added", { name: server.name }), {
        description: server.enabled ? t("mcpDialog.savedEnabled") : t("mcpDialog.savedDisabled"),
      });
      onOpenChange(false);
      onSaved?.(server, test);
    },
    onError: (e) => toastApiError(e, t("mcpDialog.saveFailed"), qc),
  });

  const submit = (test: boolean) => (e?: FormEvent) => {
    e?.preventDefault();
    setTouched(true);
    if (!hasErrors) save.mutate({ test });
  };

  // Pasting a whole command line into "Command" splits it into command + args.
  const onCommandBlur = () => {
    const parts = parseArgs(form.command.trim());
    if (parts.length > 1 && !form.argsText.trim()) setForm((f) => ({ ...f, command: parts[0], argsText: formatArgs(parts.slice(1)) }));
  };

  const err = (k: keyof ReturnType<typeof validate>) => (touched ? errors[k] : undefined);

  return (
    <Dialog open={!!state} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing ? t("mcpDialog.editTitle", { name: editing.name }) : preset ? t("mcpDialog.addNamed", { name: preset.name }) : t("mcpDialog.addTitle")}</DialogTitle>
          <DialogDescription>{t("mcpDialog.description")}</DialogDescription>
        </DialogHeader>

        <form id="mcp-form" onSubmit={submit(false)} className="space-y-5">
          {preset?.note && (
            <div className="flex items-start gap-2.5 rounded-lg border bg-paper-2 p-3 text-xs">
              <Info className="mt-0.5 size-4 shrink-0 text-foreground" />
              {t(preset.note)}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="mcp-name">{t("common:words.name")}</Label>
              <Input
                id="mcp-name"
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder={t("mcpDialog.namePlaceholder")}
                aria-invalid={!!err("name")}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
              />
              {err("name") ? <p className="text-xs text-destructive">{err("name")}</p> : <p className="text-xs text-muted-foreground">{t("mcpDialog.toolsAppearAs", { prefix: `mcp__${form.name.trim() || "name"}__…` })}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="mcp-desc">{t("common:words.description")}</Label>
              <Input id="mcp-desc" value={form.description} onChange={(e) => set("description", e.target.value)} placeholder={t("mcpDialog.descriptionPlaceholder")} />
            </div>
          </div>

          <div className="space-y-2">
            <Label id="mcp-transport-label">{t("mcpDialog.transport")}</Label>
            <div role="radiogroup" aria-labelledby="mcp-transport-label" className="grid grid-cols-3 gap-1 rounded-lg border bg-secondary p-0.5">
              {TRANSPORTS.map((tr) => {
                const active = form.transport === tr.id;
                return (
                  <button
                    key={tr.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => set("transport", tr.id)}
                    className={cn(
                      "relative flex h-8 items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors",
                      active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {active && (
                      <motion.span
                        layoutId="mcp-transport"
                        className="absolute inset-0 rounded-md bg-card shadow-card ring-1 ring-border dark:bg-accent"
                        transition={{ type: "spring", stiffness: 420, damping: 34 }}
                      />
                    )}
                    <tr.icon className="relative size-4" />
                    <span className="relative">{t(tr.label)}</span>
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">{t(TRANSPORTS.find((tr) => tr.id === form.transport)?.hint ?? TRANSPORTS[0].hint)}</p>
          </div>

          <AnimatePresence mode="wait" initial={false}>
            {form.transport === "stdio" ? (
              <motion.div key="stdio" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="mcp-command">{t("mcpDialog.command")}</Label>
                  <Input
                    id="mcp-command"
                    value={form.command}
                    onChange={(e) => set("command", e.target.value)}
                    onBlur={onCommandBlur}
                    placeholder="npx"
                    className="font-mono"
                    aria-invalid={!!err("command")}
                    spellCheck={false}
                    autoCapitalize="off"
                  />
                  {err("command") && <p className="text-xs text-destructive">{err("command")}</p>}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="mcp-args">{t("mcpDialog.arguments")}</Label>
                  <Textarea
                    id="mcp-args"
                    value={form.argsText}
                    onChange={(e) => set("argsText", e.target.value)}
                    placeholder={"-y @scope/mcp-server --flag value"}
                    className="min-h-20 font-mono text-[13px]"
                    spellCheck={false}
                    autoCapitalize="off"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("mcpDialog.argumentsHint")}
                    {parseArgs(form.argsText).length > 0 && ` ${t("mcpDialog.argumentCount", { count: parseArgs(form.argsText).length })}`}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label>{t("mcpDialog.envVars")}</Label>
                  <KeyValueEditor
                    label={t("mcpDialog.envVar")}
                    rows={form.env}
                    onChange={(rows) => set("env", rows)}
                    keyPlaceholder="API_KEY"
                    addLabel={t("mcpDialog.addVariable")}
                    keyTransform={(s) => s.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}
                  />
                  {err("env") && <p className="text-xs text-destructive">{err("env")}</p>}
                </div>
              </motion.div>
            ) : (
              <motion.div key="remote" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="mcp-url">URL</Label>
                  <Input
                    id="mcp-url"
                    type="url"
                    value={form.url}
                    onChange={(e) => set("url", e.target.value)}
                    placeholder="https://example.com/mcp"
                    className="font-mono"
                    aria-invalid={!!err("url")}
                    spellCheck={false}
                  />
                  {err("url") && <p className="text-xs text-destructive">{err("url")}</p>}
                </div>
                <div className="space-y-2">
                  <Label>{t("mcpDialog.headers")}</Label>
                  <KeyValueEditor
                    label={t("mcpDialog.header")}
                    rows={form.headers}
                    onChange={(rows) => set("headers", rows)}
                    keyPlaceholder="Authorization"
                    valuePlaceholder={t("mcpDialog.headerValuePlaceholder")}
                    addLabel={t("mcpDialog.addHeader")}
                  />
                  {err("headers") && <p className="text-xs text-destructive">{err("headers")}</p>}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <p className="-mt-1 text-xs text-muted-foreground">{t("mcpDialog.secretsHint")}</p>

          <div className="space-y-2">
            <Label>{t("mcpDialog.availableTo")}</Label>
            <ScopePicker value={form.scope} onChange={(scope) => set("scope", scope)} />
          </div>

          <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border bg-paper-2 p-3">
            <span>
              <span className="block text-sm font-medium">{t("mcpDialog.enabled")}</span>
              <span className="block text-xs text-muted-foreground">{t("mcpDialog.enabledHint")}</span>
            </span>
            <Switch checked={form.enabled} onCheckedChange={(v) => set("enabled", v)} aria-label={t("mcpDialog.enabled")} />
          </label>
        </form>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common:actions.cancel")}
          </Button>
          <Button variant="outline" onClick={() => submit(true)()} disabled={save.isPending}>
            <FlaskConical /> {t("mcpDialog.saveAndTest")}
          </Button>
          <Button type="submit" form="mcp-form" disabled={save.isPending}>
            {save.isPending ? <Spinner /> : <Save />} {editing ? t("mcpDialog.saveChanges") : t("mcpDialog.addServer")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
