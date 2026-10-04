import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, ArrowRight, Check, Copy, ExternalLink, Info, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import type { MessagingAccess, MessagingConnection, MessagingCredentials, MessagingProvider, MessagingVerifyResult } from "@godmode/shared";
import { SLACK_COMMAND, slackManifest } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { DrawCheck } from "@/components/aicss/Motion";
import { copyText } from "@/components/chat/copy-button";
import { PasswordInput } from "@/components/vault/password-input";
import { isGrantCancelled, withGrant } from "@/components/vault/grant";
import { isVaultLocked, toastApiError } from "@/components/vault/vault-utils";
import { api, errorMessage } from "@/lib/api";
import { cloudContext, coreUrl } from "@/lib/core";
import { openExternal } from "@/lib/desktop";
import { useAllAgents } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { AccessChooser, AgentChooser } from "./choosers";
import { PLATFORMS, PlatformLogo } from "./platform";
import { TeamsFinishSteps } from "./teams-setup";

type Step = "setup" | "tokens" | "agents" | "done";
const STEPS: { id: Step; label: string }[] = [
  { id: "setup", label: "Create the bot" },
  { id: "tokens", label: "Connect" },
  { id: "agents", label: "Agents" },
];

interface Fields {
  botToken: string;
  appToken: string;
  appId: string;
  tenantId: string;
  appPassword: string;
  publicUrl: string;
}

const EMPTY: Fields = { botToken: "", appToken: "", appId: "", tenantId: "", appPassword: "", publicUrl: "" };

function credentialsOf(provider: MessagingProvider, f: Fields): MessagingCredentials | null {
  if (provider === "telegram") return f.botToken.trim() ? { provider, botToken: f.botToken.trim() } : null;
  if (provider === "slack") return f.botToken.trim() && f.appToken.trim() ? { provider, botToken: f.botToken.trim(), appToken: f.appToken.trim() } : null;
  return f.appId.trim() && f.tenantId.trim() && f.appPassword ? { provider, appId: f.appId.trim(), tenantId: f.tenantId.trim(), appPassword: f.appPassword } : null;
}

