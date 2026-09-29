import { useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "react-router";
import { motion, AnimatePresence } from "motion/react";
import {
  Bot,
  BrainCircuit,
  Eye,
  FolderOpen,
  Globe,
  KeyRound,
  MonitorUp,
  Plug,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
  TriangleAlert,
  UserRound,
  Users,
} from "lucide-react";
import type { Agent, AgentInput, ClaudeModel, Effort, SecretAccessMode, SubagentDefinition } from "@godmode/shared";
import { DEFAULT_MODEL, EFFORT_LABELS, EFFORT_OPTIONS, effortForModel, findModel } from "@godmode/shared";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useAllAgents, useBootstrap, useModelCatalog, useWorkspaces } from "@/lib/hooks";
import { isMac, modKey } from "@/lib/desktop";
import { useUi } from "@/stores/ui";
import { cn } from "@/lib/utils";
import { AgentAvatar, Kbd, Section } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { AvatarPicker, ColorSwatches } from "./avatar-picker";
import { MultiSelect } from "./multi-select";
import { useVaultGrant } from "@/components/vault/grant";
import { FolderPickerDialog, folderName, useShortPath } from "@/components/chat/folder-picker";
import { InheritedInstructions, useInheritedInstructions } from "@/components/instructions/instructions";

export interface AgentFormValues {
  name: string;
  avatar: string;
  color: string;
  description: string;
  instructions: string;
  workspaceId: string | null;
  model: string;
  effort: Effort | null;
  secretAccess: SecretAccessMode;
  allowDelegation: boolean;
  delegateTo: string[];
  canManageAgents: boolean;
  maxBudgetUsd: string;
  browserEnabled: boolean;
  browserProfileId: string | null;
  headless: boolean | null;
  /** Unattended computer use (no share in the chat needed). */
  computerEnabled: boolean;
  /** null = the entire desktop, else a display id. */
  computerDisplayId: string | null;
  inheritMcp: boolean;
  mcpServerIds: string[];
  subagents: SubagentDefinition[];
  workingDirectory: string | null;
}

/** Seed values for the form from an existing agent, a template, or nothing. */
export function agentToValues(
  source: Partial<Agent> | undefined,
  defaults: { workspaceId?: string | null; secretAccess?: SecretAccessMode } = {},
): AgentFormValues {
  return {
    name: source?.name ?? "",
    avatar: source?.avatar || "🤖",
    color: source?.color || "violet",
    description: source?.description ?? "",
    instructions: source?.instructions ?? "",
    workspaceId: source?.workspaceId !== undefined ? source.workspaceId : (defaults.workspaceId ?? null),
    model: source?.model ?? "",
    effort: source?.effort ?? null,
    secretAccess: source?.permissions?.secretAccess ?? defaults.secretAccess ?? "fill",
    allowDelegation: source?.permissions?.allowDelegation ?? true,
    delegateTo: source?.permissions?.delegateTo ?? [],
    canManageAgents: source?.permissions?.canManageAgents ?? false,
    maxBudgetUsd: source?.permissions?.maxBudgetUsd != null ? String(source.permissions.maxBudgetUsd) : "",
    browserEnabled: source?.browser?.enabled ?? true,
    browserProfileId: source?.browser?.profileId ?? null,
    headless: source?.browser?.headless ?? null,
    computerEnabled: source?.computer?.enabled ?? false,
    computerDisplayId: source?.computer?.target?.kind === "display" ? source.computer.target.displayId : null,
    inheritMcp: source?.inheritMcp ?? true,
    mcpServerIds: source?.mcpServerIds ?? [],
    subagents: source?.subagents ?? [],
    workingDirectory: source?.workingDirectory ?? null,
  };
}

export function valuesToInput(v: AgentFormValues): AgentInput {
  const budget = v.maxBudgetUsd.trim() ? Number(v.maxBudgetUsd) : null;
  return {
    workspaceId: v.workspaceId,
    name: v.name.trim(),
    avatar: v.avatar,
    color: v.color,
    description: v.description.trim(),
    instructions: v.instructions,
    model: v.model,
    effort: v.effort,
    permissions: {
      secretAccess: v.secretAccess,
      allowDelegation: v.allowDelegation,
      delegateTo: v.allowDelegation ? v.delegateTo : [],
      canManageAgents: v.canManageAgents,
      maxBudgetUsd: budget != null && Number.isFinite(budget) && budget > 0 ? budget : null,
    },
    browser: { enabled: v.browserEnabled, profileId: v.browserProfileId, headless: v.headless },
    computer: { enabled: v.computerEnabled, target: v.computerDisplayId ? { kind: "display", displayId: v.computerDisplayId } : null },
    inheritMcp: v.inheritMcp,
    mcpServerIds: v.mcpServerIds,
    subagents: v.subagents
      .map((s) => ({ ...s, name: slugify(s.name), description: s.description.trim(), prompt: s.prompt, model: s.model || undefined }))
      .filter((s) => s.name),
    workingDirectory: v.workingDirectory,
  };
}

