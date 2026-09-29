import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { formatDistanceToNowStrict } from "date-fns";
import { Ban, Check, ChevronRight, ExternalLink, KeyRound, MessageSquare, MoreHorizontal, Trash2, TriangleAlert, Undo2, User, Users } from "lucide-react";
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
import { AccessChooser, AgentChooser } from "./choosers";
import { CredentialFields, credentialsOf, EMPTY_FIELDS, type CredentialFieldValues } from "./connect-dialog";
import { botHandle, PLATFORMS, PlatformLogo, StatusPill } from "./platform";
import { TeamsFinishSteps } from "./teams-setup";

function ago(iso: string | null): string {
  if (!iso) return "never";
  return formatDistanceToNowStrict(new Date(iso), { addSuffix: true });
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
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: MessagingConnectionPatch }) =>
      withGrant((grant) => api.messaging.update(id, patch, grant), "Letting anyone use your agents needs your vault passphrase."),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: qk.messagingList });
      const prev = qc.getQueryData<MessagingConnection[]>(qk.messagingList);
      const { credentials: _c, publicUrl: _p, ...shown } = patch;
      qc.setQueryData<MessagingConnection[]>(qk.messagingList, (list) => list?.map((c) => (c.id === id ? { ...c, ...shown } : c)));
      return { prev };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.messagingList, ctx.prev);
      if (!isGrantCancelled(err)) toastApiError(err, "Couldn't save", qc);
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
      if (status === "approved") toast.success(`${u.name} can talk to your agents`, { description: "The bot lets them know in their direct chat." });
      if (status === "blocked") toast(`${u.name} is blocked`, { description: "Their messages are ignored." });
    },
    onError: (err) => toastApiError(err, "Couldn't update", qc),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.messaging });
      void qc.invalidateQueries({ queryKey: qk.bootstrap });
    },
  });

  const forget = useMutation({
    mutationFn: (user: MessagingUser) => api.messaging.removeUser(c.id, user.id),
    onSuccess: (_r, u) => toast(`Forgot ${u.name}`, { description: "If they write again, they'll ask for access." }),
    onError: (err) => toastApiError(err, "Couldn't remove", qc),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.messaging }),
  });

  const remove = useMutation({
    mutationFn: () => api.messaging.delete(c.id),
    onSuccess: () => {
      toast.success(`${c.name} disconnected`);
      onClose();
    },
    onError: (err) => toastApiError(err, "Couldn't disconnect", qc),
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
            <Switch checked={c.enabled} onCheckedChange={(enabled) => update.mutate({ id: c.id, patch: { enabled } })} aria-label={c.enabled ? "Turn off" : "Turn on"} />
            {c.enabled ? "Answering messages" : "Turned off"}
          </label>
          {c.bot.url && (
            <Button size="sm" variant="outline" onClick={() => void openExternal(c.bot.url!)}>
              <ExternalLink /> Open in {c.provider === "teams" ? "Teams" : meta.label}
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
              <Block title={`Waiting for you · ${pending.length}`} description="They wrote to the bot and can't reach your agents until you let them in.">
                <ul className="space-y-2">
                  {pending.map((u) => (
                    <li key={u.id} className="flex items-center gap-3 rounded-xl border border-brand/30 bg-brand-soft/40 p-3">
                      <Initials name={u.name} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{u.name}</p>
                        <p className="truncate text-xs text-muted-foreground">{[u.username && `@${u.username}`, `wrote ${ago(u.lastSeenAt)}`].filter(Boolean).join(" · ")}</p>
                      </div>
                      <Button size="sm" variant="ghost" onClick={() => setUser.mutate({ user: u, status: "blocked" })}>
                        Block
                      </Button>
                      <Button size="sm" onClick={() => setUser.mutate({ user: u, status: "approved" })}>
                        <Check /> Approve
                      </Button>
                    </li>
                  ))}
                </ul>
              </Block>
            </motion.div>
          )}
        </AnimatePresence>

        <Block title="Agents" description="Who people reach through this bot. New chats start with the first one.">
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
                  toast("Keep at least one agent", { description: "Turn the bot off instead if nobody should answer." });
                  return;
                }
                update.mutate({ id: c.id, patch: { agentIds, defaultAgentId } });
              }}
            />
          )}
        </Block>

        <Block title="Who can talk to it">
          <AccessChooser provider={c.provider} team={c.bot.team} value={c.access} onChange={(access) => access !== c.access && update.mutate({ id: c.id, patch: { access } })} />
        </Block>

        {c.provider === "teams" && <TeamsBlock connection={c} />}

        <Block title="People" description={people.length ? undefined : "Everyone who writes to the bot shows up here."}>
          {users.isLoading ? (
            <Skeleton className="h-16 rounded-xl" />
          ) : people.length > 0 ? (
            <ul className="divide-y rounded-xl border bg-card shadow-card">
              {people.map((u) => (
                <li key={u.id} className="flex items-center gap-3 px-3.5 py-2.5">
                  <Initials name={u.name} muted={u.status === "blocked"} />
                  <div className="min-w-0 flex-1">
                    <p className={cn("truncate text-sm", u.status === "blocked" && "text-muted-foreground line-through decoration-muted-foreground/40")}>{u.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{[u.username && `@${u.username}`, `active ${ago(u.lastSeenAt)}`].filter(Boolean).join(" · ")}</p>
                  </div>
                  <PersonStatus user={u} access={c.access} />
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="icon-sm" variant="ghost" aria-label={`Actions for ${u.name}`}>
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {u.status !== "approved" && (
                        <DropdownMenuItem onClick={() => setUser.mutate({ user: u, status: "approved" })}>
                          <Check /> Approve
                        </DropdownMenuItem>
                      )}
                      {u.status === "approved" && (
                        <DropdownMenuItem onClick={() => setUser.mutate({ user: u, status: "pending" })}>
                          <Undo2 /> Take back access
                        </DropdownMenuItem>
                      )}
                      {u.status !== "blocked" && (
                        <DropdownMenuItem onClick={() => setUser.mutate({ user: u, status: "blocked" })}>
                          <Ban /> Block
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onClick={() => forget.mutate(u)}>
                        <Trash2 /> Forget
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              ))}
            </ul>
          ) : null}
        </Block>

        <Block title="Recent chats">
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
                      <span className="block truncate text-sm">{chat.title || (chat.kind === "direct" ? "Direct message" : "Group")}</span>
                      <span className="block truncate text-xs text-muted-foreground">{agent ? `with ${agent.name}` : "—"} · {ago(chat.lastMessageAt)}</span>
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
              <MessageSquare className="size-4" /> No chats yet. Conversations show up here — and in Chat — as they happen.
            </p>
          )}
        </Block>

        <TokensBlock connection={c} />

        <div className="flex items-center justify-between gap-3 rounded-xl border border-destructive/25 px-3.5 py-3">
          <div>
            <p className="text-sm font-medium">Disconnect</p>
            <p className="text-xs text-muted-foreground">Removes the tokens, people and chat links. Conversations stay in Godmode.</p>
          </div>
          <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)}>
            <Trash2 /> Disconnect
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Disconnect ${c.name}?`}
        description={`The bot stops answering on ${meta.label}. You can connect it again later with its tokens.`}
        confirmLabel="Disconnect"
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
  if (user.status === "blocked") return <span className="text-[11px] text-destructive">Blocked</span>;
  if (user.status === "approved") return <span className="text-[11px] text-muted-foreground">Approved</span>;
  return access === "anyone" ? <span className="text-[11px] text-muted-foreground">Open access</span> : null;
}

function TeamsBlock({ connection: c }: { connection: MessagingConnection }) {
  const update = useUpdateConnection();
  const [url, setUrl] = useState(c.config.publicUrl ?? "");
  useEffect(() => setUrl(c.config.publicUrl ?? ""), [c.config.publicUrl]);
  const dirty = url.trim() !== (c.config.publicUrl ?? "");
  return (
    <Block title="Teams setup" description="Teams delivers messages to this Godmode over https.">
      <div className="space-y-4 rounded-xl border bg-card p-4 shadow-card">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty) update.mutate({ id: c.id, patch: { publicUrl: url } });
          }}
        >
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://godmode.example.com" aria-label="Public address" className="h-9" />
          <Button type="submit" size="sm" variant={dirty ? "default" : "outline"} disabled={!dirty || update.isPending} className="h-9">
            Save
          </Button>
        </form>
        <TeamsFinishSteps connection={c} />
      </div>
    </Block>
  );
}

function TokensBlock({ connection: c }: { connection: MessagingConnection }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const prefilled: CredentialFieldValues = { ...EMPTY_FIELDS, appId: c.config.appId ?? "", tenantId: c.config.tenantId ?? "" };
  const [fields, setFields] = useState<CredentialFieldValues>(prefilled);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const credentials = credentialsOf(c.provider, fields);
      if (!credentials) throw new Error("Fill in every field");
      return api.messaging.update(c.id, { credentials });
    },
    onSuccess: () => {
      toast.success("Tokens replaced", { description: "The bot reconnected with them." });
      setOpen(false);
      setFields(prefilled);
      setError(null);
    },
    onError: (err) => setError(errorMessage(err)),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.messaging }),
  });
  return (
    <Block
      title="Tokens"
      description="Stored encrypted in your vault. Replace them when you rotate them on the platform."
      action={
        !open && (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            <KeyRound /> Replace
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
              Cancel
            </Button>
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || !credentialsOf(c.provider, fields)}>
              {save.isPending && <Spinner />} Check & save
            </Button>
          </div>
        </div>
      )}
    </Block>
  );
}
