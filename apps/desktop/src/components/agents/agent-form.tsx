import { useEffect, useEffectEvent, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "react-router";
import { useTranslation } from "react-i18next";
import { ArrowRight, ChevronRight, FolderOpen, Globe, MonitorUp, Plug, Plus, Server, Trash2, Wrench } from "lucide-react";
import type { Agent, AgentCharacter, AgentInput, Effort, SecretAccessMode, SubagentDefinition } from "@godmode/shared";
import { MAX_AGENT_ROLE_LENGTH, defaultCharacter, leadProblem, normalizeRole, reportsOf } from "@godmode/shared";
import { t as translate } from "@/i18n";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useAllAgents, useBootstrap, useSshServers, useVmChoices, useWorkspaces } from "@/lib/hooks";
import { isMac, modKey } from "@/lib/desktop";
import { useUi } from "@/stores/ui";
import { useDraft } from "@/lib/drafts";
import { cn } from "@/lib/utils";
import { AgentAvatar, DraftStatus, Kbd, Section } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AvatarPicker, ColorSwatches } from "./avatar-picker";
import { CharacterPartsPicker, CharacterStage, PersonalityPicker, randomLook } from "./character-studio";
import { MultiSelect } from "./multi-select";
import { FolderPickerDialog, folderName, useShortPath } from "@/components/chat/folder-picker";
import { defaultProfileFor } from "@/components/chat/browser-panel";
import { InheritedInstructions, useInheritedInstructions } from "@/components/instructions/instructions";
import { VmSelectField } from "@/components/vms/vm-picker";
import { useApiTools } from "@/components/integrations/api-tools-tab";
import { ApiToolDialog, type ApiToolDialogState } from "@/components/integrations/api-tool-dialog";
import { toolIcon } from "@/components/integrations/api-tool-presets";
import { ScopeChip } from "@/components/integrations/scope-picker";
import { SSH_STATUS_LABEL, SshStatusDot, sshAddress, sshStatus } from "@/components/ssh/ssh-parts";
import { AndroidField } from "@/components/android/android-chip";

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
  /** One of its workspace's projects it works on by default; null = none. */
  projectId: string | null;
  model: string;
  effort: Effort | null;
  /** null = the global default. */
  ultracode: boolean | null;
  secretAccess: SecretAccessMode;
  delegateTo: string[];
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
  androidDeviceIds: string[];
}

/** Seed values for the form from an existing agent, a template, or nothing. */
export function agentToValues(
  source: Partial<Agent> | undefined,
  defaults: { workspaceId?: string | null; projectId?: string | null; secretAccess?: SecretAccessMode } = {},
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
    projectId: source?.projectId !== undefined ? source.projectId : (defaults.projectId ?? null),
    model: source?.model ?? "",
    effort: source?.effort ?? null,
    ultracode: source?.ultracode ?? null,
    secretAccess: source?.permissions?.secretAccess ?? defaults.secretAccess ?? "fill",
    delegateTo: source?.permissions?.delegateTo ?? [],
    browserEnabled: source?.browser?.enabled ?? true,
    browserProfileId: source?.browser?.profileId ?? null,
    headless: source?.browser?.headless ?? null,
    computerEnabled: source?.computer?.enabled ?? true,
    computerDisplayId: source?.computer?.target?.kind === "display" ? source.computer.target.displayId : null,
    inheritMcp: source?.inheritMcp ?? true,
    mcpServerIds: source?.mcpServerIds ?? [],
    subagents: source?.subagents ?? [],
    workingDirectory: source?.workingDirectory ?? null,
    vmId: source?.vmId ?? null,
    sshServerIds: source?.sshServerIds ?? [],
    androidDeviceIds: source?.androidDeviceIds ?? [],
  };
}

