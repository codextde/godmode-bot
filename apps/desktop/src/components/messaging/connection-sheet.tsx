import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { formatDistanceToNowStrict } from "date-fns";
import { Ban, Check, ChevronRight, ExternalLink, KeyRound, MessageSquare, MoreHorizontal, Trash2, TriangleAlert, Undo2, User, UserCheck, Users } from "lucide-react";
import { toast } from "sonner";
import type { Agent, MessagingConnection, MessagingConnectionPatch, MessagingUser, MessagingUserStatus } from "@godmode/shared";
import { AgentAvatar } from "@/components/common";
import { ConfirmDialog } from "@/components/integrations/confirm-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { isGrantCancelled, withGrant } from "@/components/vault/grant";
import { toastApiError } from "@/components/vault/vault-utils";
import { api, errorMessage } from "@/lib/api";
import { openExternal } from "@/lib/desktop";
import { useAllAgents } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { dateLocale, t } from "@/i18n";
import { AccessChooser, AgentChooser } from "./choosers";
import { CredentialFields, credentialsOf, EMPTY_FIELDS, type CredentialFieldValues } from "./connect-dialog";
import { botHandle, PLATFORMS, PlatformLogo, StatusPill } from "./platform";
import { TeamsFinishSteps } from "./teams-setup";

function ago(iso: string | null): string {
  if (!iso) return t("common:words.never");
  return formatDistanceToNowStrict(new Date(iso), { addSuffix: true, locale: dateLocale() });
}

function Block({ title, description, action, children }: { title: string; description?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">{title}</h3>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function useUpdateConnection() {
  const { t } = useTranslation(["messaging", "common"]);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: MessagingConnectionPatch }) =>
      withGrant((grant) => api.messaging.update(id, patch, grant), t("grantAnyone")),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: qk.messagingList });
      const prev = qc.getQueryData<MessagingConnection[]>(qk.messagingList);
      const { credentials: _c, publicUrl: _p, ...shown } = patch;
      qc.setQueryData<MessagingConnection[]>(qk.messagingList, (list) => list?.map((c) => (c.id === id ? { ...c, ...shown } : c)));
      return { prev };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.messagingList, ctx.prev);
      if (!isGrantCancelled(err)) toastApiError(err, t("common:errors.couldNotSave"), qc);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.messaging }),
  });
}

/** Everything about one bot: requests, agents, access, people, chats, setup. */
export function ConnectionSheet({ connection, onOpenChange }: { connection: MessagingConnection | null; onOpenChange: (open: boolean) => void }) {
  const [last, setLast] = useState(connection);
  if (connection && connection !== last) setLast(connection);
  const c = connection ?? last;
  return (
    <Sheet open={!!connection} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto p-0 sm:max-w-[560px]">{c && <SheetBody key={c.id} connection={c} onClose={() => onOpenChange(false)} />}</SheetContent>
    </Sheet>
  );
}

