import { useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "react-router";
import { motion, AnimatePresence } from "motion/react";
import {
  ArrowRight,
  Bot,
  Box,
  BrainCircuit,
  Eye,
  FolderOpen,
  Globe,
  KeyRound,
  MonitorUp,
  Plug,
  Plus,
  Server,
  ShieldCheck,
  Sparkles,
  Trash2,
  TriangleAlert,
  UserRound,
  Users,
  Workflow,
  Wrench,
} from "lucide-react";
import type { Agent, AgentCharacter, AgentInput, Effort, SecretAccessMode, SubagentDefinition } from "@godmode/shared";
import {
  DEFAULT_MODEL,
  EFFORT_LABELS,
  EFFORT_OPTIONS,
  MAX_AGENT_ROLE_LENGTH,
  ULTRACODE_HINT,
  characterGreeting,
  defaultCharacter,
  effortForModel,
  findModel,
  leadProblem,
  normalizeRole,
  reportsOf,
  withinReach,
} from "@godmode/shared";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useAllAgents, useBootstrap, useModelCatalog, useSshServers, useVmChoices, useWorkspaces } from "@/lib/hooks";
import { isMac, modKey } from "@/lib/desktop";
import { useUi } from "@/stores/ui";
import { useDraft } from "@/lib/drafts";
import { cn } from "@/lib/utils";
import { AgentAvatar, DraftStatus, Kbd, Section } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { AvatarPicker, ColorSwatches } from "./avatar-picker";
import { CharacterPartsPicker, CharacterStage, PersonalityPicker, randomLook } from "./character-studio";
import { MultiSelect } from "./multi-select";
import { ModelOptions } from "./model-options";
import { useVaultGrant } from "@/components/vault/grant";
import { FolderPickerDialog, folderName, useShortPath } from "@/components/chat/folder-picker";
import { defaultProfileFor } from "@/components/chat/browser-panel";
import { InheritedInstructions, useInheritedInstructions } from "@/components/instructions/instructions";
import { VmSelectField } from "@/components/vms/vm-picker";
import { useApiTools } from "@/components/integrations/api-tools-tab";
import { ApiToolDialog, type ApiToolDialogState } from "@/components/integrations/api-tool-dialog";
import { toolIcon } from "@/components/integrations/api-tool-presets";
import { ScopeChip } from "@/components/integrations/scope-picker";
import { SSH_STATUS_LABEL, SshStatusDot, sshAddress, sshStatus } from "@/components/ssh/ssh-parts";

export interface AgentFormValues {
  name: string;
  avatar: string;
  color: string;
  character: AgentCharacter;
  /** Preset id, custom text, or "" for no particular voice. */
  personality: string;
  description: string;
  instructions: string;
  /** Job title on the team. */
  role: string;
  /** Its lead; null = the built-in agent. */
  reportsTo: string | null;
  workspaceId: string | null;
  model: string;
  effort: Effort | null;
  /** null = the global default. */
  ultracode: boolean | null;
  secretAccess: SecretAccessMode;
  allowDelegation: boolean;
  delegateTo: string[];
  canManageAgents: boolean;
  maxBudgetUsd: string;
  /** What it may cost per calendar month; "" = no budget. */
  monthlyBudgetUsd: string;
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
  /** macOS VM the agent works in; null = its workspace's (if any). */
  vmId: string | null;
  sshServerIds: string[];
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
    character: source?.character ?? defaultCharacter(source?.id ?? source?.name ?? "new-agent"),
    personality: source?.personality ?? "",
    description: source?.description ?? "",
    instructions: source?.instructions ?? "",
    role: source?.role ?? "",
    reportsTo: source?.reportsTo ?? null,
    workspaceId: source?.workspaceId !== undefined ? source.workspaceId : (defaults.workspaceId ?? null),
    model: source?.model ?? "",
    effort: source?.effort ?? null,
    ultracode: source?.ultracode ?? null,
    secretAccess: source?.permissions?.secretAccess ?? defaults.secretAccess ?? "fill",
    allowDelegation: source?.permissions?.allowDelegation ?? true,
    delegateTo: source?.permissions?.delegateTo ?? [],
    canManageAgents: source?.permissions?.canManageAgents ?? false,
    maxBudgetUsd: source?.permissions?.maxBudgetUsd != null ? String(source.permissions.maxBudgetUsd) : "",
    monthlyBudgetUsd: source?.permissions?.monthlyBudgetUsd != null ? String(source.permissions.monthlyBudgetUsd) : "",
    browserEnabled: source?.browser?.enabled ?? true,
    browserProfileId: source?.browser?.profileId ?? null,
    headless: source?.browser?.headless ?? null,
    computerEnabled: source?.computer?.enabled ?? false,
    computerDisplayId: source?.computer?.target?.kind === "display" ? source.computer.target.displayId : null,
    inheritMcp: source?.inheritMcp ?? true,
    mcpServerIds: source?.mcpServerIds ?? [],
    subagents: source?.subagents ?? [],
    workingDirectory: source?.workingDirectory ?? null,
    vmId: source?.vmId ?? null,
    sshServerIds: source?.sshServerIds ?? [],
  };
}