function slugify(s: string) {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function validate(v: AgentFormValues): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!v.name.trim()) errors.name = "Give your agent a name";
  if (v.maxBudgetUsd.trim()) {
    const n = Number(v.maxBudgetUsd);
    if (!Number.isFinite(n) || n <= 0) errors.maxBudgetUsd = "Enter a positive amount, or leave empty for no limit";
  }
  const names = new Set<string>();
  v.subagents.forEach((s, i) => {
    const n = slugify(s.name);
    if (!n) errors[`subagent-${i}`] = "Subagents need a name";
    else if (names.has(n)) errors[`subagent-${i}`] = "Subagent names must be unique";
    else if (!s.prompt.trim()) errors[`subagent-${i}`] = "Tell the subagent what it does";
    names.add(n);
  });
  return errors;
}

function ModelOptions({ models, current }: { models: ClaudeModel[]; current?: string }) {
  const older = models.filter((m) => !m.latest);
  return (
    <>
      {models
        .filter((m) => m.latest)
        .map((m) => (
          <SelectItem key={m.id} value={m.id}>
            <span>{m.label}</span>
            {m.description && <span className="text-xs text-muted-foreground">{m.description}</span>}
          </SelectItem>
        ))}
      {older.length > 0 && (
        <SelectGroup>
          <SelectLabel>Older models</SelectLabel>
          {older.map((m) => (
            <SelectItem key={m.id} value={m.id}>
              {m.label}
            </SelectItem>
          ))}
        </SelectGroup>
      )}
      {current && !findModel(models, current) && <SelectItem value={current}>{current}</SelectItem>}
    </>
  );
}

const SECTIONS = [
  { id: "identity", label: "Identity" },
  { id: "instructions", label: "Instructions" },
  { id: "brain", label: "Model" },
  { id: "folder", label: "Folder" },
  { id: "permissions", label: "Permissions" },
  { id: "browser", label: "Browser" },
  { id: "computer", label: "Computer" },
  { id: "tools", label: "Tools" },
  { id: "subagents", label: "Subagents" },
];

