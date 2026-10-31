import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { ChevronRight, ExternalLink, FlaskConical, Save, ShieldCheck, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ApiTool, ApiToolAuth, ApiToolInput, ApiToolTestResult } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { PasswordInput } from "@/components/vault/password-input";
import { isGrantCancelled, withGrant } from "@/components/vault/grant";
import { toastApiError } from "@/components/vault/vault-utils";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/language";
import { api } from "@/lib/api";
import { openExternal } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { BEARER, ENV_VAR_PATTERN, HEADER_PATTERN, SECRET_NAME_PATTERN, suggestEnvVar, toolIcon, type ApiToolPreset } from "./api-tool-presets";
import { ScopePicker, useDefaultScope, type IntegrationScope } from "./scope-picker";

type KeyMode = "bearer" | "header" | "query";

interface FormState {
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
  scope: IntegrationScope;
}

function modeOf(auth: ApiToolAuth): KeyMode {
  if (auth.in === "query") return "query";
  return auth.name.toLowerCase() === "authorization" && auth.prefix === BEARER.prefix ? "bearer" : "header";
}

function fromTool(t: ApiTool): FormState {
  const mode = modeOf(t.auth);
  return {
    name: t.name,
    description: t.description,
    apiKey: "",
    removeKey: false,
    baseUrl: t.baseUrl,
    keyMode: mode,
    headerName: t.auth.in === "header" && mode === "header" ? t.auth.name : "x-api-key",
    prefix: t.auth.in === "header" && mode === "header" ? t.auth.prefix : "",
    queryName: t.auth.in === "query" ? t.auth.name : "key",
    docs: t.docs,
    docsUrl: t.docsUrl,
    testPath: t.testPath,
    envOn: !!t.envVar,
    envVar: t.envVar ?? suggestEnvVar(t.name),
    scope: { workspaceId: t.workspaceId, agentId: t.agentId },
  };
}

function fromPreset(p: ApiToolPreset | null, scope: IntegrationScope): FormState {
  const mode = p ? modeOf(p.auth) : "bearer";
  return {
    name: p?.name ?? "",
    description: p ? t(p.description, { ns: "integrations" }) : "",
    apiKey: "",
    removeKey: false,
    baseUrl: p?.baseUrl ?? "",
    keyMode: mode,
    headerName: p && mode === "header" ? p.auth.name : "x-api-key",
    prefix: p && mode === "header" ? p.auth.prefix : "",
    queryName: p?.auth.in === "query" ? p.auth.name : "key",
    docs: p?.docs ?? "",
    docsUrl: p?.docsUrl ?? "",
    testPath: p?.testPath ?? "",
    envOn: false,
    envVar: p?.envVar ?? "",
    scope,
  };
}

function authOf(f: FormState): ApiToolAuth {
  if (f.keyMode === "bearer") return BEARER;
  if (f.keyMode === "query") return { in: "query", name: f.queryName.trim(), prefix: "" };
  return { in: "header", name: f.headerName.trim(), prefix: f.prefix };
}

type Field = "name" | "apiKey" | "baseUrl" | "headerName" | "queryName" | "envVar" | "docsUrl" | "testPath";

function validate(f: FormState): Partial<Record<Field, string>> {
  const errors: Partial<Record<Field, string>> = {};
  if (!f.name.trim()) errors.name = t("integrations:apiToolDialog.errors.name");
  if (f.apiKey.trim() && (f.apiKey.trim().length < 8 || /\s/.test(f.apiKey.trim()))) errors.apiKey = t("integrations:apiToolDialog.errors.apiKey");
  if (f.baseUrl.trim()) {
    try {
      const u = new URL(f.baseUrl.trim());
      if (u.protocol !== "https:" && u.protocol !== "http:") errors.baseUrl = t("integrations:apiToolDialog.errors.baseUrlProtocol");
      else if (u.search || u.hash) errors.baseUrl = t("integrations:apiToolDialog.errors.baseUrlQuery");
    } catch {
      errors.baseUrl = t("integrations:apiToolDialog.errors.baseUrlInvalid");
    }
  } else if (!f.envOn) errors.baseUrl = t("integrations:apiToolDialog.errors.baseUrlMissing");
  if (f.keyMode === "header" && !HEADER_PATTERN.test(f.headerName.trim())) errors.headerName = t("integrations:apiToolDialog.errors.headerName");
  if (f.keyMode === "query" && !/^[A-Za-z0-9_.~[\]-]+$/.test(f.queryName.trim())) errors.queryName = t("integrations:apiToolDialog.errors.queryName");
  if (f.envOn && (!ENV_VAR_PATTERN.test(f.envVar.trim()) || !SECRET_NAME_PATTERN.test(f.envVar.trim()))) {
    errors.envVar = t("integrations:apiToolDialog.errors.envVar");
  }
  if (f.docsUrl.trim()) {
    try {
      new URL(f.docsUrl.trim());
    } catch {
      errors.docsUrl = t("integrations:apiToolDialog.errors.docsUrl");
    }
  }
  if (f.testPath.trim() && !f.baseUrl.trim()) errors.testPath = t("integrations:apiToolDialog.errors.testPath");
  return errors;
}