export function valuesToInput(v: AgentFormValues): AgentInput {
  const budget = v.maxBudgetUsd.trim() ? Number(v.maxBudgetUsd) : null;
  const monthly = v.monthlyBudgetUsd.trim() ? Number(v.monthlyBudgetUsd) : null;
  return {
    workspaceId: v.workspaceId,
    name: v.name.trim(),
    avatar: v.avatar,
    color: v.color,
    character: v.character,
    personality: v.personality.trim(),
    description: v.description.trim(),
    instructions: v.instructions,
    role: normalizeRole(v.role),
    reportsTo: v.reportsTo,
    model: v.model,
    effort: v.effort,
    ultracode: v.ultracode,
    permissions: {
      secretAccess: v.secretAccess,
      allowDelegation: v.allowDelegation,
      delegateTo: v.allowDelegation ? v.delegateTo : [],
      canManageAgents: v.canManageAgents,
      maxBudgetUsd: budget != null && Number.isFinite(budget) && budget > 0 ? budget : null,
      monthlyBudgetUsd: monthly != null && Number.isFinite(monthly) && monthly > 0 ? monthly : null,
    },
    browser: { enabled: v.browserEnabled, profileId: v.browserProfileId, headless: v.headless },
    computer: { enabled: v.computerEnabled, target: v.computerDisplayId ? { kind: "display", displayId: v.computerDisplayId } : null },
    inheritMcp: v.inheritMcp,
    mcpServerIds: v.mcpServerIds,
    subagents: v.subagents
      .map((s) => ({ ...s, name: slugify(s.name), description: s.description.trim(), prompt: s.prompt, model: s.model || undefined }))
      .filter((s) => s.name),
    workingDirectory: v.workingDirectory,
    vmId: v.vmId,
    sshServerIds: v.sshServerIds,
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
  if (v.monthlyBudgetUsd.trim()) {
    const n = Number(v.monthlyBudgetUsd);
    if (!Number.isFinite(n) || n <= 0) errors.monthlyBudgetUsd = "Enter a positive amount, or leave empty for no budget";
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

const SECTIONS = [
  { id: "identity", label: "Identity" },
  { id: "team", label: "Team" },
  { id: "personality", label: "Personality" },
  { id: "instructions", label: "Instructions" },
  { id: "brain", label: "Model" },
  { id: "folder", label: "Folder" },
  { id: "permissions", label: "Permissions" },
  { id: "browser", label: "Browser" },
  { id: "computer", label: "Computer" },
  { id: "vm", label: "Virtual machine" },
  { id: "ssh", label: "SSH servers" },
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
  draftKey,
}: {
  initial?: Partial<Agent>;
  agentId?: string;
  isDefault?: boolean;
  mode: "create" | "edit";
  submitLabel: string;
  pending?: boolean;
  onSubmit: (input: AgentInput) => void;
  onCancel?: () => void;
  /** Rendered above the submit bar (e.g. template automation opt-in). */
  footerExtra?: ReactNode;
  /** Keep unsaved values as a draft under this key; clear it with `clearDraft` once saved. */
  draftKey?: string;
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
  // Realtime updates flow into the fields that haven't been edited.
  const [values, setValues, draft] = useDraft<AgentFormValues>(draftKey, seed);
  const [showErrors, setShowErrors] = useState(false);
  const dirty = JSON.stringify(values) !== JSON.stringify(seed);
  const effectiveModel = findModel(catalog.models, values.model || boot?.settings.runner.model || DEFAULT_MODEL);
  const efforts: readonly Effort[] = effectiveModel?.efforts ?? EFFORT_OPTIONS;
  // A custom model id: possible whenever this Claude Code has Ultracode at all.
  const anyUltracode = catalog.models.some((m) => m.ultracode);
  const ultracodeAvailable = effectiveModel ? effectiveModel.ultracode : anyUltracode;

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
      document.getElementById(first === "name" ? "agent-name" : first.startsWith("subagent") ? "subagents-list" : first === "monthlyBudgetUsd" ? "agent-month-budget" : "agent-budget")?.focus();
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
        if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
        submitRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const err = (k: string) => (showErrors ? errors[k] : undefined);
  const preview = { id: agentId, name: values.name, avatar: values.avatar, color: values.color, character: values.character };
  const human = boot?.settings.general.userName;
  const inherited = useInheritedInstructions(values.workspaceId);
  const vmChoices = useVmChoices();
  const sections = vmChoices.available ? SECTIONS : SECTIONS.filter((s) => s.id !== "vm");

  const { hash } = useLocation();
  // Again once the VM section shows up: it waits for the VM status (links from the VMs page go to #vm).
  useEffect(() => {
    const id = hash.slice(1);
    if (SECTIONS.some((s) => s.id === id)) requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start" }));
  }, [hash, vmChoices.available]);

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
          <FormSection id="identity" title="Identity" description="What this agent looks like and how it shows up across Godmode.">
            <div className="grid grid-cols-1 gap-5 @2xl:grid-cols-[15rem_minmax(0,1fr)]">
              <CharacterStage
                character={values.character}
                color={values.color}
                name={values.name}
                personality={values.personality}
                human={human}
                onSurprise={() => setValues((v) => ({ ...v, ...randomLook() }))}
                className="min-h-64"
              />
              <div className="min-w-0 space-y-4">
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
                  <Label htmlFor="agent-role">Role</Label>
                  <Input
                    id="agent-role"
                    value={values.role}
                    onChange={(e) => set("role", e.target.value)}
                    placeholder={isDefault ? "e.g. Chief of staff" : "e.g. Bookkeeper"}
                    maxLength={MAX_AGENT_ROLE_LENGTH}
                    aria-describedby="agent-role-hint"
                  />
                  <p id="agent-role-hint" className="text-xs text-muted-foreground">
                    Its job title — shown under its name and told to its teammates.
                  </p>
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
                <div className="space-y-1.5">
                  <Label htmlFor="agent-avatar">Emoji in chat apps</Label>
                  <div className="flex items-center gap-3">
                    <AvatarPicker id="agent-avatar" avatar={values.avatar} color={values.color} onChange={(v) => set("avatar", v)} />
                    <p className="text-xs text-muted-foreground">Signs its messages where only text fits — Slack, Telegram, Teams.</p>
                  </div>
                </div>
              </div>
            </div>
            <div className="mt-5 border-t pt-4">
              <CharacterPartsPicker character={values.character} color={values.color} onChange={(c) => set("character", c)} />
            </div>
          </FormSection>

          <FormSection
            id="team"
            title="Team"
            description="Where it sits on your team. Every agent is told who leads it and who does what, so work goes to the right one."
          >
            <TeamField
              agentId={agentId}
              isDefault={isDefault}
              name={values.name}
              workspaceId={values.workspaceId}
              value={values.reportsTo}
              onChange={(v) => set("reportsTo", v)}
            />
          </FormSection>

          <FormSection
            id="personality"
            title="Personality"
            description="How it talks to you — greetings, updates and reports. Goes into the agent's CLAUDE.md."
          >
            <PersonalityPicker value={values.personality} onChange={(p) => set("personality", p)} />
          </FormSection>

          <FormSection
            id="instructions"
            title="Instructions"
            description="Standing orders: how it should work, what to always or never do. Goes into the agent's CLAUDE.md."
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
            <div className="mt-4 space-y-1.5">
              <span id="agent-ultracode-label" className="flex items-center gap-1.5 text-sm font-medium">
                <Workflow className="size-4 text-muted-foreground" /> Ultracode
              </span>
              <ToggleGroup
                type="single"
                variant="outline"
                value={values.ultracode === null ? "default" : values.ultracode ? "on" : "off"}
                onValueChange={(v) => v && set("ultracode", v === "default" ? null : v === "on")}
                aria-labelledby="agent-ultracode-label"
                className="w-full"
              >
                <ToggleGroupItem value="default" className="flex-1 data-[state=on]:bg-secondary data-[state=on]:text-foreground data-[state=on]:ring-1 data-[state=on]:ring-foreground/15 data-[state=on]:ring-inset">
                  Default
                </ToggleGroupItem>
                <ToggleGroupItem value="on" disabled={!ultracodeAvailable} className="flex-1 data-[state=on]:bg-secondary data-[state=on]:text-foreground data-[state=on]:ring-1 data-[state=on]:ring-foreground/15 data-[state=on]:ring-inset">
                  On
                </ToggleGroupItem>
                <ToggleGroupItem value="off" className="flex-1 data-[state=on]:bg-secondary data-[state=on]:text-foreground data-[state=on]:ring-1 data-[state=on]:ring-foreground/15 data-[state=on]:ring-inset">
                  Off
                </ToggleGroupItem>
              </ToggleGroup>
              <p className="text-xs text-muted-foreground">
                {ultracodeAvailable
                  ? ULTRACODE_HINT
                  : anyUltracode
                    ? `${effectiveModel?.label ?? "This model"} doesn't support Ultracode.`
                    : "The installed Claude Code doesn't offer Ultracode."}
              </p>
            </div>
          </FormSection>

          <FormSection
            id="folder"
            title="Working folder"
            description="Optional. Its chats and automations run inside this folder and can read and edit the files there. Memory stays in the agent's own repository."
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
                title="Can hand work to teammates"
                description="Hand parts of a task to other agents and use their results."
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
                    <DelegateField
                      agentId={agentId}
                      workspaceId={values.workspaceId}
                      canManageAgents={values.canManageAgents}
                      value={values.delegateTo}
                      onChange={(v) => set("delegateTo", v)}
                    />
                  </motion.div>
                )}
              </AnimatePresence>

              <ToggleRow
                id="agent-manage"
                icon={<Bot className="size-4" />}
                title="Can manage agents & automations"
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
              <div className="grid gap-1.5 @md:max-w-xs">
                <Label htmlFor="agent-month-budget">Monthly budget</Label>
                <div className="relative">
                  <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                  <Input
                    id="agent-month-budget"
                    inputMode="decimal"
                    value={values.monthlyBudgetUsd}
                    onChange={(e) => set("monthlyBudgetUsd", e.target.value.replace(",", "."))}
                    placeholder="No budget"
                    aria-invalid={!!err("monthlyBudgetUsd")}
                    className="pl-7"
                  />
                </div>
                {err("monthlyBudgetUsd") ? (
                  <p className="text-xs text-destructive">{err("monthlyBudgetUsd")}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    What {values.name.trim() || "it"} may cost in a calendar month. When it's used up, its automations, follow-ups and board tickets wait for you — chats you start still run.
                  </p>
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
                <BrowserProfileField
                  value={values.browserProfileId}
                  workspaceId={values.workspaceId}
                  onChange={(v) => set("browserProfileId", v)}
                  disabled={!values.browserEnabled}
                />
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
            description="In chats you share a window or screen yourself. Here you can let this agent use the computer on its own — for automations and delegated tasks."
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

          {vmChoices.available && (
            <FormSection
              id="vm"
              title="Virtual machine"
              description="Let this agent work in its own macOS VM: it installs tools, runs builds and uses apps there instead of on this Mac. A single chat can still pick another VM."
            >
              <VmField value={values.vmId} workspaceId={values.workspaceId} onChange={(v) => set("vmId", v)} />
            </FormSection>
          )}

          <FormSection id="ssh" title="SSH servers" description="Remote machines this agent can sign in to and control. Godmode types the password or key — the AI never sees it.">
            <SshField value={values.sshServerIds} onChange={(v) => set("sshServerIds", v)} />
          </FormSection>

          <FormSection id="tools" title="Tools & integrations" description="APIs, MCP servers and connected apps this agent can use.">
            <div className="space-y-5">
              <ToggleRow
                id="agent-inherit-mcp"
                icon={<Plug className="size-4" />}
                title="Inherit shared integrations"
                description="Also use the global and workspace tools, MCP servers and Composio apps."
                checked={values.inheritMcp}
                onChange={(v) => set("inheritMcp", v)}
              />
              <ApiToolsField agentId={agentId} workspaceId={values.workspaceId} savedWorkspaceId={initial?.workspaceId ?? null} inherit={values.inheritMcp} />
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
                <AgentAvatar agent={preview} size="lg" follow />
                <div className="min-w-0">
                  <div className="truncate font-medium tracking-[-0.01em]">{values.name || "Unnamed agent"}</div>
                  <div className="line-clamp-2 text-xs text-muted-foreground">{values.description || "No description yet"}</div>
                </div>
              </div>
              <p className="mt-3 rounded-lg rounded-tl-sm border bg-paper-2 px-3 py-2 text-xs leading-relaxed text-foreground/85">
                {characterGreeting({ name: values.name.trim() || "Your agent", personality: values.personality, human, seed: "studio" })}
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                <span className="rounded-[5px] border bg-secondary px-1.5 py-0.5">{findModel(catalog.models, values.model)?.label ?? (values.model || "Default model")}</span>
                {values.browserEnabled && <span className="rounded-[5px] border bg-secondary px-1.5 py-0.5">Browser</span>}
                {values.computerEnabled && <span className="rounded-[5px] border bg-secondary px-1.5 py-0.5">Computer</span>}
                {vmChoices.available && values.vmId && (
                  <span className="flex max-w-full items-center gap-1 rounded-[5px] border bg-secondary px-1.5 py-0.5">
                    <Box className="size-3 shrink-0" />
                    <span className="truncate">{vmChoices.vms.find((v) => v.id === values.vmId)?.name ?? "VM"}</span>
                  </span>
                )}
                {values.sshServerIds.length > 0 && (
                  <span className="flex items-center gap-1 rounded-[5px] border bg-secondary px-1.5 py-0.5">
                    <Server className="size-3 shrink-0" />
                    {values.sshServerIds.length === 1 ? "1 server" : `${values.sshServerIds.length} servers`}
                  </span>
                )}
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
              {sections.map((s) => (
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
          {mode === "create" && draft.saved && <DraftStatus onDiscard={draft.discard} />}
          <span className="hidden items-center gap-1 text-xs text-muted-foreground @2xl:flex">
            <Kbd>{modKey}S</Kbd>
          </span>
          {onCancel && (
            <Button type="button" variant="ghost" onClick={onCancel}>
              {mode === "edit" && dirty ? "Discard" : "Cancel"}
            </Button>
          )}
          {mode === "edit" && dirty && !onCancel && (
            <Button type="button" variant="ghost" onClick={draft.discard}>
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
        description="New chats and automations of this agent run inside this folder. Each chat can still switch to another one."
      />
    </>
  );
}

function VmField({ value, workspaceId, onChange }: { value: string | null; workspaceId: string | null; onChange: (v: string | null) => void }) {
  const { data: workspaces = [] } = useWorkspaces();
  const { vms } = useVmChoices();
  const workspace = workspaceId ? workspaces.find((w) => w.id === workspaceId) : undefined;
  const workspaceVm = workspace?.vmId ? vms.find((v) => v.id === workspace.vmId) : undefined;
  return (
    <div className="@xl:max-w-md">
      <VmSelectField
        id="agent-vm"
        label="Works in"
        value={value}
        onChange={onChange}
        noneLabel={workspaceVm ? `None — use the workspace's VM (${workspaceVm.name})` : "None — use the workspace's VM"}
        hint={
          value
            ? "Its runs start the VM when they need it."
            : workspaceVm
              ? `Runs work in ${workspaceVm.name}, the VM of ${workspace?.name}.`
              : "Runs work on this Mac, unless its workspace or a chat has a VM."
        }
      />
    </div>
  );
}

function SshField({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const { data: servers = [], isLoading } = useSshServers();
  if (!isLoading && servers.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed px-4 py-3.5">
        <Server className="size-5 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 basis-48 text-sm text-muted-foreground">No SSH servers yet — add one and this agent can work on it.</p>
        <Button type="button" variant="outline" size="sm" asChild>
          <Link to="/ssh?new=1">
            <Plus /> Add a server
          </Link>
        </Button>
      </div>
    );
  }
  const toggle = (id: string, on: boolean) => onChange(on ? [...value.filter((x) => x !== id), id] : value.filter((x) => x !== id));
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <span id="agent-ssh-label" className="text-sm font-medium">
          Can sign in to
        </span>
        <Link to="/ssh" className="flex items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground">
          Manage servers <ArrowRight className="size-3" />
        </Link>
      </div>
      <div role="group" aria-labelledby="agent-ssh-label" className="divide-y overflow-hidden rounded-lg border">
        {isLoading
          ? [0, 1].map((i) => <div key={i} className="h-[52px] animate-pulse bg-paper-2/60" />)
          : servers.map((s) => {
              const id = `agent-ssh-${s.id}`;
              return (
                <label key={s.id} htmlFor={id} className="flex cursor-pointer items-center gap-3 px-3 py-2.5 transition hover:bg-accent/50">
                  <Checkbox id={id} checked={value.includes(s.id)} onCheckedChange={(v) => toggle(s.id, v === true)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{s.name}</span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">{sshAddress(s)}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <SshStatusDot server={s} />
                    <span className="hidden @xl:inline">{SSH_STATUS_LABEL[sshStatus(s)]}</span>
                  </span>
                </label>
              );
            })}
      </div>
      <p className="text-xs text-muted-foreground">Every run of this agent can sign in to these. A single chat can add more with the SSH button in its message box.</p>
    </div>
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

function DelegateField({
  agentId,
  workspaceId,
  canManageAgents,
  value,
  onChange,
}: {
  agentId?: string;
  workspaceId: string | null;
  canManageAgents: boolean;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const { data: agents = [] } = useAllAgents();
  // The core's own rule (withinReach): global agents and its workspace; a manager reaches everyone.
  const reach = { id: agentId ?? "", workspaceId, canManageAgents };
  const inReach = agents.filter((a) => a.id !== agentId && withinReach(reach, a));
  const options = inReach.map((a) => ({
    value: a.id,
    label: a.name,
    icon: <AgentAvatar agent={a} size="sm" still className="size-5" />,
    hint: [a.role, a.enabled ? "" : "switched off", a.description].filter(Boolean).join(" · "),
  }));
  const outOfReach = value.flatMap((id) => {
    const a = agents.find((x) => x.id === id);
    return a && !withinReach(reach, a) ? [a] : [];
  });
  const listed = value.flatMap((id) => inReach.filter((a) => a.id === id));
  const names = (list: Agent[]) => (list.length > 4 ? `${list.slice(0, 4).map((a) => a.name).join(", ")} and ${list.length - 4} more` : list.map((a) => a.name).join(", "));
  return (
    <div className="space-y-1.5 pl-11">
      <Label htmlFor="agent-delegate-to" className="text-xs text-muted-foreground">
        Can hand work to <span className="font-normal">(empty = any teammate in reach)</span>
      </Label>
      <MultiSelect
        id="agent-delegate-to"
        options={options}
        value={value.filter((id) => inReach.some((a) => a.id === id))}
        onChange={(next) => onChange([...next, ...outOfReach.map((a) => a.id)])}
        placeholder="Any teammate in reach"
        emptyText="No other agents in reach yet."
      />
      <p className="text-xs text-muted-foreground">
        {value.length === 0
          ? inReach.length
            ? `Reaches ${inReach.length} agent${inReach.length === 1 ? "" : "s"}: ${names(inReach)}.`
            : "No other agents in reach yet."
          : listed.length
            ? `Hands work to: ${names(listed)}.`
            : "Nobody on this list is in reach, so it can't hand work to anyone."}
      </p>
      {outOfReach.map((a) => (
        <p key={a.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-warning/10 px-2 py-1 text-xs text-foreground">
          <TriangleAlert className="size-3.5 shrink-0 text-warning" aria-hidden />
          <span className="min-w-0 flex-1">{a.name} works in another workspace, so it can't be reached.</span>
          <Button type="button" size="xs" variant="ghost" onClick={() => onChange(value.filter((id) => id !== a.id))}>
            Remove
          </Button>
        </p>
      ))}
    </div>
  );
}

/** "Reports to": its lead on the org chart (the built-in agent by default), and who it leads. Grants nothing. */
function TeamField({
  agentId,
  isDefault,
  name,
  workspaceId,
  value,
  onChange,
}: {
  agentId?: string;
  isDefault: boolean;
  name: string;
  workspaceId: string | null;
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const { data: agents = [] } = useAllAgents();
  const builtin = agents.find((a) => a.isDefault);
  const self = { id: agentId ?? "__new", workspaceId, isDefault, reportsTo: value };
  const team = agents.some((a) => a.id === self.id) ? agents.map((a) => (a.id === self.id ? { ...a, ...self } : a)) : [...agents, self];
  const leads = agents.filter((a) => !a.isDefault && a.id !== agentId && !leadProblem(self, a, team));
  const reports = agentId ? reportsOf(self, agents).filter((a) => a.id !== agentId) : [];
  const current = value ? agents.find((a) => a.id === value) : null;
  const [resetNote, setResetNote] = useState<string | null>(null);

  // A new workspace can put the chosen lead out of bounds: back to the built-in agent, and say why.
  useEffect(() => {
    if (!current) return;
    if (leadProblem(self, current, team) === "workspace") {
      setResetNote(`Reset to ${builtin?.name ?? "Godmode"}: ${current.name} works in another workspace.`);
      onChange(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, current?.id]);

  if (isDefault) {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">{builtin?.name ?? "Godmode"} leads the team and reports to you. Every agent without a lead of its own reports to it.</p>
        <LedBy agents={reportsOf({ ...self, isDefault: true }, agents)} />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div className="space-y-1.5 @md:max-w-sm">
        <Label htmlFor="agent-reports-to">Reports to</Label>
        <Select
          value={value ?? "__builtin"}
          onValueChange={(v) => {
            setResetNote(null);
            onChange(v === "__builtin" ? null : v);
          }}
        >
          <SelectTrigger id="agent-reports-to" className="w-full" aria-describedby="agent-reports-to-hint">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value="__builtin">
              <span className="flex items-center gap-2">
                {builtin && <AgentAvatar agent={builtin} size="sm" still className="size-5" />}
                {builtin?.name ?? "Godmode"} <span className="text-muted-foreground">— built-in</span>
              </span>
            </SelectItem>
            {leads.length > 0 && <SelectSeparator />}
            {leads.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                <span className="flex min-w-0 items-center gap-2">
                  <AgentAvatar agent={a} size="sm" still className="size-5" />
                  <span className="truncate">{a.name}</span>
                  {(a.role || !a.enabled) && <span className="truncate text-muted-foreground">{[a.role, a.enabled ? "" : "switched off"].filter(Boolean).join(" · ")}</span>}
                </span>
              </SelectItem>
            ))}
            {current && !leads.some((a) => a.id === current.id) && (
              <SelectItem value={current.id} disabled>
                {current.name}
              </SelectItem>
            )}
          </SelectContent>
        </Select>
        <p id="agent-reports-to-hint" className="text-xs text-muted-foreground">
          {resetNote ?? `Its lead on the org chart${name.trim() ? ` — ${name.trim()} hears who that is` : ""}. This doesn't change what it is allowed to do.`}
        </p>
      </div>
      <LedBy agents={reports} />
    </div>
  );
}

function LedBy({ agents }: { agents: Agent[] }) {
  if (!agents.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>Leads</span>
      {agents.slice(0, 12).map((a) => (
        <Link key={a.id} to={`/agents/${a.id}`} title={[a.name, a.role].filter(Boolean).join(" · ")} className="rounded-md focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
          <AgentAvatar agent={a} size="sm" still className="size-6" />
        </Link>
      ))}
      {agents.length > 12 && <span>+{agents.length - 12}</span>}
      <Link to="/agents?view=chart" className="ml-1 underline-offset-2 hover:underline">
        Org chart
      </Link>
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

function BrowserProfileField({
  value,
  workspaceId,
  onChange,
  disabled,
}: {
  value: string | null;
  workspaceId: string | null;
  onChange: (v: string | null) => void;
  disabled?: boolean;
}) {
  const { data: profiles = [], isLoading } = useQuery({ queryKey: [...qk.browserProfiles, "list"], queryFn: api.browser.profiles });
  const defaultId = defaultProfileFor(profiles, workspaceId)?.id;
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
              {p.id === defaultId && <span className="text-xs text-muted-foreground">default</span>}
              {p.cookieCount > 0 && <span className="text-xs text-muted-foreground">{p.cookieCount} cookies</span>}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** The API tools this agent gets (from its scope), with a shortcut to add one only for it. */
function ApiToolsField({
  agentId,
  workspaceId,
  savedWorkspaceId,
  inherit,
}: {
  agentId?: string;
  workspaceId: string | null;
  savedWorkspaceId: string | null;
  inherit: boolean;
}) {
  const { data: tools = [], isLoading } = useApiTools();
  const [dialog, setDialog] = useState<ApiToolDialogState>(null);
  const available = tools.filter(
    (t) => t.enabled && (t.agentId ? t.agentId === agentId : inherit && (t.workspaceId === null || t.workspaceId === workspaceId)),
  );
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label>API tools</Label>
        <Link to="/integrations?tab=tools" className="text-xs font-medium text-muted-foreground underline-offset-[3px] hover:text-foreground hover:underline">
          Manage tools
        </Link>
      </div>
      {isLoading ? (
        <div className="h-10 animate-pulse rounded-lg bg-paper-2" />
      ) : available.length ? (
        <ul className="divide-y rounded-lg border">
          {available.map((t) => {
            const Icon = toolIcon(t.preset);
            return (
              <li key={t.id} className="flex items-center gap-2.5 px-3 py-2">
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{t.name}</span>
                  {t.description && <span className="block truncate text-xs text-muted-foreground">{t.description}</span>}
                </span>
                <ScopeChip workspaceId={t.workspaceId} agentId={t.agentId} className="shrink-0" />
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="rounded-lg border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
          No API tools {inherit ? "yet" : "of its own"}. Add one to let it generate images, speak, search or call your own APIs.
        </p>
      )}
      {agentId && (
        <Button type="button" size="sm" variant="outline" onClick={() => setDialog({ mode: "create", preset: null, scope: { workspaceId: savedWorkspaceId, agentId } })}>
          <Wrench /> Add a tool only for this agent
        </Button>
      )}
      {/* Keep the dialog's submit from reaching this form (React events bubble through portals). */}
      <div onSubmit={(e) => e.stopPropagation()}>
        <ApiToolDialog state={dialog} onOpenChange={(o) => !o && setDialog(null)} />
      </div>
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