export function slackCreateUrl(name = "Godmode"): string {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(slackManifest(name)))}`;
}

/** Connect a bot: make it on the platform, paste its tokens, choose its agents. */
export function ConnectDialog({
  provider,
  onOpenChange,
  onOpenConnection,
}: {
  provider: MessagingProvider | null;
  onOpenChange: (open: boolean) => void;
  onOpenConnection: (id: string) => void;
}) {
  const [shown, setShown] = useState<MessagingProvider | null>(provider);
  const [openedFor, setOpenedFor] = useState<MessagingProvider | null>(null);
  const [step, setStep] = useState<Step>("setup");
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [verified, setVerified] = useState<MessagingVerifyResult | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [access, setAccess] = useState<MessagingAccess>("approved");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<MessagingConnection | null>(null);
  const agents = useAllAgents();
  const qc = useQueryClient();

  const preselect = () => {
    const first = agents.data?.find((a) => a.isDefault) ?? agents.data?.[0];
    setAgentIds(first ? [first.id] : []);
    setDefaultId(first?.id ?? null);
  };
  // Every opening starts fresh; while closing, the last platform stays on screen.
  if (provider !== openedFor) {
    setOpenedFor(provider);
    if (provider) {
      setShown(provider);
      setStep("setup");
      setFields(EMPTY);
      setVerified(null);
      setVerifyError(null);
      setAccess("approved");
      setName("");
      setCreated(null);
      preselect();
    }
  }
  const loaded = !!agents.data;
  useEffect(() => {
    if (loaded && provider && !agentIds.length) preselect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);
  const p = provider ?? shown;
  if (!p) return null;
  const meta = PLATFORMS[p];
  const credentials = credentialsOf(p, fields);

  const set = (key: keyof Fields) => (value: string) => {
    setFields((f) => ({ ...f, [key]: value }));
    if (key !== "publicUrl") {
      setVerified(null);
      setVerifyError(null);
    }
  };

  const check = async () => {
    if (!credentials) return;
    setChecking(true);
    setVerifyError(null);
    try {
      const result = await api.messaging.verify(credentials);
      setVerified(result);
      if (!name) setName(result.bot.name);
    } catch (err) {
      setVerifyError(errorMessage(err));
    } finally {
      setChecking(false);
    }
  };

  const connect = async () => {
    if (!credentials || !agentIds.length) return;
    setSaving(true);
    try {
      const input = {
        credentials,
        name: name.trim() || undefined,
        agentIds,
        defaultAgentId: defaultId,
        access,
        ...(p === "teams" ? { publicUrl: fields.publicUrl } : {}),
      };
      const conn = await withGrant((grant) => api.messaging.create(input, grant), "Letting anyone use your agents needs your vault passphrase.");
      setCreated(conn);
      setStep("done");
      void qc.invalidateQueries({ queryKey: qk.messaging });
      toast.success(`${conn.name} is connected`);
    } catch (err) {
      if (isGrantCancelled(err)) return;
      if (isVaultLocked(err)) toastApiError(err, "", qc);
      else toast.error("Couldn't connect the bot", { description: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  };

  const index = STEPS.findIndex((s) => s.id === step);

  return (
    <Dialog open={!!provider} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="flex-row items-center gap-3.5 space-y-0 border-b px-6 pt-6 pb-5 text-left">
          <PlatformLogo provider={p} size="lg" />
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-lg tracking-[-0.02em]">{step === "done" ? "You're connected" : `Connect ${meta.label}`}</DialogTitle>
            <DialogDescription className="mt-0.5">
              {step === "done" ? "Your agents now answer there." : "Talk to your agents right where you already chat."}
            </DialogDescription>
          </div>
        </DialogHeader>

        {step !== "done" && (
          <ol className="flex items-center gap-2 border-b bg-paper-2/50 px-6 py-2.5" aria-label="Steps">
            {STEPS.map((s, i) => (
              <li key={s.id} className="flex items-center gap-2 text-xs">
                {i > 0 && <span className="h-px w-5 bg-border" />}
                <span
                  className={cn(
                    "grid size-[18px] place-items-center rounded-full border font-mono text-[10px]",
                    i < index && "border-foreground bg-foreground text-background",
                    i === index && "border-foreground text-foreground",
                    i > index && "text-muted-foreground",
                  )}
                >
                  {i < index ? <Check className="size-2.5" strokeWidth={3} /> : i + 1}
                </span>
                <span className={cn(i === index ? "font-medium text-foreground" : "text-muted-foreground")} aria-current={i === index ? "step" : undefined}>
                  {s.label}
                </span>
              </li>
            ))}
          </ol>
        )}

        <div className="max-h-[min(62vh,560px)] overflow-y-auto px-6 py-5">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={step} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }} transition={{ duration: 0.16 }}>
              {step === "setup" && <SetupGuide provider={p} />}
              {step === "tokens" && (
                <div className="space-y-4">
                  <CredentialFields provider={p} fields={fields} set={set} onSubmit={() => void check()} />
                  {verifyError && (
                    <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
                      <TriangleAlert className="mt-0.5 size-4 shrink-0" /> {verifyError}
                    </p>
                  )}
                  {verified && <BotCard provider={p} result={verified} />}
                </div>
              )}
              {step === "agents" && (
                <div className="space-y-5">
                  <div className="space-y-1.5">
                    <Label htmlFor="bot-name">Name in Godmode</Label>
                    <Input id="bot-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={verified?.bot.name} maxLength={100} />
                  </div>
                  <div className="space-y-2">
                    <div>
                      <p className="text-sm font-medium">Agents people can talk to</p>
                      <p className="text-xs text-muted-foreground">
                        Chats start with the first one; people switch with <code className="font-mono">{p === "slack" ? `${SLACK_COMMAND} agent` : "/agent"}</code>.
                      </p>
                    </div>
                    <AgentChooser
                      agents={agents.data ?? []}
                      value={agentIds}
                      defaultId={defaultId}
                      onChange={(ids, d) => {
                        setAgentIds(ids);
                        setDefaultId(d);
                      }}
                    />
                  </div>
                  <div className="space-y-2">
                    <p className="text-sm font-medium">Who can talk to it</p>
                    <AccessChooser provider={p} team={verified?.bot.team ?? null} value={access} onChange={setAccess} />
                  </div>
                </div>
              )}
              {step === "done" && created && <Done connection={created} />}
            </motion.div>
          </AnimatePresence>
        </div>

        <DialogFooter className="flex-row items-center justify-between border-t bg-paper-2/40 px-6 py-3.5 sm:justify-between">
          {step === "done" && created ? (
            <>
              <Button variant="ghost" onClick={() => onOpenConnection(created.id)}>
                Bot settings
              </Button>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </>
          ) : (
            <>
              {index > 0 ? (
                <Button variant="ghost" onClick={() => setStep(STEPS[index - 1]!.id)} disabled={saving}>
                  <ArrowLeft /> Back
                </Button>
              ) : (
                <span />
              )}
              {step === "setup" && (
                <Button onClick={() => setStep("tokens")}>
                  I have the {p === "teams" ? "details" : p === "slack" ? "tokens" : "token"} <ArrowRight />
                </Button>
              )}
              {step === "tokens" &&
                (verified ? (
                  <Button onClick={() => setStep("agents")} disabled={p === "teams" && !fields.publicUrl.trim()}>
                    Continue <ArrowRight />
                  </Button>
                ) : (
                  <Button onClick={() => void check()} disabled={!credentials || checking}>
                    {checking ? <Spinner /> : null} Check
                  </Button>
                ))}
              {step === "agents" && (
                <Button onClick={() => void connect()} disabled={!agentIds.length || saving}>
                  {saving ? <Spinner /> : null} Connect {meta.label}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GuideStep({ n, children, action }: { n: number; children: ReactNode; action?: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-px grid size-5 shrink-0 place-items-center rounded-full border bg-card font-mono text-[10.5px] text-muted-foreground">{n}</span>
      <div className="min-w-0 flex-1 space-y-2 text-sm leading-relaxed">
        <div>{children}</div>
        {action}
      </div>
    </li>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <code className="rounded-[4px] border bg-paper-2 px-1 py-px font-mono text-[12px]">{children}</code>;
}

function SetupGuide({ provider }: { provider: MessagingProvider }) {
  const [copied, setCopied] = useState(false);
  if (provider === "telegram") {
    return (
      <ol className="space-y-4">
        <GuideStep
          n={1}
          action={
            <Button size="sm" variant="outline" onClick={() => void openExternal("https://t.me/BotFather")}>
              <ExternalLink /> Open @BotFather
            </Button>
          }
        >
          Open <strong className="font-medium">@BotFather</strong>, Telegram's bot for making bots.
        </GuideStep>
        <GuideStep n={2}>
          Send <Mono>/newbot</Mono>, then pick a display name and a username that ends in <Mono>bot</Mono>.
        </GuideStep>
        <GuideStep n={3}>
          BotFather answers with a token like <Mono>123456789:AAE…</Mono> — copy it for the next step.
        </GuideStep>
      </ol>
    );
  }
  if (provider === "slack") {
    return (
      <ol className="space-y-4">
        <GuideStep
          n={1}
          action={
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void openExternal(slackCreateUrl())}>
                <ExternalLink /> Create the Slack app
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  if (await copyText(JSON.stringify(slackManifest("Godmode"), null, 2))) {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }
                }}
              >
                {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy manifest"}
              </Button>
            </div>
          }
        >
          Create the app from Godmode's manifest — it brings the permissions, Socket Mode and the <Mono>{SLACK_COMMAND}</Mono> command. Pick your workspace and confirm.
        </GuideStep>
        <GuideStep n={2}>
          <strong className="font-medium">Install App</strong> → Install to your workspace, then copy the <strong className="font-medium">Bot User OAuth Token</strong> (<Mono>xoxb-…</Mono>).
        </GuideStep>
        <GuideStep n={3}>
          <strong className="font-medium">Basic Information → App-Level Tokens</strong> → Generate a token with the <Mono>connections:write</Mono> scope and copy it (<Mono>xapp-…</Mono>).
        </GuideStep>
        <p className="flex items-start gap-2 rounded-lg border bg-paper-2 px-3 py-2.5 text-xs text-muted-foreground">
          <Info className="mt-px size-3.5 shrink-0" />
          Socket Mode keeps the connection outgoing: Slack never needs to reach this computer.
        </p>
      </ol>
    );
  }
  return (
    <ol className="space-y-4">
      <GuideStep
        n={1}
        action={
          <Button size="sm" variant="outline" onClick={() => void openExternal("https://portal.azure.com/#create/Microsoft.AzureBot")}>
            <ExternalLink /> Create an Azure Bot
          </Button>
        }
      >
        In the Azure portal, create an <strong className="font-medium">Azure Bot</strong> with type <strong className="font-medium">Single Tenant</strong>. Note its Microsoft App ID and your tenant ID.
      </GuideStep>
      <GuideStep n={2}>
        <strong className="font-medium">Configuration → Manage Password</strong> → New client secret, and copy its <strong className="font-medium">Value</strong>.
      </GuideStep>
      <GuideStep n={3}>
        <strong className="font-medium">Channels</strong> → add <strong className="font-medium">Microsoft Teams</strong>.
      </GuideStep>
      <GuideStep n={4}>
        Teams delivers messages over https, so Godmode needs a public address — a tunnel like <Mono>cloudflared</Mono> or <Mono>ngrok</Mono> pointing at{" "}
        {/* Through Godmode Cloud this page's host is the cloud's, never the computer's. */}
        {cloudContext ? "Godmode on that computer" : <Mono>{new URL(coreUrl("/")).host}</Mono>}, or a server. You'll get the messaging endpoint for Azure
        after connecting.
      </GuideStep>
    </ol>
  );
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function CredentialFields({
  provider,
  fields,
  set,
  onSubmit,
  withPublicUrl = true,
}: {
  provider: MessagingProvider;
  fields: Fields;
  set: (key: keyof Fields) => (value: string) => void;
  onSubmit: () => void;
  withPublicUrl?: boolean;
}) {
  const submit = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onSubmit();
    }
  };
  if (provider === "telegram") {
    return (
      <Field id="tg-token" label="Bot token" hint="From @BotFather. Stored encrypted in your vault.">
        <PasswordInput id="tg-token" value={fields.botToken} onChange={(e) => set("botToken")(e.target.value)} onKeyDown={submit} placeholder="123456789:AAE…" autoFocus />
      </Field>
    );
  }
  if (provider === "slack") {
    return (
      <div className="space-y-4">
        <Field id="slack-bot" label="Bot User OAuth Token" hint="OAuth & Permissions → starts with xoxb-">
          <PasswordInput id="slack-bot" value={fields.botToken} onChange={(e) => set("botToken")(e.target.value)} onKeyDown={submit} placeholder="xoxb-…" autoFocus />
        </Field>
        <Field id="slack-app" label="App-Level Token" hint="Basic Information → App-Level Tokens → starts with xapp-">
          <PasswordInput id="slack-app" value={fields.appToken} onChange={(e) => set("appToken")(e.target.value)} onKeyDown={submit} placeholder="xapp-…" />
        </Field>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="teams-app" label="Microsoft App ID">
          <Input id="teams-app" value={fields.appId} onChange={(e) => set("appId")(e.target.value)} onKeyDown={submit} placeholder="1f2e3d4c-…" className="h-10 font-mono text-[13px]" autoFocus />
        </Field>
        <Field id="teams-tenant" label="Tenant ID">
          <Input id="teams-tenant" value={fields.tenantId} onChange={(e) => set("tenantId")(e.target.value)} onKeyDown={submit} placeholder="72f988bf-…" className="h-10 font-mono text-[13px]" />
        </Field>
      </div>
      <Field id="teams-secret" label="Client secret" hint="The secret's Value (not its ID). Stored encrypted in your vault.">
        <PasswordInput id="teams-secret" value={fields.appPassword} onChange={(e) => set("appPassword")(e.target.value)} onKeyDown={submit} />
      </Field>
      {withPublicUrl && (
        <Field id="teams-url" label="Public address of this Godmode" hint="https, reachable from the internet — a tunnel or your server.">
          <Input id="teams-url" value={fields.publicUrl} onChange={(e) => set("publicUrl")(e.target.value)} placeholder="https://godmode.example.com" className="h-10" />
        </Field>
      )}
    </div>
  );
}

export { EMPTY as EMPTY_FIELDS, credentialsOf, type Fields as CredentialFieldValues };

function BotCard({ provider, result }: { provider: MessagingProvider; result: MessagingVerifyResult }) {
  const { bot } = result;
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="space-y-2">
      <div className="flex items-center gap-3 rounded-xl border bg-card p-3.5 shadow-card">
        <PlatformLogo provider={provider} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{bot.name}</p>
          <p className="truncate text-xs text-muted-foreground">{[bot.username && provider === "telegram" ? `@${bot.username}` : null, bot.team].filter(Boolean).join(" · ") || "Credentials work"}</p>
        </div>
        <span className="inline-flex items-center gap-1 rounded-[5px] bg-brand-soft px-1.5 py-0.5 text-[11px] font-medium text-brand-strong">
          <Check className="size-3" strokeWidth={3} /> Verified
        </span>
      </div>
      {result.warnings.map((w) => (
        <p key={w} className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-foreground/80">
          <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" /> {w}
        </p>
      ))}
    </motion.div>
  );
}

function Done({ connection: c }: { connection: MessagingConnection }) {
  const handle = c.provider === "telegram" && c.bot.username ? `@${c.bot.username}` : c.name;
  return (
    <div className="space-y-5">
      <div className="flex flex-col items-center py-2 text-center">
        <span className="grid size-12 place-items-center rounded-full bg-brand-soft text-brand-strong">
          <DrawCheck className="size-6" />
        </span>
        <p className="mt-3 text-base font-medium tracking-[-0.01em]">{handle} is live</p>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          {c.access === "approved"
            ? "Send it a message. The first time, you approve yourself here — that's how strangers stay out."
            : "Send it a message — your agents answer right there."}
        </p>
      </div>
      {c.provider === "teams" ? (
        <TeamsFinishSteps connection={c} />
      ) : (
        c.bot.url && (
          <div className="flex justify-center">
            <Button onClick={() => void openExternal(c.bot.url!)}>
              <ExternalLink /> Open {c.provider === "telegram" ? handle : "Slack"}
            </Button>
          </div>
        )
      )}
      {c.provider === "slack" && (
        <p className="text-center text-xs text-muted-foreground">
          In channels, invite it with <Mono>/invite @{c.bot.username ?? "Godmode"}</Mono> and mention it.
        </p>
      )}
    </div>
  );
}
