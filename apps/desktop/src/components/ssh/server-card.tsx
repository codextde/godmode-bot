import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useMutation } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import {
  Bot,
  Check,
  ChevronDown,
  Copy,
  Ellipsis,
  KeyRound,
  MessageSquare,
  Monitor,
  Pencil,
  Play,
  Plus,
  RectangleEllipsis,
  RefreshCw,
  Server,
  ShieldCheck,
  ShieldOff,
  Terminal,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { sshCommand, type SshAssignment, type SshExecResult, type SshServer } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentAvatar } from "@/components/common";
import { LiveDot } from "@/components/aicss/Motion";
import { CopyButton } from "@/components/chat/copy-button";
import { api, errorMessage } from "@/lib/api";
import { useAllAgents } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { SshStatusBadge, keyTypeLabel, sshAddress, sshStatus } from "./ssh-parts";
import type { SshActions } from "./use-ssh-actions";

export function ServerCard({ server, actions, onEdit, onDelete }: { server: SshServer; actions: SshActions; onEdit: () => void; onDelete: () => void }) {
  const [commandOpen, setCommandOpen] = useState(false);
  const status = sshStatus(server);
  const testing = actions.testing.has(server.id);
  const osName = server.os?.split(" · ")[0];

  return (
    <article aria-label={server.name} className={cn("flex min-w-0 flex-col rounded-xl border bg-card shadow-card transition hover:border-foreground/15", testing && "glow-border")}>
      <div className="flex items-start gap-3.5 p-4">
        <div className="relative shrink-0">
          <div
            className={cn(
              "grid size-10 place-items-center rounded-lg border [&_svg]:size-5",
              status === "connected" ? "bg-card text-foreground shadow-card" : "bg-paper-2 text-muted-foreground",
            )}
          >
            <Server />
          </div>
          <span className="absolute -right-1 -bottom-1 grid place-items-center rounded-full bg-card p-[2px]">
            {status === "connected" ? (
              <LiveDot live={false} className="bg-brand" />
            ) : (
              <span aria-hidden className={cn("block size-[7px] rounded-full", status === "failing" ? "bg-destructive" : "bg-muted-foreground/40")} />
            )}
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="min-w-0 truncate text-[15px] leading-snug font-medium tracking-[-0.01em]">{server.name}</h3>
            <SshStatusBadge server={server} testing={testing} />
          </div>
          <p className="mt-1 flex min-w-0 items-center gap-1 text-xs">
            <span className="truncate font-mono text-foreground/80" title={sshAddress(server)}>
              {sshAddress(server)}
            </span>
            <CopyButton text={sshCommand(server)} label="Copy ssh command" className="size-5" />
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground [&_svg]:size-3 [&_svg]:shrink-0">
            {server.auth === "key" ? (
              <span className="inline-flex items-center gap-1">
                <KeyRound aria-hidden /> SSH key{server.key ? ` · ${keyTypeLabel(server.key.type)}` : ""}
                {server.hasPassword && " · sudo password saved"}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1">
                <RectangleEllipsis aria-hidden /> Password
              </span>
            )}
            {osName && (
              <span className="inline-flex min-w-0 items-center gap-1" title={server.os ?? undefined}>
                <Monitor aria-hidden /> <span className="truncate">{osName}</span>
              </span>
            )}
          </p>
          {server.hostKey && <HostKeyLine server={server} />}
        </div>

        <ServerMenu server={server} actions={actions} onEdit={onEdit} onDelete={onDelete} />
      </div>

      {server.description && <p className="-mt-1 line-clamp-2 px-4 pb-4 text-[13px] leading-relaxed text-muted-foreground">{server.description}</p>}

      {server.lastError && !testing && (
        <div className="mx-4 mb-4 flex flex-wrap items-start gap-x-2.5 gap-y-2 rounded-lg border border-destructive/25 bg-destructive/[0.05] px-3 py-2.5 text-xs" role="alert">
          <TriangleAlert className="mt-px size-3.5 shrink-0 text-destructive" aria-hidden />
          <p className="min-w-0 flex-1 basis-48 leading-relaxed break-words text-destructive">{server.lastError}</p>
          <Button size="xs" variant="outline" onClick={() => actions.test.mutate({ server })}>
            <RefreshCw /> Test again
          </Button>
        </div>
      )}

      <div className="mt-auto border-t px-4 py-3">
        <UsedBy server={server} actions={actions} />
      </div>

      <div className="flex flex-wrap items-center gap-0.5 rounded-b-xl border-t bg-paper-2/70 px-2 py-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={testing}
              onClick={() => actions.test.mutate({ server })}
              className="h-7 gap-1.5 px-2 text-[12.5px] font-normal text-muted-foreground hover:text-foreground [&_svg]:size-3.5"
            >
              {testing ? <Spinner className="size-3.5" /> : <ShieldCheck />}
              {testing ? "Testing…" : "Test connection"}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{server.hostKey ? "Sign in and check the host key" : "Sign in and pin the server's host key"}</TooltipContent>
        </Tooltip>
        <Button
          variant="ghost"
          size="sm"
          className={cn("ml-auto h-7 gap-1.5 px-2 text-[12.5px] font-normal text-muted-foreground hover:text-foreground", commandOpen && "bg-accent text-foreground")}
          aria-expanded={commandOpen}
          aria-controls={`ssh-command-${server.id}`}
          onClick={() => setCommandOpen((o) => !o)}
        >
          <Terminal className="size-3.5" /> Run command
          <ChevronDown className={cn("size-3.5 opacity-60 transition-transform", commandOpen && "rotate-180")} />
        </Button>
      </div>

      <AnimatePresence initial={false}>
        {commandOpen && (
          <motion.div
            id={`ssh-command-${server.id}`}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
            className="overflow-hidden"
          >
            <CommandPanel server={server} />
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  );
}

function HostKeyLine({ server }: { server: SshServer }) {
  const key = server.hostKey!;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <p
          tabIndex={0}
          className="mt-1 flex max-w-full min-w-0 items-center gap-1 rounded-sm text-[11px] text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <ShieldCheck className="size-3 shrink-0 text-muted-foreground/80" aria-hidden />
          <span className="sr-only">Pinned host key:</span>
          <span className="shrink-0">{keyTypeLabel(key.type)}</span>
          <span className="truncate font-mono">{key.fingerprint}</span>
        </p>
      </TooltipTrigger>
      <TooltipContent className="max-w-80">
        <span className="block font-mono text-[11px] break-all">
          {key.type} {key.fingerprint}
        </span>
        <span className="mt-1 block opacity-80">Pinned host key — Godmode refuses the server if it presents another one.</span>
      </TooltipContent>
    </Tooltip>
  );
}

function ServerMenu({ server, actions, onEdit, onDelete }: { server: SshServer; actions: SshActions; onEdit: () => void; onDelete: () => void }) {
  const pending =
    (actions.forgetHostKey.isPending && actions.forgetHostKey.variables?.id === server.id) || (actions.remove.isPending && actions.remove.variables?.id === server.id);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground" aria-label={`More actions for ${server.name}`}>
          {pending ? <Spinner /> : <Ellipsis />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onClick={onEdit}>
          <Pencil /> Edit…
        </DropdownMenuItem>
        {server.auth === "key" && server.key && (
          <DropdownMenuItem onClick={() => void actions.copyPublicKey(server)}>
            <Copy /> Copy public key
          </DropdownMenuItem>
        )}
        {server.hostKey && (
          <DropdownMenuItem onClick={() => actions.forgetHostKey.mutate(server)}>
            <ShieldOff /> Forget host key
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={onDelete}>
          <Trash2 /> Delete…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ------------------------------------------------------------------ */
/* Used by                                                              */
/* ------------------------------------------------------------------ */

function assignmentHref(a: SshAssignment): string {
  return a.kind === "agent" ? `/agents/${a.id}/settings#ssh` : `/chat/${a.id}`;
}

function UsedBy({ server, actions }: { server: SshServer; actions: SshActions }) {
  const { data: agents = [] } = useAllAgents();
  const removing = (a: SshAssignment) =>
    actions.assign.isPending && actions.assign.variables?.server.id === server.id && actions.assign.variables.id === a.id && !actions.assign.variables.assigned;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="eyebrow mr-1 text-[10.5px]">Used by</span>
      {server.assignments.length === 0 && <span className="mr-1 text-xs text-muted-foreground">No one yet</span>}
      {server.assignments.map((a) => {
        const agent = a.kind === "agent" ? agents.find((x) => x.id === a.id) : undefined;
        const kind = a.kind === "agent" ? "Agent" : "Chat";
        const label = a.name || (a.kind === "conversation" ? "Untitled chat" : kind);
        return (
          <span key={`${a.kind}:${a.id}`} className="inline-flex h-6 max-w-[14rem] min-w-0 items-center rounded-md border bg-card text-xs shadow-xs">
            <Link
              to={assignmentHref(a)}
              title={`${kind}: ${label}`}
              className="flex h-full min-w-0 items-center gap-1.5 rounded-l-md pr-1 pl-1.5 transition hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              {agent ? (
                <AgentAvatar agent={agent} size="sm" className="size-4 rounded-[4px] text-[10px]" />
              ) : a.kind === "agent" ? (
                <Bot className="size-3.5 text-muted-foreground" />
              ) : (
                <MessageSquare className="size-3.5 text-muted-foreground" />
              )}
              <span className="truncate">{label}</span>
            </Link>
            <button
              type="button"
              aria-label={`Stop using ${server.name} for ${label}`}
              disabled={removing(a)}
              onClick={() => actions.assign.mutate({ server, kind: a.kind, id: a.id, name: label, assigned: false })}
              className="grid h-full w-5 shrink-0 place-items-center rounded-r-md text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              {removing(a) ? <Spinner className="size-3" /> : <X className="size-3" />}
            </button>
          </span>
        );
      })}
      <AssignPopover server={server} actions={actions} />
    </div>
  );
}

function AssignPopover({ server, actions }: { server: SshServer; actions: SshActions }) {
  const { data: agents = [] } = useAllAgents();
  const sorted = [...agents].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
  const assigned = new Set(server.assignments.filter((a) => a.kind === "agent").map((a) => a.id));
  const pendingId = actions.assign.isPending && actions.assign.variables?.server.id === server.id ? actions.assign.variables.id : null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs" className="h-6 text-muted-foreground hover:text-foreground" aria-label={`Assign ${server.name} to an agent`}>
          <Plus /> Assign
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 overflow-hidden p-0">
        <Command>
          {sorted.length > 6 && <CommandInput placeholder="Search agents…" />}
          <CommandList className="max-h-72">
            <CommandEmpty>No agents found.</CommandEmpty>
            <CommandGroup heading="Agents">
              {sorted.map((a) => {
                const on = assigned.has(a.id);
                return (
                  <CommandItem
                    key={a.id}
                    value={`agent ${a.name} ${a.id}`}
                    disabled={pendingId === a.id}
                    onSelect={() => actions.assign.mutate({ server, kind: "agent", id: a.id, name: a.name, assigned: !on })}
                    className="gap-2.5 py-1.5"
                  >
                    <AgentAvatar agent={a} size="sm" />
                    <span className="min-w-0 flex-1 truncate">{a.name}</span>
                    {pendingId === a.id ? <Spinner className="size-4" /> : on && <Check className="size-4" aria-label="Assigned" />}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
        <p className="border-t bg-paper-2 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          For a single chat, pick the server with the <span className="font-medium text-foreground">SSH</span> button in its message box.
        </p>
      </PopoverContent>
    </Popover>
  );
}

/* ------------------------------------------------------------------ */
/* Run a command                                                        */
/* ------------------------------------------------------------------ */

function CommandPanel({ server }: { server: SshServer }) {
  const [command, setCommand] = useState("");
  const exec = useMutation({
    mutationFn: (cmd: string) => api.ssh.exec(server.id, { command: cmd, timeoutSeconds: 120 }),
  });
  const result: SshExecResult | undefined = exec.data;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const cmd = command.trim();
    if (cmd && !exec.isPending) exec.mutate(cmd);
  };

  return (
    <form onSubmit={submit} className="space-y-3 border-t px-4 py-3.5">
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <span aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 font-mono text-xs text-muted-foreground">
            $
          </span>
          <Input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="uptime && df -h /"
            aria-label={`Command to run on ${server.name}`}
            autoComplete="off"
            spellCheck={false}
            className="h-8 pl-7 font-mono text-[12.5px]"
          />
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={!command.trim() || exec.isPending}>
          {exec.isPending ? <Spinner /> : <Play />} Run
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Runs as <span className="font-mono">{server.username}</span> on <span className="font-mono">{server.host}</span> — stops after 2 minutes. Agents use the same
        connection.
      </p>
      {exec.isError && (
        <p className="rounded-lg border border-destructive/25 bg-destructive/[0.05] px-3 py-2 text-xs text-destructive" role="alert">
          {errorMessage(exec.error)}
        </p>
      )}
      {result && (
        <div className="overflow-hidden rounded-lg border bg-paper-2" aria-live="polite">
          <div className="flex items-center gap-2 border-b px-3 py-1.5 text-[11px] text-muted-foreground">
            <span
              className={cn(
                "rounded-[4px] border px-1 font-mono tabular-nums",
                result.exitCode === 0 ? "border-success/25 text-success" : "border-destructive/25 text-destructive",
              )}
            >
              exit {result.exitCode ?? "–"}
            </span>
            {result.timedOut && <span className="font-medium text-warning">Timed out</span>}
            <span className="tabular-nums">{result.durationMs < 1000 ? `${result.durationMs} ms` : `${(result.durationMs / 1000).toFixed(1)} s`}</span>
            <span className="ml-auto truncate font-mono">{exec.variables}</span>
          </div>
          <pre className="max-h-64 overflow-auto p-3 font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-foreground">
            {result.stdout}
            {result.stderr && <span className="text-destructive">{result.stderr}</span>}
            {!result.stdout && !result.stderr && <span className="text-muted-foreground">(no output)</span>}
          </pre>
        </div>
      )}
    </form>
  );
}