export function valuesToInput(v: AgentFormValues): AgentInput {
  return {
    workspaceId: v.workspaceId,
    projectId: v.workspaceId ? v.projectId : null,
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
    permissions: { secretAccess: v.secretAccess, allowDelegation: true, delegateTo: v.delegateTo, canManageAgents: true },
    browser: { enabled: v.browserEnabled, profileId: v.browserProfileId, headless: v.headless },
    computer: { enabled: v.computerEnabled, target: v.computerDisplayId ? { kind: "display", displayId: v.computerDisplayId } : null },
    inheritMcp: v.inheritMcp,
    mcpServerIds: v.mcpServerIds,
    subagents: v.subagents,
    workingDirectory: v.workingDirectory,
    vmId: v.vmId,
    sshServerIds: v.sshServerIds,
    androidDeviceIds: v.androidDeviceIds,
  };
}

const ADVANCED_SECTIONS = ["folder", "browser", "computer", "vm", "ssh", "android", "tools"];

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
  const { t } = useTranslation(["agents", "common"]);
  const { data: boot } = useBootstrap();
  const scope = useUi((s) => s.workspace);
  const scopeProject = useUi((s) => s.project);
  const defaults = useMemo(
    () => ({
      workspaceId: scope !== "all" && scope !== "global" ? scope : null,
      projectId: scope !== "all" && scope !== "global" ? scopeProject : null,
      secretAccess: boot?.settings.security.defaultSecretAccess ?? ("fill" as const),
    }),
    [scope, scopeProject, boot?.settings.security.defaultSecretAccess],
  );
  const seed = useMemo(() => agentToValues(initial, defaults), [initial, defaults]);
  // Realtime updates flow into the fields that haven't been edited.
  const [values, setValues, draft] = useDraft<AgentFormValues>(draftKey, seed);
  const [showErrors, setShowErrors] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const dirty = JSON.stringify(values) !== JSON.stringify(seed);
  const nameMissing = !values.name.trim();
  const set = <K extends keyof AgentFormValues>(key: K, value: AgentFormValues[K]) => setValues((v) => ({ ...v, [key]: value }));
  const submit = () => {
    if (nameMissing) {
      setShowErrors(true);
      document.getElementById("agent-name")?.focus();
      return;
    }
    onSubmit(valuesToInput(values));
  };

  // Save shortcut
  const onSaveShortcut = useEffectEvent(() => submit());
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
        onSaveShortcut();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const inherited = useInheritedInstructions(values.workspaceId, undefined, values.projectId);
  const vmChoices = useVmChoices();
  const androidOn = !!boot?.settings.android.enabled;
  const integrationsOn = !!boot?.settings.integrations.enabled;
  const sshOn = !!boot?.settings.ssh.enabled;
  const messagingOn = !!boot?.settings.messaging.enabled;

  const { hash } = useLocation();
  // Again once the VM or Android section shows up: they wait for the VM status and the settings (links from the VMs page go to #vm).
  useEffect(() => {
    const id = hash.slice(1);
    if (!ADVANCED_SECTIONS.includes(id)) return;
    setAdvancedOpen(true);
    requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start" })));
  }, [hash, vmChoices.available, androidOn]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="relative mx-auto max-w-3xl"
      noValidate
    >
      <div className="space-y-5">
        <FormSection id="identity" title={t("agentForm.identity.title")}>
          <div className="grid grid-cols-1 gap-5 @2xl:grid-cols-[15rem_minmax(0,1fr)]">
            <CharacterStage
              character={values.character}
              color={values.color}
              name={values.name}
              personality={values.personality}
              human={boot?.settings.general.userName}
              onSurprise={() => setValues((v) => ({ ...v, ...randomLook() }))}
              className="min-h-64"
            />
            <div className="min-w-0 space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="agent-name">{t("common:words.name")}</Label>
                <Input
                  id="agent-name"
                  value={values.name}
                  onChange={(e) => set("name", e.target.value)}
                  placeholder={t("agentForm.identity.namePlaceholder")}
                  aria-invalid={showErrors && nameMissing}
                  maxLength={60}
                  autoFocus={mode === "create"}
                />
                {showErrors && nameMissing && <p className="text-xs text-destructive">{t("agentForm.errors.name")}</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="agent-role">{t("agentForm.identity.jobTitle")}</Label>
                <Input
                  id="agent-role"
                  value={values.role}
                  onChange={(e) => set("role", e.target.value)}
                  placeholder={isDefault ? t("agentForm.identity.rolePlaceholderDefault") : t("agentForm.identity.rolePlaceholder")}
                  maxLength={MAX_AGENT_ROLE_LENGTH}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="agent-description">{t("agentForm.identity.shortDescription")}</Label>
                <Input
                  id="agent-description"
                  value={values.description}
                  onChange={(e) => set("description", e.target.value)}
                  placeholder={t("agentForm.identity.descriptionPlaceholder")}
                  maxLength={160}
                />
              </div>
              <div className="space-y-1.5">
                <span className="text-sm font-medium">{t("agentForm.identity.color")}</span>
                <ColorSwatches value={values.color} onChange={(c) => set("color", c)} />
              </div>
              {messagingOn && (
                <div className="space-y-1.5">
                  <Label htmlFor="agent-avatar">{t("agentForm.identity.emoji")}</Label>
                  <AvatarPicker id="agent-avatar" avatar={values.avatar} color={values.color} onChange={(v) => set("avatar", v)} />
                </div>
              )}
            </div>
          </div>
          <div className="mt-5 border-t pt-4">
            <CharacterPartsPicker character={values.character} color={values.color} onChange={(c) => set("character", c)} />
          </div>
        </FormSection>

        <FormSection id="instructions" title={t("agentForm.instructions.title")}>
          <Textarea
            id="agent-instructions"
            value={values.instructions}
            onChange={(e) => set("instructions", e.target.value)}
            placeholder={t("agentForm.instructions.placeholder")}
            aria-label={t("agentForm.instructions.title")}
            className="min-h-64 resize-y text-[14px] leading-relaxed"
          />
          {inherited.length > 0 && (
            <div className="mt-4 rounded-lg border bg-paper-2 p-1.5">
              <p className="px-2 pt-1 pb-0.5 text-[11px] font-medium text-muted-foreground">{t("agentForm.instructions.inherited")}</p>
              <InheritedInstructions layers={inherited} />
            </div>
          )}
        </FormSection>

        <FormSection id="personality" title={t("agentForm.personality.title")}>
          <PersonalityPicker value={values.personality} onChange={(p) => set("personality", p)} />
        </FormSection>

        <FormSection id="team" title={t("agentForm.team.title")}>
          <div className="space-y-4">
            {!isDefault && (
              <>
                <WorkspaceField
                  value={values.workspaceId}
                  onChange={(v) => {
                    set("workspaceId", v);
                    set("projectId", null);
                  }}
                />
                <ProjectField workspaceId={values.workspaceId} value={values.projectId} onChange={(v) => set("projectId", v)} />
              </>
            )}
            <TeamField
              agentId={agentId}
              isDefault={isDefault}
              workspaceId={values.workspaceId}
              value={values.reportsTo}
              onChange={(v) => set("reportsTo", v)}
            />
          </div>
        </FormSection>

        <Collapsible id="advanced" open={advancedOpen} onOpenChange={setAdvancedOpen} className="scroll-mt-6">
          <CollapsibleTrigger className="group flex w-full items-center justify-between gap-3 rounded-xl border bg-card px-5 py-4 text-left shadow-card transition hover:border-foreground/15 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
            <span className="text-sm font-medium">{t("agentForm.advanced")}</span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
          </CollapsibleTrigger>
          <CollapsibleContent className="-mx-1 overflow-hidden px-1 pb-1 data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
            <div className="space-y-5 pt-5">
              <FormSection id="folder" title={t("agentForm.folder.title")}>
                <FolderField value={values.workingDirectory} onChange={(v) => set("workingDirectory", v)} />
              </FormSection>

              <FormSection id="browser" title={t("agentForm.browser.title")}>
                <div className="space-y-5">
                  <ToggleRow id="agent-browser" icon={<Globe className="size-4" />} title={t("agentForm.browser.access")} checked={values.browserEnabled} onChange={(v) => set("browserEnabled", v)} />
                  <div className={cn("grid grid-cols-1 gap-4 @xl:grid-cols-2", !values.browserEnabled && "pointer-events-none opacity-50")}>
                    <BrowserProfileField
                      value={values.browserProfileId}
                      workspaceId={values.workspaceId}
                      onChange={(v) => set("browserProfileId", v)}
                      disabled={!values.browserEnabled}
                    />
                    <div className="space-y-1.5">
                      <span id="agent-headless-label" className="flex items-center text-sm leading-none font-medium">
                        {t("agentForm.browser.window")}
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
                          {t("agentForm.default")}
                        </ToggleGroupItem>
                        <ToggleGroupItem value="visible" className="flex-1 data-[state=on]:bg-secondary data-[state=on]:text-foreground data-[state=on]:ring-1 data-[state=on]:ring-foreground/15 data-[state=on]:ring-inset">
                          {t("agentForm.browser.visible")}
                        </ToggleGroupItem>
                        <ToggleGroupItem value="headless" className="flex-1 data-[state=on]:bg-secondary data-[state=on]:text-foreground data-[state=on]:ring-1 data-[state=on]:ring-foreground/15 data-[state=on]:ring-inset">
                          {t("agentForm.browser.headless")}
                        </ToggleGroupItem>
                      </ToggleGroup>
                    </div>
                  </div>
                </div>
              </FormSection>

              <FormSection id="computer" title={t("agentForm.computer.title")}>
                <div className="space-y-5">
                  <ToggleRow id="agent-computer" icon={<MonitorUp className="size-4" />} title={t("agentForm.computer.unattended")} checked={values.computerEnabled} onChange={(v) => set("computerEnabled", v)} />
                  <ComputerDisplayField value={values.computerDisplayId} onChange={(v) => set("computerDisplayId", v)} disabled={!values.computerEnabled} />
                </div>
              </FormSection>

              {vmChoices.available && (
                <FormSection id="vm" title={t("agentForm.vm.title")}>
                  <VmField value={values.vmId} workspaceId={values.workspaceId} onChange={(v) => set("vmId", v)} />
                </FormSection>
              )}

              {sshOn && (
                <FormSection id="ssh" title={t("agentForm.ssh.title")}>
                  <SshField value={values.sshServerIds} onChange={(v) => set("sshServerIds", v)} />
                </FormSection>
              )}

              {androidOn && (
                <FormSection id="android" title={t("agentForm.android.title")}>
                  <AndroidField value={values.androidDeviceIds} onChange={(v) => set("androidDeviceIds", v)} />
                </FormSection>
              )}

              {integrationsOn && (
                <FormSection id="tools" title={t("agentForm.tools.title")}>
                  <div className="space-y-5">
                    <ToggleRow id="agent-inherit-mcp" icon={<Plug className="size-4" />} title={t("agentForm.tools.inherit")} checked={values.inheritMcp} onChange={(v) => set("inheritMcp", v)} />
                    <ApiToolsField agentId={agentId} workspaceId={values.workspaceId} savedWorkspaceId={initial?.workspaceId ?? null} inherit={values.inheritMcp} />
                    <McpField agentId={agentId} value={values.mcpServerIds} onChange={(v) => set("mcpServerIds", v)} />
                  </div>
                </FormSection>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>

      {/* Submit bar */}
      <div className="sticky bottom-0 z-10 mt-6 -mx-2 px-2 pb-4">
        <div className="glass flex flex-wrap items-center gap-3 rounded-xl px-4 py-3">
          <div className="min-w-0 flex-1">
            {footerExtra ?? (
              <span className="text-sm text-muted-foreground">
                {mode === "edit" ? (dirty ? t("agentForm.footer.unsaved") : t("agentForm.footer.allSaved")) : t("agentForm.footer.changeLater")}
              </span>
            )}
          </div>
          {mode === "create" && draft.saved && <DraftStatus onDiscard={draft.discard} />}
          <span className="hidden items-center gap-1 text-xs text-muted-foreground @2xl:flex">
            <Kbd>{modKey}S</Kbd>
          </span>
          {onCancel && (
            <Button type="button" variant="ghost" onClick={onCancel}>
              {mode === "edit" && dirty ? t("agentForm.footer.discard") : t("common:actions.cancel")}
            </Button>
          )}
          {mode === "edit" && dirty && !onCancel && (
            <Button type="button" variant="ghost" onClick={draft.discard}>
              {t("agentForm.footer.discard")}
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

function ToggleRow({ id, icon, title, checked, onChange }: { id: string; icon: ReactNode; title: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-3">
      <div className="grid size-8 shrink-0 place-items-center rounded-lg border bg-card text-foreground shadow-card">{icon}</div>
      <Label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
        {title}
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function FolderField({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const { t } = useTranslation("agents");
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
            {t("agentForm.folder.change")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("agentForm.folder.remove")}
            onClick={() => onChange(null)}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 />
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed px-4 py-4">
          <FolderOpen className="size-5 shrink-0 text-muted-foreground" />
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">{t("agentForm.folder.none")}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
            {t("agentForm.folder.choose")}
          </Button>
        </div>
      )}
      <FolderPickerDialog
        open={open}
        onOpenChange={setOpen}
        value={value}
        onPick={onChange}
        title={t("agentForm.folder.dialogTitle")}
        description={t("agentForm.folder.dialogDescription")}
      />
    </>
  );
}

function VmField({ value, workspaceId, onChange }: { value: string | null; workspaceId: string | null; onChange: (v: string | null) => void }) {
  const { t } = useTranslation("agents");
  const { data: workspaces = [] } = useWorkspaces();
  const { vms } = useVmChoices();
  const workspace = workspaceId ? workspaces.find((w) => w.id === workspaceId) : undefined;
  const workspaceVm = workspace?.vmId ? vms.find((v) => v.id === workspace.vmId) : undefined;
  return (
    <div className="@xl:max-w-md">
      <VmSelectField
        id="agent-vm"
        label={t("agentForm.vm.worksIn")}
        value={value}
        onChange={onChange}
        noneLabel={workspaceVm ? t("agentForm.vm.noneWithVm", { vm: workspaceVm.name }) : t("agentForm.vm.none")}
        hint={
          value
            ? t("agentForm.vm.hintSelected")
            : workspaceVm
              ? t("agentForm.vm.hintWorkspace", { vm: workspaceVm.name, workspace: workspace?.name })
              : t("agentForm.vm.hintLocal")
        }
      />
    </div>
  );
}

function SshField({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const { t } = useTranslation("agents");
  const { data: servers = [], isLoading } = useSshServers();
  if (!isLoading && servers.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed px-4 py-3.5">
        <Server className="size-5 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 basis-48 text-sm text-muted-foreground">{t("agentForm.ssh.empty")}</p>
        <Button type="button" variant="outline" size="sm" asChild>
          <Link to="/ssh?new=1">
            <Plus /> {t("agentForm.ssh.add")}
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
          {t("agentForm.ssh.canSignIn")}
        </span>
        <Link to="/ssh" className="flex items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground">
          {t("agentForm.ssh.manage")} <ArrowRight className="size-3" />
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
    </div>
  );
}

function WorkspaceField({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const { t } = useTranslation("agents");
  const { data: workspaces = [] } = useWorkspaces();
  return (
    <div className="space-y-1.5">
      <Label htmlFor="agent-workspace">{t("agentForm.workspace.label")}</Label>
      <Select value={value ?? "__global"} onValueChange={(v) => onChange(v === "__global" ? null : v)}>
        <SelectTrigger id="agent-workspace" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value="__global">🌐 {t("agentForm.workspace.global")}</SelectItem>
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

function ProjectField({ workspaceId, value, onChange }: { workspaceId: string | null; value: string | null; onChange: (v: string | null) => void }) {
  const { t } = useTranslation(["agents", "common"]);
  const { data: workspaces = [] } = useWorkspaces();
  const projects = workspaces.find((w) => w.id === workspaceId)?.projects ?? [];
  if (!projects.length) return null;
  return (
    <div className="space-y-1.5">
      <Label htmlFor="agent-project">
        {t("agentForm.project.label")} <span className="font-normal text-muted-foreground">({t("common:words.optional")})</span>
      </Label>
      <Select value={value && projects.some((p) => p.id === value) ? value : "__none"} onValueChange={(v) => onChange(v === "__none" ? null : v)}>
        <SelectTrigger id="agent-project" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value="__none">{t("agentForm.project.none")}</SelectItem>
          <SelectSeparator />
          {projects.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.icon} {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** "Reports to": its lead on the org chart (the built-in agent by default), and who it leads. Grants nothing. */
function TeamField({
  agentId,
  isDefault,
  workspaceId,
  value,
  onChange,
}: {
  agentId?: string;
  isDefault: boolean;
  workspaceId: string | null;
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const { t } = useTranslation("agents");
  const { data: agents = [] } = useAllAgents();
  const builtin = agents.find((a) => a.isDefault);
  const self = { id: agentId ?? "__new", workspaceId, isDefault, reportsTo: value };
  const team = agents.some((a) => a.id === self.id) ? agents.map((a) => (a.id === self.id ? { ...a, ...self } : a)) : [...agents, self];
  const leads = agents.filter((a) => !a.isDefault && a.id !== agentId && !leadProblem(self, a, team));
  const reports = agentId ? reportsOf(self, agents).filter((a) => a.id !== agentId) : [];
  const current = value ? agents.find((a) => a.id === value) : null;
  const [resetNote, setResetNote] = useState<string | null>(null);

  // A new workspace can put the chosen lead out of bounds: back to the built-in agent, and say why.
  const checkLead = useEffectEvent(() => {
    if (!current) return;
    if (leadProblem(self, current, team) === "workspace") {
      setResetNote(t("agentForm.team.resetNote", { lead: builtin?.name ?? "Godmode", name: current.name }));
      onChange(null);
    }
  });
  const currentId = current?.id;
  useEffect(() => {
    checkLead();
  }, [workspaceId, currentId]);

  if (isDefault) {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">{t("agentForm.team.builtinLeads", { name: builtin?.name ?? "Godmode" })}</p>
        <LedBy agents={reportsOf({ ...self, isDefault: true }, agents)} />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="agent-reports-to">{t("agentForm.team.reportsTo")}</Label>
        <Select
          value={value ?? "__builtin"}
          onValueChange={(v) => {
            setResetNote(null);
            onChange(v === "__builtin" ? null : v);
          }}
        >
          <SelectTrigger id="agent-reports-to" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value="__builtin">
              <span className="flex items-center gap-2">
                {builtin && <AgentAvatar agent={builtin} size="sm" still className="size-5" />}
                {builtin?.name ?? "Godmode"} <span className="text-muted-foreground">{t("agentForm.team.builtIn")}</span>
              </span>
            </SelectItem>
            {leads.length > 0 && <SelectSeparator />}
            {leads.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                <span className="flex min-w-0 items-center gap-2">
                  <AgentAvatar agent={a} size="sm" still className="size-5" />
                  <span className="truncate">{a.name}</span>
                  {(a.role || !a.enabled) && <span className="truncate text-muted-foreground">{[a.role, a.enabled ? "" : t("agentForm.switchedOff")].filter(Boolean).join(" · ")}</span>}
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
        {resetNote && <p className="text-xs text-muted-foreground">{resetNote}</p>}
      </div>
      <LedBy agents={reports} />
    </div>
  );
}

function LedBy({ agents }: { agents: Agent[] }) {
  const { t } = useTranslation("agents");
  if (!agents.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>{t("agentForm.team.leads")}</span>
      {agents.slice(0, 12).map((a) => (
        <Link key={a.id} to={`/agents/${a.id}`} title={[a.name, a.role].filter(Boolean).join(" · ")} className="rounded-md focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
          <AgentAvatar agent={a} size="sm" still className="size-6" />
        </Link>
      ))}
      {agents.length > 12 && <span>+{agents.length - 12}</span>}
      <Link to="/agents?view=chart" className="ml-1 underline-offset-2 hover:underline">
        {t("agentForm.team.orgChart")}
      </Link>
    </div>
  );
}

function ComputerDisplayField({ value, onChange, disabled }: { value: string | null; onChange: (v: string | null) => void; disabled?: boolean }) {
  const { t } = useTranslation("agents");
  const { data } = useQuery({ queryKey: qk.computerSources, queryFn: api.computer.sources, enabled: !disabled, staleTime: 30_000, retry: false });
  const displays = data?.displays ?? [];
  const known = value === null || displays.some((d) => d.id === value);
  return (
    <div className={cn("space-y-1.5 sm:max-w-sm", disabled && "pointer-events-none opacity-50")}>
      <Label htmlFor="agent-computer-display">{t("agentForm.computer.screen")}</Label>
      <Select value={value ?? "desktop"} onValueChange={(v) => onChange(v === "desktop" ? null : v)} disabled={disabled}>
        <SelectTrigger id="agent-computer-display" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="desktop">{displays.length > 1 ? t("agentForm.computer.entireDesktopCount", { count: displays.length }) : t("agentForm.computer.entireDesktop")}</SelectItem>
          {displays.map((d) => (
            <SelectItem key={d.id} value={d.id}>
              {d.primary ? t("agentForm.computer.primary", { name: d.name }) : d.name}
            </SelectItem>
          ))}
          {!known && value && <SelectItem value={value}>{t("agentForm.computer.disconnected", { id: value })}</SelectItem>}
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
  const { t } = useTranslation("agents");
  const { data: profiles = [], isLoading } = useQuery({ queryKey: [...qk.browserProfiles, "list"], queryFn: api.browser.profiles });
  const defaultId = defaultProfileFor(profiles, workspaceId)?.id;
  return (
    <div className="space-y-1.5">
      <Label htmlFor="agent-browser-profile">{t("agentForm.browser.profile")}</Label>
      <Select value={value ?? "__default"} onValueChange={(v) => onChange(v === "__default" ? null : v)} disabled={disabled || isLoading}>
        <SelectTrigger id="agent-browser-profile" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value="__default">{t("agentForm.browser.defaultProfile")}</SelectItem>
          {profiles.length > 0 && <SelectSeparator />}
          {profiles.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
              {p.id === defaultId && <span className="text-xs text-muted-foreground">{t("agentForm.browser.defaultTag")}</span>}
              {p.cookieCount > 0 && <span className="text-xs text-muted-foreground">{t("agentForm.browser.cookies", { count: p.cookieCount })}</span>}
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
  const { t: tr } = useTranslation("agents");
  const { data: tools = [], isLoading } = useApiTools();
  const [dialog, setDialog] = useState<ApiToolDialogState>(null);
  const available = tools.filter(
    (t) => t.enabled && (t.agentId ? t.agentId === agentId : inherit && (t.workspaceId === null || t.workspaceId === workspaceId)),
  );
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label>{tr("agentForm.tools.apiTools")}</Label>
        <Link to="/settings/integrations?tab=tools" className="text-xs font-medium text-muted-foreground underline-offset-[3px] hover:text-foreground hover:underline">
          {tr("agentForm.tools.manage")}
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
          {inherit ? tr("agentForm.tools.emptyInherit") : tr("agentForm.tools.emptyOwn")}
        </p>
      )}
      {agentId && (
        <Button type="button" size="sm" variant="outline" onClick={() => setDialog({ mode: "create", preset: null, scope: { workspaceId: savedWorkspaceId, agentId } })}>
          <Wrench /> {tr("agentForm.tools.addOwn")}
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
  const { t } = useTranslation("agents");
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
      <Label htmlFor="agent-mcp">{t("agentForm.tools.mcpLabel")}</Label>
      <MultiSelect
        id="agent-mcp"
        options={options}
        value={value}
        onChange={onChange}
        placeholder={options.length ? t("agentForm.tools.mcpPlaceholder") : t("agentForm.tools.mcpNone")}
        emptyText={t("agentForm.tools.mcpEmpty")}
      />
    </div>
  );
}