function SheetBody({ connection: c, onClose }: { connection: MessagingConnection; onClose: () => void }) {
  const { t } = useTranslation(["messaging", "common"]);
  const qc = useQueryClient();
  const agents = useAllAgents();
  const update = useUpdateConnection();
  const users = useQuery({ queryKey: qk.messagingUsers(c.id), queryFn: () => api.messaging.users(c.id) });
  const chats = useQuery({ queryKey: qk.messagingChats(c.id), queryFn: () => api.messaging.chats(c.id) });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const meta = PLATFORMS[c.provider];
  const handle = botHandle(c);

  const setUser = useMutation({
    mutationFn: ({ user, status }: { user: MessagingUser; status: MessagingUserStatus }) => api.messaging.setUser(c.id, user.id, status),
    onMutate: async ({ user, status }) => {
      await qc.cancelQueries({ queryKey: qk.messagingUsers(c.id) });
      qc.setQueryData<MessagingUser[]>(qk.messagingUsers(c.id), (list) => list?.map((u) => (u.id === user.id ? { ...u, status } : u)));
    },
    onSuccess: (u, { status }) => {
      if (status === "approved") toast.success(t("sheet.approvedToast", { name: u.name }), { description: t("sheet.approvedToastDescription") });
      if (status === "blocked") toast(t("sheet.blockedToast", { name: u.name }), { description: t("sheet.blockedToastDescription") });
    },
    onError: (err) => toastApiError(err, t("sheet.couldNotUpdate"), qc),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.messaging });
      void qc.invalidateQueries({ queryKey: qk.bootstrap });
    },
  });

  const setOwner = useMutation({
    mutationFn: ({ user, isOwner }: { user: MessagingUser; isOwner: boolean }) => api.messaging.setOwner(c.id, user.id, isOwner),
    onSuccess: (u, { isOwner }) => {
      if (isOwner) toast.success(t("sheet.ownerToast", { name: u.name }), { description: t("sheet.ownerToastDescription") });
      else toast(t("sheet.notOwnerToast", { name: u.name }), { description: t("sheet.notOwnerToastDescription") });
    },
    onError: (err) => toastApiError(err, t("sheet.couldNotUpdate"), qc),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.messagingUsers(c.id) }),
  });

  const forget = useMutation({
    mutationFn: (user: MessagingUser) => api.messaging.removeUser(c.id, user.id),
    onSuccess: (_r, u) => toast(t("sheet.forgotToast", { name: u.name }), { description: t("sheet.forgotToastDescription") }),
    onError: (err) => toastApiError(err, t("sheet.couldNotRemove"), qc),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.messaging }),
  });

  const remove = useMutation({
    mutationFn: () => api.messaging.delete(c.id),
    onSuccess: () => {
      toast.success(t("sheet.disconnectedToast", { name: c.name }));
      onClose();
    },
    onError: (err) => toastApiError(err, t("sheet.couldNotDisconnect"), qc),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.messaging });
      void qc.invalidateQueries({ queryKey: qk.bootstrap });
    },
  });

  const list = users.data ?? [];
  const pending = c.access === "approved" ? list.filter((u) => u.status === "pending") : [];
  const people = list.filter((u) => !pending.includes(u));
  const agentById = new Map((agents.data ?? []).map((a) => [a.id, a]));

  return (
    <>
      <SheetHeader className="gap-0 border-b px-6 pt-6 pb-5">
        <div className="flex items-start gap-3.5 pr-8">
          <PlatformLogo provider={c.provider} size="lg" />
          <div className="min-w-0 flex-1">
            <SheetTitle className="truncate text-lg font-medium tracking-[-0.02em]">{c.name}</SheetTitle>
            <SheetDescription className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>{[meta.label, handle].filter(Boolean).join(" · ")}</span>
              <StatusPill connection={c} />
            </SheetDescription>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-2">
          <label className="flex flex-1 items-center gap-2.5 text-sm">
            <Switch checked={c.enabled} onCheckedChange={(enabled) => update.mutate({ id: c.id, patch: { enabled } })} aria-label={c.enabled ? t("sheet.turnOff") : t("sheet.turnOn")} />
            {c.enabled ? t("card.answering") : t("card.turnedOff")}
          </label>
          {c.bot.url && (
            <Button size="sm" variant="outline" onClick={() => void openExternal(c.bot.url!)}>
              <ExternalLink /> {t("sheet.openIn", { platform: c.provider === "teams" ? "Teams" : meta.label })}
            </Button>
          )}
        </div>
      </SheetHeader>

      <div className="space-y-8 px-6 py-6">
        {c.status.state === "error" && c.status.message && (
          <p className="flex items-start gap-2.5 rounded-xl border border-destructive/30 bg-destructive/5 px-3.5 py-3 text-sm" role="alert">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
            <span>{c.status.message}</span>
          </p>
        )}

        <AnimatePresence initial={false}>
          {pending.length > 0 && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
              <Block title={t("sheet.waitingTitle", { count: pending.length })} description={t("sheet.waitingDescription")}>
                <ul className="space-y-2">
                  {pending.map((u) => (
                    <li key={u.id} className="flex items-center gap-3 rounded-xl border border-brand/30 bg-brand-soft/40 p-3">
                      <Initials name={u.name} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{u.name}</p>
                        <p className="truncate text-xs text-muted-foreground">{[u.username && `@${u.username}`, t("sheet.wrote", { time: ago(u.lastSeenAt) })].filter(Boolean).join(" · ")}</p>
                      </div>
                      <Button size="sm" variant="ghost" onClick={() => setUser.mutate({ user: u, status: "blocked" })}>
                        {t("sheet.block")}
                      </Button>
                      <Button size="sm" onClick={() => setUser.mutate({ user: u, status: "approved" })}>
                        <Check /> {t("sheet.approve")}
                      </Button>
                    </li>
                  ))}
                </ul>
              </Block>
            </motion.div>
          )}
        </AnimatePresence>

        <Block title={t("common:words.agents")} description={t("sheet.agentsDescription")}>
          {agents.isLoading ? (
            <Skeleton className="h-32 rounded-xl" />
          ) : (
            <AgentChooser
              agents={agents.data ?? []}
              value={c.agentIds}
              defaultId={c.defaultAgentId}
              disabled={update.isPending}
              onChange={(agentIds, defaultAgentId) => {
                if (!agentIds.length) {
                  toast(t("sheet.keepOneAgent"), { description: t("sheet.keepOneAgentDescription") });
                  return;
                }
                update.mutate({ id: c.id, patch: { agentIds, defaultAgentId } });
              }}
            />
          )}
        </Block>

        <Block title={t("whoCanTalk")}>
          <AccessChooser provider={c.provider} team={c.bot.team} value={c.access} onChange={(access) => access !== c.access && update.mutate({ id: c.id, patch: { access } })} />
        </Block>

        {c.provider === "teams" && <TeamsBlock connection={c} />}

        <Block title={t("sheet.people")} description={people.length ? undefined : t("sheet.peopleEmpty")}>
          {users.isLoading ? (
            <Skeleton className="h-16 rounded-xl" />
          ) : people.length > 0 ? (
            <ul className="divide-y rounded-xl border bg-card shadow-card">
              {people.map((u) => (
                <li key={u.id} className="flex items-center gap-3 px-3.5 py-2.5">
                  <Initials name={u.name} muted={u.status === "blocked"} />
                  <div className="min-w-0 flex-1">
                    <p className={cn("truncate text-sm", u.status === "blocked" && "text-muted-foreground line-through decoration-muted-foreground/40")}>{u.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{[u.username && `@${u.username}`, t("sheet.active", { time: ago(u.lastSeenAt) })].filter(Boolean).join(" · ")}</p>
                  </div>
                  <PersonStatus user={u} access={c.access} />
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="icon-sm" variant="ghost" aria-label={t("sheet.actionsFor", { name: u.name })}>
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {u.status !== "approved" && (
                        <DropdownMenuItem onClick={() => setUser.mutate({ user: u, status: "approved" })}>
                          <Check /> {t("sheet.approve")}
                        </DropdownMenuItem>
                      )}
                      {u.status === "approved" && (
                        <DropdownMenuItem onClick={() => setUser.mutate({ user: u, status: "pending" })}>
                          <Undo2 /> {t("sheet.takeBackAccess")}
                        </DropdownMenuItem>
                      )}
                      {u.status !== "blocked" && (
                        <DropdownMenuItem onClick={() => setUser.mutate({ user: u, status: "blocked" })}>
                          <Ban /> {t("sheet.block")}
                        </DropdownMenuItem>
                      )}
                      {u.status !== "blocked" && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => setOwner.mutate({ user: u, isOwner: !u.isOwner })}>
                            <UserCheck /> {u.isOwner ? t("sheet.notMe") : t("sheet.isMe")}
                          </DropdownMenuItem>
                        </>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onClick={() => forget.mutate(u)}>
                        <Trash2 /> {t("sheet.forget")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              ))}
            </ul>
          ) : null}
        </Block>

        <Block title={t("sheet.recentChats")}>
          {chats.isLoading ? (
            <Skeleton className="h-16 rounded-xl" />
          ) : chats.data?.length ? (
            <ul className="divide-y rounded-xl border bg-card shadow-card">
              {chats.data.map((chat) => {
                const agent = chat.agentId ? agentById.get(chat.agentId) : undefined;
                const row = (
                  <>
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg border bg-paper-2 text-muted-foreground">
                      {chat.kind === "direct" ? <User className="size-4" /> : <Users className="size-4" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{chat.title || (chat.kind === "direct" ? t("sheet.directMessage") : t("sheet.group"))}</span>
                      <span className="block truncate text-xs text-muted-foreground">{agent ? t("sheet.withAgent", { name: agent.name }) : "—"} · {ago(chat.lastMessageAt)}</span>
                    </span>
                    {agent && <AgentAvatar agent={agent as Agent} size="sm" />}
                    {chat.conversationId && <ChevronRight className="size-4 text-muted-foreground/60" />}
                  </>
                );
                return (
                  <li key={chat.id}>
                    {chat.conversationId ? (
                      <Link to={`/chat/${chat.conversationId}`} onClick={onClose} className="flex items-center gap-3 px-3.5 py-2.5 transition hover:bg-accent/40">
                        {row}
                      </Link>
                    ) : (
                      <div className="flex items-center gap-3 px-3.5 py-2.5">{row}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="flex items-center gap-2 rounded-xl border border-dashed px-3.5 py-3 text-sm text-muted-foreground">
              <MessageSquare className="size-4" /> {t("sheet.noChats")}
            </p>
          )}
        </Block>

        <TokensBlock connection={c} />

        <div className="flex items-center justify-between gap-3 rounded-xl border border-destructive/25 px-3.5 py-3">
          <div>
            <p className="text-sm font-medium">{t("sheet.disconnect")}</p>
            <p className="text-xs text-muted-foreground">{t("sheet.disconnectDescription")}</p>
          </div>
          <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)}>
            <Trash2 /> {t("sheet.disconnect")}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("sheet.disconnectConfirmTitle", { name: c.name })}
        description={t("sheet.disconnectConfirmDescription", { platform: meta.label })}
        confirmLabel={t("sheet.disconnect")}
        onConfirm={() => remove.mutate()}
      />
    </>
  );
}

function Initials({ name, muted }: { name: string; muted?: boolean }) {
  const letters =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "?";
  return (
    <span className={cn("grid size-8 shrink-0 place-items-center rounded-full border bg-paper-2 text-[11px] font-medium tracking-wide", muted && "opacity-50")}>
      {letters}
    </span>
  );
}

function PersonStatus({ user, access }: { user: MessagingUser; access: MessagingConnection["access"] }) {
  const { t } = useTranslation("messaging");
  if (user.status === "blocked") return <span className="text-[11px] text-destructive">{t("person.blocked")}</span>;
  if (user.isOwner) {
    return (
      <span className="rounded-full bg-brand-soft px-1.5 py-0.5 text-[11px] font-medium text-brand-strong" title={t("person.youTitle")}>
        {t("person.you")}
      </span>
    );
  }
  if (user.status === "approved") return <span className="text-[11px] text-muted-foreground">{t("person.approved")}</span>;
  return access === "anyone" ? <span className="text-[11px] text-muted-foreground">{t("person.openAccess")}</span> : null;
}

function TeamsBlock({ connection: c }: { connection: MessagingConnection }) {
  const { t } = useTranslation(["messaging", "common"]);
  const update = useUpdateConnection();
  const [url, setUrl] = useState(c.config.publicUrl ?? "");
  useEffect(() => setUrl(c.config.publicUrl ?? ""), [c.config.publicUrl]);
  const dirty = url.trim() !== (c.config.publicUrl ?? "");
  return (
    <Block title={t("sheet.teamsSetup")} description={t("sheet.teamsSetupDescription")}>
      <div className="space-y-4 rounded-xl border bg-card p-4 shadow-card">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty) update.mutate({ id: c.id, patch: { publicUrl: url } });
          }}
        >
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://godmode.example.com" aria-label={t("sheet.publicAddress")} className="h-9" />
          <Button type="submit" size="sm" variant={dirty ? "default" : "outline"} disabled={!dirty || update.isPending} className="h-9">
            {t("common:actions.save")}
          </Button>
        </form>
        <TeamsFinishSteps connection={c} />
      </div>
    </Block>
  );
}

function TokensBlock({ connection: c }: { connection: MessagingConnection }) {
  const { t } = useTranslation(["messaging", "common"]);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const prefilled: CredentialFieldValues = { ...EMPTY_FIELDS, appId: c.config.appId ?? "", tenantId: c.config.tenantId ?? "" };
  const [fields, setFields] = useState<CredentialFieldValues>(prefilled);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const credentials = credentialsOf(c.provider, fields);
      if (!credentials) throw new Error(t("sheet.fillEveryField"));
      return api.messaging.update(c.id, { credentials });
    },
    onSuccess: () => {
      toast.success(t("sheet.tokensReplaced"), { description: t("sheet.tokensReplacedDescription") });
      setOpen(false);
      setFields(prefilled);
      setError(null);
    },
    onError: (err) => setError(errorMessage(err)),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.messaging }),
  });
  return (
    <Block
      title={t("sheet.tokens")}
      description={t("sheet.tokensDescription")}
      action={
        !open && (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            <KeyRound /> {t("sheet.replace")}
          </Button>
        )
      }
    >
      {open && (
        <div className="space-y-4 rounded-xl border bg-card p-4 shadow-card">
          <CredentialFields
            provider={c.provider}
            fields={fields}
            set={(key) => (value) => {
              setFields((f) => ({ ...f, [key]: value }));
              setError(null);
            }}
            onSubmit={() => save.mutate()}
            withPublicUrl={false}
          />
          {error && (
            <p className="flex items-start gap-2 text-sm text-destructive" role="alert">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" /> {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              {t("common:actions.cancel")}
            </Button>
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || !credentialsOf(c.provider, fields)}>
              {save.isPending && <Spinner />} {t("sheet.checkAndSave")}
            </Button>
          </div>
        </div>
      )}
    </Block>
  );
}
