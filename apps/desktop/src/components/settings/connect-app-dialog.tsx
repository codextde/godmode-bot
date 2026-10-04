import { useEffect, useId, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { Eye, KeyRound, SquareTerminal, Wand2 } from "lucide-react";
import type { ConnectorAccess, ConnectorCreated } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DrawCheck } from "@/components/aicss/Motion";
import { CommandBlock } from "@/components/runners/runner-parts";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { Callout, ChoiceCards } from "./settings-kit";

export type ConnectTab = "claude-code" | "other";

const TRY_PROMPT = "Create a Godmode agent that checks our competitors' pricing every Monday morning and sends me a summary.";

/**
 * Connect an app: Claude Code on this computer in one click (Godmode adds itself to it), or any other MCP client with a
 * key and the lines to paste. The key is on screen once, right after it was made.
 */
export function ConnectAppDialog({ tab, onClose, claudeCode }: { tab: ConnectTab | null; onClose: () => void; claudeCode: boolean }) {
  const qc = useQueryClient();
  const nameId = useId();
  const [client, setClient] = useState<ConnectTab>("claude-code");
  const [name, setName] = useState("");
  const [access, setAccess] = useState<ConnectorAccess>("manage");
  const [created, setCreated] = useState<ConnectorCreated | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.connectors.create({ name: client === "claude-code" ? "Claude Code" : name.trim(), client, access, install: client === "claude-code" && claudeCode }),
    onSuccess: (result) => {
      setCreated(result);
      void qc.invalidateQueries({ queryKey: qk.connectors });
    },
  });

  useEffect(() => {
    // Closed: the key leaves the page once the dialog has faded out.
    if (!tab) {
      const timer = setTimeout(() => setCreated(null), 300);
      return () => clearTimeout(timer);
    }
    setClient(tab);
    setName("");
    setAccess("manage");
    setCreated(null);
    create.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const ready = client === "claude-code" || name.trim().length > 0;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready && !create.isPending) create.mutate();
  };

  return (
    <Dialog open={tab !== null} onOpenChange={(open) => !open && !create.isPending && onClose()}>
      <DialogContent className="flex max-h-[calc(100vh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[600px]">
        <DialogHeader className="shrink-0 border-b px-6 pt-6 pb-5 text-left">
          <DialogTitle className="text-lg font-medium tracking-[-0.02em]">Connect an app</DialogTitle>
          <DialogDescription>It gets Godmode's management tools: agents, automations, tasks and what they did.</DialogDescription>
        </DialogHeader>

        <AnimatePresence mode="wait" initial={false}>
          {created ? (
            <motion.div key="done" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} className="flex min-h-0 flex-1 flex-col">
              <Created result={created} onDone={onClose} />
            </motion.div>
          ) : (
            <motion.form key="form" initial={{ opacity: 0 }} animate={{ opacity: 1 }} onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-6">
                <Tabs value={client} onValueChange={(v) => setClient(v as ConnectTab)} className="gap-4">
                  <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="claude-code">Claude Code</TabsTrigger>
                    <TabsTrigger value="other">Another app</TabsTrigger>
                  </TabsList>
                  <TabsContent value="claude-code" className="space-y-3">
                    <p className="text-sm text-muted-foreground">
                      Godmode adds itself to Claude Code on this computer as an MCP server, for every project. Nothing to copy: open a new session and
                      it's there.
                    </p>
                    {!claudeCode && (
                      <Callout tone="info" title="Claude Code wasn't found on this computer">
                        You get the command to run in a terminal where it is installed.
                      </Callout>
                    )}
                  </TabsContent>
                  <TabsContent value="other" className="space-y-2">
                    <Label htmlFor={nameId}>Name</Label>
                    <Input id={nameId} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" placeholder="Cursor, Codex, a script…" autoFocus />
                    <p className="text-xs text-muted-foreground">Any app that speaks MCP, or the godmode command line. The name tells your apps apart in the list.</p>
                  </TabsContent>
                </Tabs>

                <div className="space-y-2">
                  <p className="text-sm font-medium">What it may do</p>
                  <ChoiceCards
                    name="connect-access"
                    value={access}
                    onChange={setAccess}
                    className="@container grid-cols-1 sm:grid-cols-2"
                    options={[
                      { value: "manage", icon: <Wand2 />, title: "Set up and steer", description: "Create and change agents, automations and tasks, and start their work." },
                      { value: "read", icon: <Eye />, title: "Look only", description: "See agents, tasks and what was done. It changes nothing." },
                    ]}
                  />
                </div>

                {create.isError && (
                  <Callout tone="danger" title="Couldn't connect the app">
                    {errorMessage(create.error)}
                  </Callout>
                )}
              </div>
              <div className="flex shrink-0 items-center justify-end gap-2 border-t px-6 py-4">
                <Button type="button" variant="ghost" onClick={onClose} disabled={create.isPending}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!ready || create.isPending}>
                  {create.isPending ? <Spinner /> : client === "claude-code" && claudeCode ? <SquareTerminal /> : <KeyRound />}
                  {client === "claude-code" && claudeCode ? (create.isPending ? "Adding…" : "Add to Claude Code") : "Create key"}
                </Button>
              </div>
            </motion.form>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}