export type ApiToolDialogState = { mode: "create"; preset: ApiToolPreset | null; scope?: IntegrationScope } | { mode: "edit"; tool: ApiTool } | null;

/** Add / edit an API tool. The key is write-only: it's never loaded back into the form. */
export function ApiToolDialog({
  state,
  onOpenChange,
  onTested,
}: {
  state: ApiToolDialogState;
  onOpenChange: (open: boolean) => void;
  onTested?: (tool: ApiTool, result: ApiToolTestResult) => void;
}) {
  const { t } = useTranslation(["integrations", "common"]);
  const { intlLocale } = useLocale();
  const qc = useQueryClient();
  const defaultScope = useDefaultScope();
  const [form, setForm] = useState<FormState>(() => fromPreset(null, defaultScope));
  const [touched, setTouched] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [target, setTarget] = useState<ApiToolDialogState>(null);
  if (state && state !== target) {
    setTarget(state);
    setTouched(false);
    const next = state.mode === "edit" ? fromTool(state.tool) : fromPreset(state.preset, state.scope ?? defaultScope);
    setForm(next);
    setAdvanced(next.envOn || (state.mode === "edit" && !!state.tool.testPath && !state.tool.preset));
  }
  const editing = target?.mode === "edit" ? target.tool : null;
  const preset = target?.mode === "create" ? target.preset : null;
  const Icon = toolIcon(editing?.preset ?? preset?.id);
  const keySaved = !!editing?.hasKey && !form.removeKey;

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const errors = validate(form);
  const err = (k: Field) => (touched ? errors[k] : undefined);

  const save = useMutation({
    mutationFn: async ({ test }: { test: boolean }) => {
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
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : form.removeKey ? { apiKey: "" } : {}),
      };
      const tool = editing
        ? await withGrant((grant) => api.apiTools.update(editing.id, input, grant), t("apiToolDialog.grantReason"))
        : await api.apiTools.create({ ...input, preset: preset?.id ?? null });
      const result = test && tool.testPath ? await api.apiTools.test(tool.id) : null;
      return { tool, result };
    },
    onSuccess: ({ tool, result }) => {
      void qc.invalidateQueries({ queryKey: qk.apiTools });
      if (result) onTested?.(tool, result);
      if (!result || result.ok) {
        toast.success(editing ? t("mcpDialog.saved", { name: tool.name }) : t("mcpDialog.added", { name: tool.name }), {
          description: result ? t("apiToolDialog.keyWorks", { message: result.message }) : t("apiToolDialog.availableNext"),
        });
      } else toast.error(t("apiToolDialog.savedTestFailed", { name: tool.name }), { description: result.message });
      onOpenChange(false);
    },
    onError: (e) => !isGrantCancelled(e) && toastApiError(e, t("apiToolDialog.saveFailed"), qc),
  });

  const submit = (test: boolean) => (e?: FormEvent) => {
    e?.preventDefault();
    setTouched(true);
    if (Object.keys(errors).length) {
      if (errors.envVar || errors.testPath) setAdvanced(true);
      return;
    }
    save.mutate({ test });
  };

  const onNameBlur = () => {
    if (!form.envVar.trim() && form.name.trim()) set("envVar", suggestEnvVar(form.name));
  };

  const auth = authOf(form);
  const host = (() => {
    try {
      return form.baseUrl.trim() ? new URL(form.baseUrl.trim()).host : "";
    } catch {
      return "";
    }
  })();
  const insecure = form.baseUrl.trim().startsWith("http://");

  return (
    <Dialog open={!!state} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-2xl">
        <DialogHeader className="flex-row items-center gap-3.5 border-b px-6 py-5 text-left">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl border bg-card shadow-card">
            <Icon className="size-5" />
          </span>
          <div className="min-w-0">
            <DialogTitle>{editing ? t("mcpDialog.editTitle", { name: editing.name }) : preset ? t("mcpDialog.addNamed", { name: preset.name }) : t("apiToolDialog.addTitle")}</DialogTitle>
            <DialogDescription className="mt-0.5">{t("apiToolDialog.description")}</DialogDescription>
          </div>
        </DialogHeader>

        <form id="api-tool-form" onSubmit={submit(false)} className="space-y-7 px-6 py-6">
          <Group title={t("apiToolDialog.whatItIs")}>
            <div className="space-y-2">
              <Label htmlFor="tool-name">{t("common:words.name")}</Label>
              <Input id="tool-name" value={form.name} onChange={(e) => set("name", e.target.value)} onBlur={onNameBlur} placeholder={t("apiToolDialog.namePlaceholder")} aria-invalid={!!err("name")} autoComplete="off" />
              {err("name") && <p className="text-xs text-destructive">{err("name")}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="tool-desc">{t("apiToolDialog.useFor")}</Label>
              <Textarea
                id="tool-desc"
                value={form.description}
                onChange={(e) => set("description", e.target.value)}
                placeholder={t("apiToolDialog.useForPlaceholder")}
                className="min-h-16 resize-none"
                maxLength={2000}
              />
              <p className="text-xs text-muted-foreground">{t("apiToolDialog.useForHint")}</p>
            </div>
          </Group>

          <Group title={t("apiToolDialog.apiKey")}>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="tool-key">{t("apiToolDialog.key")}</Label>
                {preset && (
                  <button
                    type="button"
                    onClick={() => void openExternal(preset.keyUrl.href)}
                    className="inline-flex items-center gap-1 text-xs font-medium text-foreground underline decoration-foreground/25 underline-offset-[3px] hover:decoration-foreground"
                  >
                    {t("apiKeys.getKeyAt", { site: preset.keyUrl.label })} <ExternalLink className="size-3" />
                  </button>
                )}
              </div>
              <PasswordInput
                id="tool-key"
                value={form.apiKey}
                onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value, removeKey: false }))}
                placeholder={keySaved ? t("apiToolDialog.keySavedPlaceholder") : (preset?.keyPlaceholder ?? t("apiToolDialog.keyPlaceholder"))}
                aria-invalid={!!err("apiKey")}
              />
              {err("apiKey") && <p className="text-xs text-destructive">{err("apiKey")}</p>}
              <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                <ShieldCheck className="size-3.5 text-brand-strong" /> {t("apiToolDialog.encrypted")}
                {keySaved && !form.apiKey && (
                  <button type="button" onClick={() => set("removeKey", true)} className="font-medium text-foreground underline decoration-foreground/25 underline-offset-[3px] hover:decoration-destructive hover:text-destructive">
                    {t("composioKey.removeConfirm")}
                  </button>
                )}
                {editing?.hasKey && form.removeKey && (
                  <button type="button" onClick={() => set("removeKey", false)} className="font-medium text-destructive underline underline-offset-[3px]">
                    {t("apiToolDialog.keyWillBeRemoved")}
                  </button>
                )}
              </p>
            </div>
          </Group>

          <Group title={t("apiToolDialog.whereKeyGoes")}>
            <div className="space-y-2">
              <Label htmlFor="tool-url">{t("apiToolDialog.apiAddress")}</Label>
              <Input
                id="tool-url"
                value={form.baseUrl}
                onChange={(e) => set("baseUrl", e.target.value)}
                placeholder="https://api.example.com"
                className="font-mono text-[13px]"
                aria-invalid={!!err("baseUrl")}
                spellCheck={false}
                autoCapitalize="off"
              />
              {err("baseUrl") ? (
                <p className="text-xs text-destructive">{err("baseUrl")}</p>
              ) : insecure ? (
                <p className="flex items-center gap-1.5 text-xs text-warning">
                  <TriangleAlert className="size-3.5" /> {t("apiToolDialog.insecure")}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">{t("apiToolDialog.addressHint")}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label id="tool-auth-label">{t("apiToolDialog.sendAs")}</Label>
              <Segmented
                label="tool-auth-label"
                value={form.keyMode}
                onChange={(v) => set("keyMode", v)}
                options={[
                  { id: "bearer", label: t("apiToolDialog.bearer") },
                  { id: "header", label: t("mcpDialog.header") },
                  { id: "query", label: t("apiToolDialog.queryParam") },
                ]}
              />
              <AnimatePresence initial={false} mode="wait">
                {form.keyMode === "header" && (
                  <motion.div key="header" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                    <div className="grid gap-3 pt-1 sm:grid-cols-[1fr_9rem]">
                      <div className="space-y-1.5">
                        <Label htmlFor="tool-header" className="text-xs text-muted-foreground">
                          {t("apiToolDialog.headerName")}
                        </Label>
                        <Input id="tool-header" value={form.headerName} onChange={(e) => set("headerName", e.target.value)} className="font-mono text-[13px]" aria-invalid={!!err("headerName")} spellCheck={false} />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="tool-prefix" className="text-xs text-muted-foreground">
                          {t("apiToolDialog.prefix")}
                        </Label>
                        <Input id="tool-prefix" value={form.prefix} onChange={(e) => set("prefix", e.target.value)} placeholder="Token " className="font-mono text-[13px]" spellCheck={false} />
                      </div>
                    </div>
                    {err("headerName") && <p className="pt-1.5 text-xs text-destructive">{err("headerName")}</p>}
                  </motion.div>
                )}
                {form.keyMode === "query" && (
                  <motion.div key="query" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                    <div className="space-y-1.5 pt-1">
                      <Label htmlFor="tool-query" className="text-xs text-muted-foreground">
                        {t("apiToolDialog.paramName")}
                      </Label>
                      <Input id="tool-query" value={form.queryName} onChange={(e) => set("queryName", e.target.value)} className="font-mono text-[13px] sm:max-w-60" aria-invalid={!!err("queryName")} spellCheck={false} />
                      {err("queryName") && <p className="text-xs text-destructive">{err("queryName")}</p>}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
              <RequestPreview host={host} auth={auth} />
            </div>
          </Group>

          <Group
            title={t("apiToolDialog.howToUse")}
            aside={
              <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                {form.docs.length.toLocaleString(intlLocale)} / {(100_000).toLocaleString(intlLocale)}
              </span>
            }
          >
            <div className="space-y-2">
              <Label htmlFor="tool-docs" className="sr-only">
                {t("apiToolDialog.documentation")}
              </Label>
              <Textarea
                id="tool-docs"
                value={form.docs}
                onChange={(e) => set("docs", e.target.value)}
                placeholder={`${t("apiToolDialog.docsPlaceholder")}\n\nPOST /v1/images\n{ "prompt": "…", "size": "1024x1024" }`}
                className="max-h-80 min-h-40 font-mono text-[12.5px] leading-relaxed"
                maxLength={100_000}
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">{t("apiToolDialog.docsHint")}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="tool-docs-url">{t("apiToolDialog.docsLink")}</Label>
              <Input id="tool-docs-url" value={form.docsUrl} onChange={(e) => set("docsUrl", e.target.value)} placeholder="https://docs.example.com/api" className="font-mono text-[13px]" aria-invalid={!!err("docsUrl")} spellCheck={false} />
              {err("docsUrl") && <p className="text-xs text-destructive">{err("docsUrl")}</p>}
            </div>
          </Group>

          <Group title={t("mcpDialog.availableTo")}>
            <ScopePicker value={form.scope} onChange={(scope) => set("scope", scope)} />
          </Group>

          <Collapsible open={advanced} onOpenChange={setAdvanced}>
            <CollapsibleTrigger className="group flex w-full items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
              <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" /> {t("apiToolDialog.advanced")}
            </CollapsibleTrigger>
            <CollapsibleContent className="data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden">
              <div className="space-y-4 pt-4">
                <div className="rounded-lg border bg-paper-2 p-3.5">
                  <label className="flex cursor-pointer items-start justify-between gap-4">
                    <span>
                      <span className="block text-sm font-medium">{t("apiToolDialog.envTitle")}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">{t("apiToolDialog.envHint")}</span>
                    </span>
                    <Switch
                      checked={form.envOn}
                      onCheckedChange={(v) => setForm((f) => ({ ...f, envOn: v, envVar: f.envVar.trim() || suggestEnvVar(f.name) }))}
                      aria-label={t("mcpDialog.envVar")}
                      className="mt-0.5"
                    />
                  </label>
                  <AnimatePresence initial={false}>
                    {form.envOn && (
                      <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                        <div className="pt-3">
                          <Input
                            aria-label={t("apiToolDialog.variableName")}
                            value={form.envVar}
                            onChange={(e) => set("envVar", e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
                            className="bg-card font-mono text-[13px] sm:max-w-72"
                            aria-invalid={!!err("envVar")}
                            spellCheck={false}
                          />
                          {err("envVar") && <p className="pt-1.5 text-xs text-destructive">{err("envVar")}</p>}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="tool-test">{t("apiToolDialog.testRequest")}</Label>
                  <div className="flex items-center gap-2">
                    <span className="rounded-md border bg-paper-2 px-2 py-2 font-mono text-[11px] leading-none text-muted-foreground">GET</span>
                    <Input id="tool-test" value={form.testPath} onChange={(e) => set("testPath", e.target.value)} placeholder="/v1/models" className="font-mono text-[13px]" aria-invalid={!!err("testPath")} spellCheck={false} />
                  </div>
                  {err("testPath") ? (
                    <p className="text-xs text-destructive">{err("testPath")}</p>
                  ) : (
                    <p className="text-xs text-muted-foreground">{t("apiToolDialog.testHint")}</p>
                  )}
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </form>

        <DialogFooter className="sticky bottom-0 gap-2 border-t bg-card/95 px-6 py-4 backdrop-blur">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common:actions.cancel")}
          </Button>
          {form.testPath.trim() && form.baseUrl.trim() && (
            <Button variant="outline" onClick={() => submit(true)()} disabled={save.isPending}>
              <FlaskConical /> {t("mcpDialog.saveAndTest")}
            </Button>
          )}
          <Button type="submit" form="api-tool-form" disabled={save.isPending}>
            {save.isPending ? <Spinner /> : <Save />} {editing ? t("mcpDialog.saveChanges") : t("tools.addTool")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Group({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3.5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="eyebrow">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Segmented<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: { id: T; label: string }[] }) {
  return (
    <div role="radiogroup" aria-labelledby={label} className="grid grid-cols-3 gap-1 rounded-lg border bg-secondary p-0.5">
      {options.map((o) => {
        const active = value === o.id;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.id)}
            className={cn("relative h-8 rounded-md text-sm font-medium transition-colors", active ? "text-foreground" : "text-muted-foreground hover:text-foreground")}
          >
            {active && (
              <motion.span layoutId={`${label}-pill`} className="absolute inset-0 rounded-md bg-card shadow-card ring-1 ring-border dark:bg-accent" transition={{ type: "spring", stiffness: 420, damping: 34 }} />
            )}
            <span className="relative">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** What a request looks like on the wire, key masked. */
function RequestPreview({ host, auth }: { host: string; auth: ApiToolAuth }) {
  const where = host || "api.example.com";
  return (
    <div className="flex items-center gap-2 overflow-x-auto rounded-lg border border-dashed bg-paper-2/60 px-3 py-2 font-mono text-[11.5px] whitespace-nowrap text-muted-foreground">
      {auth.in === "query" ? (
        <span>
          {where}/…?<span className="text-foreground">{auth.name || "key"}</span>=<span className="text-brand-strong">••••••••</span>
        </span>
      ) : (
        <>
          <span>{where}</span>
          <span className="text-border">·</span>
          <span>
            <span className="text-foreground">{auth.name || "header"}</span>: {auth.prefix}
            <span className="text-brand-strong">••••••••</span>
          </span>
        </>
      )}
    </div>
  );
}