export function AgentForm({
  initial,
  agentId,
  isDefault = false,
  mode,
  submitLabel,
  pending,
  onSubmit,
  onCancel,
  footerExtra,
}: {
  initial?: Partial<Agent>;
  agentId?: string;
  isDefault?: boolean;
  mode: "create" | "edit";
  submitLabel: string;
  pending?: boolean;
  onSubmit: (input: AgentInput) => void;
  onCancel?: () => void;
  /** Rendered above the submit bar (e.g. template routine opt-in). */
  footerExtra?: ReactNode;
}) {
  const { data: boot } = useBootstrap();
  const { catalog } = useModelCatalog();
  const scope = useUi((s) => s.workspace);
  const defaults = useMemo(
    () => ({
      workspaceId: scope !== "all" && scope !== "global" ? scope : null,
      secretAccess: boot?.settings.security.defaultSecretAccess ?? ("fill" as const),
    }),
    [scope, boot?.settings.security.defaultSecretAccess],
  );
  const seed = useMemo(() => agentToValues(initial, defaults), [initial, defaults]);
  const seedKey = JSON.stringify(seed);
  const [values, setValues] = useState<AgentFormValues>(seed);
  const [baseline, setBaseline] = useState(seedKey);
  const [showErrors, setShowErrors] = useState(false);
  const dirty = JSON.stringify(values) !== baseline;
  const effectiveModel = findModel(catalog.models, values.model || boot?.settings.runner.model || DEFAULT_MODEL);
  const efforts: readonly Effort[] = effectiveModel?.efforts ?? EFFORT_OPTIONS;

  // Pick up external changes (realtime updates) while the user hasn't edited anything
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (!dirtyRef.current) {
      setValues(JSON.parse(seedKey) as AgentFormValues);
      setBaseline(seedKey);
    }
  }, [seedKey]);

  const errors = validate(values);
  const hasErrors = Object.keys(errors).length > 0;
  const set = <K extends keyof AgentFormValues>(key: K, value: AgentFormValues[K]) => setValues((v) => ({ ...v, [key]: value }));
  const ensureGrant = useVaultGrant();

  // Letting the AI read secrets needs the vault passphrase (the core checks it again on save).
  const chooseSecretAccess = async (mode: SecretAccessMode) => {
    if (mode === "reveal" && seed.secretAccess !== "reveal") {
      try {
        await ensureGrant();
      } catch {
        return;
      }
    }
    set("secretAccess", mode);
  };

  const submit = () => {
    if (hasErrors) {
      setShowErrors(true);
      const first = Object.keys(errors)[0];
      document.getElementById(first === "name" ? "agent-name" : first.startsWith("subagent") ? "subagents-list" : "agent-budget")?.focus();
      return;
    }
    onSubmit(valuesToInput(values));
  };

  // Save shortcut
  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        submitRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const err = (k: string) => (showErrors ? errors[k] : undefined);
  const preview = { id: agentId, avatar: values.avatar, color: values.color };
  const inherited = useInheritedInstructions(
    { id: agentId ?? "", name: values.name, avatar: values.avatar, color: values.color, instructions: "", workspaceId: values.workspaceId },
    { includeAgent: false },
  );

  const { hash } = useLocation();
  useEffect(() => {
    const id = hash.slice(1);
    if (SECTIONS.some((s) => s.id === id)) requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start" }));
  }, [hash]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="relative"
      noValidate
    >
      <div className="grid grid-cols-1 gap-6 @5xl:grid-cols-[minmax(0,1fr)_240px]">
        <div className="min-w-0 space-y-5">
          <FormSection id="identity" title="Identity" description="How this agent shows up across Godmode.">
            <div className="flex flex-col gap-5 @lg:flex-row @lg:items-start">
              <div className="flex flex-col items-center gap-3">
                <AvatarPicker id="agent-avatar" avatar={values.avatar} color={values.color} onChange={(v) => set("avatar", v)} />
              </div>
              <div className="min-w-0 flex-1 space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="agent-name">Name</Label>
                  <Input
                    id="agent-name"
                    value={values.name}
                    onChange={(e) => set("name", e.target.value)}
                    placeholder="e.g. Invoice Hunter"
                    aria-invalid={!!err("name")}
                    maxLength={60}
                    autoFocus={mode === "create"}
                  />
                  {err("name") && <p className="text-xs text-destructive">{err("name")}</p>}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="agent-description">Short description</Label>
                  <Input
                    id="agent-description"
                    value={values.description}
                    onChange={(e) => set("description", e.target.value)}
                    placeholder="Downloads my invoices every month and files them"
                    maxLength={160}
                  />
                </div>
                <div className="space-y-1.5">
                  <span className="text-sm font-medium">Color</span>
                  <ColorSwatches value={values.color} onChange={(c) => set("color", c)} />
                </div>
              </div>
            </div>
          </FormSection>

          <FormSection
            id="instructions"
            title="Instructions"
            description="Standing orders: its role, how it should work, what to always or never do. Goes into the agent's CLAUDE.md."
          >
            <Textarea
              id="agent-instructions"
              value={values.instructions}
              onChange={(e) => set("instructions", e.target.value)}
              placeholder={
                "You are my finance assistant.\n\n- Log into the vendor portals I use and download new invoices as PDF.\n- Save them to workspace/invoices/YYYY-MM/.\n- Summarize totals at the end and tell me about anything unusual.\n- Never pay anything without asking me first."
              }
              aria-label="Instructions"
              className="min-h-64 resize-y text-[14px] leading-relaxed"
            />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Sparkles className="size-3.5" />
                Tip: be specific about goals, where to save files and when to ask you. The agent keeps its own learnings in MEMORY.md.
              </span>
              <span className="tabular-nums">{values.instructions.length.toLocaleString()} chars</span>
            </div>
            {inherited.length > 0 && (
              <div className="mt-4 rounded-lg border bg-paper-2 p-1.5">
                <p className="px-2 pt-1 pb-0.5 text-[11px] font-medium text-muted-foreground">Also given to this agent on every run</p>
                <InheritedInstructions layers={inherited} />
              </div>
            )}
          </FormSection>

          <FormSection id="brain" title="Model & workspace" description="Which Claude model powers it, how hard it thinks, and where it lives.">
            <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="agent-model">Model</Label>
                <Select
                  value={findModel(catalog.models, values.model)?.id ?? (values.model || "__default")}
                  onValueChange={(v) => set("model", v === "__default" ? "" : v)}
                >
                  <SelectTrigger id="agent-model" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    <SelectItem value="__default">Default (from settings)</SelectItem>
                    <SelectSeparator />
                    <ModelOptions models={catalog.models} current={values.model} />
                  </SelectContent>
                </Select>
              </div>
              <WorkspaceField value={values.workspaceId} onChange={(v) => set("workspaceId", v)} disabled={isDefault} />
            </div>
            <div className="mt-4 space-y-1.5">
              <span id="agent-effort-label" className="flex items-center gap-1.5 text-sm font-medium">
                <BrainCircuit className="size-4 text-muted-foreground" /> Reasoning effort
              </span>
              <ToggleGroup
                type="single"
                variant="outline"
                value={(values.effort && effortForModel(efforts, values.effort)) || "default"}
                onValueChange={(v) => v && set("effort", v === "default" ? null : (v as Effort))}
                aria-labelledby="agent-effort-label"
                className="w-full flex-wrap @xl:flex-nowrap"
              >
                <ToggleGroupItem value="default" className="flex-1 data-[state=on]:bg-secondary data-[state=on]:text-foreground data-[state=on]:ring-1 data-[state=on]:ring-foreground/15 data-[state=on]:ring-inset">
                  Default
                </ToggleGroupItem>
                {efforts.map((e) => (
                  <ToggleGroupItem key={e} value={e} className="flex-1 data-[state=on]:bg-secondary data-[state=on]:text-foreground data-[state=on]:ring-1 data-[state=on]:ring-foreground/15 data-[state=on]:ring-inset">
                    {EFFORT_LABELS[e]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <p className="text-xs text-muted-foreground">
                {efforts.length
                  ? "Higher effort thinks longer — better for tricky multi-step work, slower and pricier."
                  : `${effectiveModel?.label ?? "This model"} doesn't use effort levels.`}
              </p>
            </div>
          </FormSection>

          <FormSection
            id="folder"
            title="Working folder"
            description="Optional. Its chats and routines run inside this folder and can read and edit the files there. Memory stays in the agent's own repository."
          >
            <FolderField value={values.workingDirectory} onChange={(v) => set("workingDirectory", v)} />
          </FormSection>

          <FormSection id="permissions" title="Permissions" description="What this agent is allowed to do on your behalf.">
            <div className="space-y-5">
              <div className="space-y-2">
                <span id="secret-access-label" className="flex items-center gap-1.5 text-sm font-medium">
                  <KeyRound className="size-4 text-muted-foreground" /> Passwords & 2FA codes
                </span>
                <RadioGroup
                  value={values.secretAccess}
                  onValueChange={(v) => void chooseSecretAccess(v as SecretAccessMode)}
                  aria-labelledby="secret-access-label"
                  className="grid grid-cols-1 gap-3 @xl:grid-cols-2"
                >
                  <RadioCard
                    value="fill"
                    current={values.secretAccess}
                    icon={<ShieldCheck className="size-4 text-success" />}
                    title="Fill into browser"
                    badge="Recommended"
                    description="Godmode types secrets straight into the page. The AI never sees them."
                  />
                  <RadioCard
                    value="reveal"
                    current={values.secretAccess}
                    icon={<Eye className="size-4 text-warning" />}
                    title="Reveal to AI"
                    description="The model can read raw passwords and codes (needed for API-only tools). Every reveal is audited."
                  />
                </RadioGroup>
                <AnimatePresence>
                  {values.secretAccess === "reveal" && (
                    <motion.p
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      className="flex items-center gap-1.5 overflow-hidden text-xs text-warning"
                    >
                      <TriangleAlert className="size-3.5 shrink-0" /> Secrets may appear in the model's context. Only use this for agents you trust.
                    </motion.p>
                  )}
                </AnimatePresence>
              </div>

              <ToggleRow
                id="agent-delegation"
                icon={<Users className="size-4" />}
                title="Can delegate to other agents"
                description="Hand sub-tasks to peer agents and use their results."
                checked={values.allowDelegation}
                onChange={(v) => set("allowDelegation", v)}
              />
              <AnimatePresence initial={false}>
                {values.allowDelegation && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden"
                  >
                    <DelegateField agentId={agentId} value={values.delegateTo} onChange={(v) => set("delegateTo", v)} />
                  </motion.div>
                )}
              </AnimatePresence>

              <ToggleRow
                id="agent-manage"
                icon={<Bot className="size-4" />}
                title="Can manage agents & routines"
                description="Create, change and delete agents and schedules — like the built-in Godmode orchestrator."
                checked={values.canManageAgents}
                onChange={(v) => set("canManageAgents", v)}
              />

              <div className="grid gap-1.5 @md:max-w-xs">
                <Label htmlFor="agent-budget">Max budget per run</Label>
                <div className="relative">
                  <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                  <Input
                    id="agent-budget"
                    inputMode="decimal"
                    value={values.maxBudgetUsd}
                    onChange={(e) => set("maxBudgetUsd", e.target.value.replace(",", "."))}
                    placeholder="No limit"
                    aria-invalid={!!err("maxBudgetUsd")}
                    className="pl-7"
                  />
                </div>
                {err("maxBudgetUsd") ? (
                  <p className="text-xs text-destructive">{err("maxBudgetUsd")}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">A run stops when it would cost more than this.</p>
                )}
              </div>
            </div>
          </FormSection>

          <FormSection id="browser" title="Browser" description="A real Chromium the agent drives to use websites for you.">
            <div className="space-y-5">
              <ToggleRow
                id="agent-browser"
                icon={<Globe className="size-4" />}
                title="Browser access"
                description="Navigate, click, type and read web pages."
                checked={values.browserEnabled}
                onChange={(v) => set("browserEnabled", v)}
              />
              <div className={cn("grid grid-cols-1 gap-4 @xl:grid-cols-2", !values.browserEnabled && "pointer-events-none opacity-50")}>
                <BrowserProfileField value={values.browserProfileId} onChange={(v) => set("browserProfileId", v)} disabled={!values.browserEnabled} />
                <div className="space-y-1.5">
                  <span id="agent-headless-label" className="text-sm font-medium">
                    Window
                  </span>
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    value={values.headless === null ? "default" : values.headless ? "headless" : "visible"}
                    onValueChange={(v) => v && set("headless", v === "default" ? null : v === "headless")}
                    aria-labelledby="agent-headless-label"
                    disabled={!values.browserEnabled}
                    className="w-full"
                  >
                    <ToggleGroupItem value="default" className="flex-1 data-[state=on]:bg-secondary data-[state=on]:text-foreground data-[state=on]:ring-1 data-[state=on]:ring-foreground/15 data-[state=on]:ring-inset">
                      Default
                    </ToggleGroupItem>
                    <ToggleGroupItem value="visible" className="flex-1 data-[state=on]:bg-secondary data-[state=on]:text-foreground data-[state=on]:ring-1 data-[state=on]:ring-foreground/15 data-[state=on]:ring-inset">
                      Visible
                    </ToggleGroupItem>
                    <ToggleGroupItem value="headless" className="flex-1 data-[state=on]:bg-secondary data-[state=on]:text-foreground data-[state=on]:ring-1 data-[state=on]:ring-foreground/15 data-[state=on]:ring-inset">
                      Headless
                    </ToggleGroupItem>
                  </ToggleGroup>
                </div>
              </div>
            </div>
          </FormSection>

          <FormSection
            id="computer"
            title="Computer"
            description="In chats you share a window or screen yourself. Here you can let this agent use the computer on its own — for routines and delegated tasks."
          >
            <div className="space-y-5">
              <ToggleRow
                id="agent-computer"
                icon={<MonitorUp className="size-4" />}
                title="Use the computer without a share"
                description="Controls the real mouse and keyboard when it runs on its own. Only turn this on for agents you trust with your desktop."
                checked={values.computerEnabled}
                onChange={(v) => set("computerEnabled", v)}
              />
              <ComputerDisplayField value={values.computerDisplayId} onChange={(v) => set("computerDisplayId", v)} disabled={!values.computerEnabled} />
            </div>
          </FormSection>

          <FormSection id="tools" title="Tools & integrations" description="MCP servers and connected apps this agent can use.">
            <div className="space-y-5">
              <ToggleRow
                id="agent-inherit-mcp"
                icon={<Plug className="size-4" />}
                title="Inherit shared integrations"
                description="Also use the global and workspace MCP servers and Composio apps."
                checked={values.inheritMcp}
                onChange={(v) => set("inheritMcp", v)}
              />
              <McpField agentId={agentId} value={values.mcpServerIds} onChange={(v) => set("mcpServerIds", v)} />
            </div>
          </FormSection>

          <FormSection
            id="subagents"
            title="Subagents"
            description="Specialists this agent can spin up for focused sub-tasks within a run."
            actions={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => set("subagents", [...values.subagents, { name: "", description: "", prompt: "" }])}
              >
                <Plus /> Add subagent
              </Button>
            }
          >
            <SubagentsEditor
              value={values.subagents}
              onChange={(v) => set("subagents", v)}
              errors={showErrors ? errors : {}}
            />
          </FormSection>
        </div>

        {/* Sticky preview + section nav on wide screens */}
        <aside className="hidden @5xl:block">
          <div className="sticky top-6 space-y-4">
            <div className="rounded-xl border bg-card p-4 shadow-card">
              <div className="eyebrow mb-3">Preview</div>
              <div className="flex items-center gap-3">
                <AgentAvatar agent={preview} size="lg" />
                <div className="min-w-0">
                  <div className="truncate font-medium tracking-[-0.01em]">{values.name || "Unnamed agent"}</div>
                  <div className="line-clamp-2 text-xs text-muted-foreground">{values.description || "No description yet"}</div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                <span className="rounded-[5px] border bg-secondary px-1.5 py-0.5">{findModel(catalog.models, values.model)?.label ?? (values.model || "Default model")}</span>
                {values.browserEnabled && <span className="rounded-[5px] border bg-secondary px-1.5 py-0.5">Browser</span>}
                {values.computerEnabled && <span className="rounded-[5px] border bg-secondary px-1.5 py-0.5">Computer</span>}
                {values.workingDirectory && (
                  <span className="flex max-w-full items-center gap-1 rounded-[5px] border bg-secondary px-1.5 py-0.5">
                    <FolderOpen className="size-3 shrink-0" />
                    <span className="truncate">{folderName(values.workingDirectory)}</span>
                  </span>
                )}
                <span className="rounded-[5px] border bg-secondary px-1.5 py-0.5">{values.secretAccess === "fill" ? "Fill-only secrets" : "Reveals secrets"}</span>
              </div>
            </div>
            <nav aria-label="Form sections" className="space-y-0.5">
              {SECTIONS.map((s) => (
                <a
                  key={s.id}
                  href={`#${s.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                  className="block rounded-md px-3 py-1.5 text-sm text-muted-foreground transition hover:bg-accent hover:text-foreground"
                >
                  {s.label}
                </a>
              ))}
            </nav>
          </div>
        </aside>
      </div>

      {/* Submit bar */}
      <div className="sticky bottom-0 z-10 mt-6 -mx-2 px-2 pb-4">
        <div className="glass flex flex-wrap items-center gap-3 rounded-xl px-4 py-3">
          <div className="min-w-0 flex-1">
            {footerExtra ?? (
              <span className="text-sm text-muted-foreground">
                {mode === "edit" ? (dirty ? "You have unsaved changes" : "All changes saved") : "You can change everything later."}
              </span>
            )}
          </div>
          <span className="hidden items-center gap-1 text-xs text-muted-foreground @2xl:flex">
            <Kbd>{modKey}S</Kbd>
          </span>
          {onCancel && (
            <Button type="button" variant="ghost" onClick={onCancel}>
              {mode === "edit" && dirty ? "Discard" : "Cancel"}
            </Button>
          )}
          {mode === "edit" && dirty && !onCancel && (
            <Button type="button" variant="ghost" onClick={() => setValues(JSON.parse(baseline) as AgentFormValues)}>
              Discard
            </Button>
          )}
          <Button
            type="submit"
            disabled={pending || (mode === "edit" && !dirty)}
          >
            {pending && <Spinner />}
            {submitLabel}
          </Button>
        </div>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */

function FormSection({ id, ...props }: { id: string } & ComponentProps<typeof Section>) {
  return (
    <div id={id} className="scroll-mt-6">
      <Section {...props} />
    </div>
  );
}

function ToggleRow({
  id,
  icon,
  title,
  description,
  checked,
  onChange,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border bg-card text-foreground shadow-card">{icon}</div>
      <div className="min-w-0 flex-1">
        <Label htmlFor={id} className="cursor-pointer">
          {title}
        </Label>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} className="mt-1" />
    </div>
  );
}

function RadioCard({
  value,
  current,
  icon,
  title,
  badge,
  description,
}: {
  value: string;
  current: string;
  icon: ReactNode;
  title: string;
  badge?: string;
  description: string;
}) {
  const id = `radio-${value}`;
  return (
    <Label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-lg border bg-card p-3.5 font-normal shadow-card transition hover:border-foreground/15",
        current === value && "border-foreground/30 ring-1 ring-foreground/10",
      )}
    >
      <RadioGroupItem id={id} value={value} className="mt-0.5" />
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          {icon}
          {title}
          {badge && <span className="rounded-[5px] border border-brand/25 bg-brand-soft px-1.5 py-px text-[10px] font-medium text-brand-strong">{badge}</span>}
        </span>
        <span className="block text-xs leading-relaxed text-muted-foreground">{description}</span>
      </span>
    </Label>
  );
}

function FolderField({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const short = useShortPath();
  return (
    <>
      {value ? (
        <div className="flex items-center gap-3 rounded-lg border bg-paper-2 p-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-md border bg-card text-muted-foreground">
            <FolderOpen className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{folderName(value)}</div>
            <div className="truncate font-mono text-xs text-muted-foreground" title={value}>
              {short(value)}
            </div>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
            Change
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Remove folder"
            onClick={() => onChange(null)}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 />
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed px-4 py-4">
          <FolderOpen className="size-5 shrink-0 text-muted-foreground" />
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">No folder — the agent works in its own repository. A single chat can still pick a folder.</p>
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
            Choose folder…
          </Button>
        </div>
      )}
      <FolderPickerDialog
        open={open}
        onOpenChange={setOpen}
        value={value}
        onPick={onChange}
        title="Default folder"
        description="New chats and routines of this agent run inside this folder. Each chat can still switch to another one."
      />
    </>
  );
}

function WorkspaceField({ value, onChange, disabled }: { value: string | null; onChange: (v: string | null) => void; disabled?: boolean }) {
  const { data: workspaces = [] } = useWorkspaces();
  return (
    <div className="space-y-1.5">
      <Label htmlFor="agent-workspace">Workspace</Label>
      <Select value={value ?? "__global"} onValueChange={(v) => onChange(v === "__global" ? null : v)} disabled={disabled}>
        <SelectTrigger id="agent-workspace" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value="__global">🌐 Global — sees only global logins & tools</SelectItem>
          {workspaces.length > 0 && <SelectSeparator />}
          {workspaces.map((w) => (
            <SelectItem key={w.id} value={w.id}>
              {w.icon} {w.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function DelegateField({ agentId, value, onChange }: { agentId?: string; value: string[]; onChange: (v: string[]) => void }) {
  const { data: agents = [] } = useAllAgents();
  const options = agents
    .filter((a) => a.id !== agentId)
    .map((a) => ({ value: a.id, label: a.name, icon: <span className="text-sm">{a.avatar}</span>, hint: a.description }));
  return (
    <div className="space-y-1.5 pl-11">
      <Label htmlFor="agent-delegate-to" className="text-xs text-muted-foreground">
        Allowed peers <span className="font-normal">(empty = any agent it can see)</span>
      </Label>
      <MultiSelect
        id="agent-delegate-to"
        options={options}
        value={value}
        onChange={onChange}
        placeholder="Any agent"
        emptyText="No other agents yet."
      />
    </div>
  );
}

function ComputerDisplayField({ value, onChange, disabled }: { value: string | null; onChange: (v: string | null) => void; disabled?: boolean }) {
  const { data } = useQuery({ queryKey: qk.computerSources, queryFn: api.computer.sources, enabled: !disabled, staleTime: 30_000, retry: false });
  const displays = data?.displays ?? [];
  const known = value === null || displays.some((d) => d.id === value);
  return (
    <div className={cn("space-y-1.5 sm:max-w-sm", disabled && "pointer-events-none opacity-50")}>
      <Label htmlFor="agent-computer-display">Screen</Label>
      <Select value={value ?? "desktop"} onValueChange={(v) => onChange(v === "desktop" ? null : v)} disabled={disabled}>
        <SelectTrigger id="agent-computer-display" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="desktop">Entire desktop{displays.length > 1 ? ` (${displays.length} displays)` : ""}</SelectItem>
          {displays.map((d) => (
            <SelectItem key={d.id} value={d.id}>
              {d.name}
              {d.primary ? " (primary)" : ""}
            </SelectItem>
          ))}
          {!known && value && <SelectItem value={value}>Display {value} (not connected)</SelectItem>}
        </SelectContent>
      </Select>
    </div>
  );
}

function BrowserProfileField({ value, onChange, disabled }: { value: string | null; onChange: (v: string | null) => void; disabled?: boolean }) {
  const { data: profiles = [], isLoading } = useQuery({ queryKey: [...qk.browserProfiles, "list"], queryFn: api.browser.profiles });
  return (
    <div className="space-y-1.5">
      <Label htmlFor="agent-browser-profile">Profile</Label>
      <Select value={value ?? "__default"} onValueChange={(v) => onChange(v === "__default" ? null : v)} disabled={disabled || isLoading}>
        <SelectTrigger id="agent-browser-profile" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value="__default">Default profile (workspace / global)</SelectItem>
          {profiles.length > 0 && <SelectSeparator />}
          {profiles.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
              {p.isDefault && <span className="text-xs text-muted-foreground">default</span>}
              {p.cookieCount > 0 && <span className="text-xs text-muted-foreground">{p.cookieCount} cookies</span>}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function McpField({ agentId, value, onChange }: { agentId?: string; value: string[]; onChange: (v: string[]) => void }) {
  const { data: servers = [] } = useQuery({
    queryKey: [...qk.mcpServers, "list", "all"],
    queryFn: () => api.mcpServers.list({ workspaceId: "all" }),
  });
  const options = servers
    .filter((s) => !s.agentId || s.agentId === agentId)
    .map((s) => ({
      value: s.id,
      label: s.name,
      icon: <Plug className="size-3.5 text-muted-foreground" />,
      hint: s.source === "composio" ? "Composio" : s.transport,
    }));
  return (
    <div className="space-y-1.5">
      <Label htmlFor="agent-mcp">Attached servers</Label>
      <MultiSelect
        id="agent-mcp"
        options={options}
        value={value}
        onChange={onChange}
        placeholder={options.length ? "Attach MCP servers…" : "No MCP servers yet — add them in Integrations"}
        emptyText="No MCP servers configured."
      />
    </div>
  );
}

function SubagentsEditor({
  value,
  onChange,
  errors,
}: {
  value: SubagentDefinition[];
  onChange: (v: SubagentDefinition[]) => void;
  errors: Record<string, string>;
}) {
  const { catalog } = useModelCatalog();
  const update = (i: number, patch: Partial<SubagentDefinition>) => onChange(value.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  if (value.length === 0) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-dashed px-4 py-5 text-sm text-muted-foreground">
        <UserRound className="size-5 shrink-0" />
        No subagents. Add one for recurring specialist work, e.g. a “researcher” that only searches and summarizes.
      </div>
    );
  }
  return (
    <div id="subagents-list" tabIndex={-1} className="space-y-3 outline-none">
      <AnimatePresence initial={false}>
        {value.map((s, i) => (
          <motion.div
            key={i}
            layout
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98 }}
            className="space-y-3 rounded-lg border bg-paper-2 p-3.5"
          >
            <div className="flex items-start gap-3">
              <div className="grid flex-1 grid-cols-1 gap-3 @xl:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor={`sub-name-${i}`} className="text-xs">
                    Name
                  </Label>
                  <Input
                    id={`sub-name-${i}`}
                    value={s.name}
                    onChange={(e) => update(i, { name: e.target.value })}
                    onBlur={(e) => update(i, { name: slugify(e.target.value) })}
                    placeholder="researcher"
                    className="h-8 font-mono text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`sub-model-${i}`} className="text-xs">
                    Model
                  </Label>
                  <Select
                    value={findModel(catalog.models, s.model)?.id ?? (s.model || "__inherit")}
                    onValueChange={(v) => update(i, { model: v === "__inherit" ? undefined : v })}
                  >
                    <SelectTrigger id={`sub-model-${i}`} size="sm" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      <SelectItem value="__inherit">Same as agent</SelectItem>
                      <ModelOptions models={catalog.models} current={s.model} />
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5 @xl:col-span-2">
                  <Label htmlFor={`sub-desc-${i}`} className="text-xs">
                    When to use it
                  </Label>
                  <Input
                    id={`sub-desc-${i}`}
                    value={s.description}
                    onChange={(e) => update(i, { description: e.target.value })}
                    placeholder="Use for web research and source gathering"
                    className="h-8 text-sm"
                  />
                </div>
                <div className="space-y-1.5 @xl:col-span-2">
                  <Label htmlFor={`sub-prompt-${i}`} className="text-xs">
                    Prompt
                  </Label>
                  <Textarea
                    id={`sub-prompt-${i}`}
                    value={s.prompt}
                    onChange={(e) => update(i, { prompt: e.target.value })}
                    placeholder="You are a meticulous researcher. Find primary sources, cite URLs, summarize in bullet points."
                    className="min-h-20 text-sm"
                  />
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove subagent ${s.name || i + 1}`}
                onClick={() => onChange(value.filter((_, j) => j !== i))}
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2 />
              </Button>
            </div>
            {errors[`subagent-${i}`] && <p className="text-xs text-destructive">{errors[`subagent-${i}`]}</p>}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