function Created({ result, onDone }: { result: ConnectorCreated; onDone: () => void }) {
  const { connector, setup, install } = result;
  const added = install?.ok === true;

  return (
    <>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-6">
        <div className="flex items-start gap-4">
          <div className="grid size-11 shrink-0 place-items-center rounded-full bg-brand-soft text-brand-strong">
            <DrawCheck className="size-6" />
          </div>
          <div className="min-w-0">
            <h3 className="text-base font-medium tracking-[-0.01em]">{added ? "Claude Code is connected" : `The key for ${connector.name} is ready`}</h3>
            <p className="mt-1 text-sm text-muted-foreground" aria-live="polite">
              {added
                ? "Godmode is in Claude Code now, for every project. Sessions that are already open pick it up after a restart."
                : "It is shown this once: Godmode only keeps its fingerprint. Copy what your app needs before you close this."}
            </p>
          </div>
        </div>

        {added ? (
          <div className="space-y-2">
            <CommandBlock text={TRY_PROMPT} title="Try it in a new Claude Code session" label="Copy prompt" />
            <p className="text-xs text-muted-foreground">
              Claude Code asks before it uses a Godmode tool for the first time. <span className="font-mono text-[11px]">/mcp</span> shows the server and its tools.
            </p>
          </div>
        ) : connector.client === "claude-code" ? (
          <div className="space-y-3">
            {install && (
              <Callout tone="warning" title="Godmode couldn't add itself to Claude Code">
                {install.detail}
              </Callout>
            )}
            <CommandBlock text={setup.claudeCommand} title="Run this in a terminal" />
            <p className="text-xs text-muted-foreground">It adds Godmode to Claude Code for every project. Then start a new session.</p>
          </div>
        ) : (
          <Tabs defaultValue="config" className="gap-3">
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="config">Config file</TabsTrigger>
              <TabsTrigger value="claude">Claude Code</TabsTrigger>
              <TabsTrigger value="url">URL</TabsTrigger>
              <TabsTrigger value="terminal">Terminal</TabsTrigger>
            </TabsList>
            <TabsContent value="config" className="space-y-2">
              <CommandBlock text={setup.json} title="MCP servers" label="Copy config" />
              <p className="text-xs text-muted-foreground">For apps set up with a JSON file (Cursor, Claude Desktop, Windsurf…). The app starts the connection itself, and it finds Godmode on whichever port it runs.</p>
            </TabsContent>
            <TabsContent value="claude" className="space-y-2">
              <CommandBlock text={setup.claudeCommand} title="Terminal" />
              <p className="text-xs text-muted-foreground">Adds Godmode to Claude Code for every project.</p>
            </TabsContent>
            <TabsContent value="url" className="space-y-2">
              <CommandBlock text={`${setup.url}\nAuthorization: Bearer ${setup.token}`} title="Streamable HTTP" label="Copy address and header" />
              <p className="text-xs text-muted-foreground">For apps that take an address and a header. It stops matching if Godmode ever starts on another port; the config file doesn't mind.</p>
            </TabsContent>
            <TabsContent value="terminal" className="space-y-2">
              <CommandBlock text={setup.cli} title="Terminal" label="Copy commands" />
              <p className="text-xs text-muted-foreground">
                <span className="font-mono text-[11px]">tools</span> lists what the key can do, <span className="font-mono text-[11px]">call</span> runs one tool with JSON arguments. Handy for scripts.
              </p>
            </TabsContent>
          </Tabs>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t px-6 py-4">
        <p className="min-w-0 flex-1 basis-48 text-xs text-muted-foreground">
          {connector.access === "manage" ? "It can set up and steer your team." : "It can look, and change nothing."} Remove it anytime in the list.
        </p>
        <Button onClick={onDone}>Done</Button>
      </div>
    </>
  );
}
