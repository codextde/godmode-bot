import { useEffect, useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";
import { RUNNER_DEFAULT_PORT, type RemoteRunner, type RunnerPatch } from "@godmode/shared";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { InlineCode } from "@/components/onboarding/doctor-checklist";
import type { RunnerActions } from "./use-runner-actions";

const MAX_NAME = 60;

function lines(text: string): string[] {
  return [...new Set(text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean))];
}

export function RenameRunnerDialog({ runner, onClose, actions }: { runner: RemoteRunner | null; onClose: () => void; actions: RunnerActions }) {
  const [name, setName] = useState("");
  useEffect(() => {
    if (runner) setName(runner.name);
    // Seed once per opened runner: live updates of the same runner must not reset the field.
  }, [runner?.id]);

  if (!runner) return null;
  const next = name.trim();
  const saving = actions.isBusy("update", runner.id);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!next || next === runner.name || saving) return;
    actions.update.mutate({ runner, patch: { name: next } }, { onSuccess: onClose });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>Rename “{runner.name}”</DialogTitle>
            <DialogDescription>The name you pick it by when you start a chat. The computer itself keeps its name ({runner.hostname}).</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="runner-name">Name</Label>
            <Input id="runner-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={MAX_NAME} autoFocus autoComplete="off" placeholder="Mac mini" />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!next || next === runner.name || saving}>
              {saving && <Spinner />} Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Where Godmode dials the runner: hosts or IPs in the order they are tried, and the port. */
export function RunnerAddressesDialog({ runner, onClose, actions }: { runner: RemoteRunner | null; onClose: () => void; actions: RunnerActions }) {
  const [addresses, setAddresses] = useState("");
  const [port, setPort] = useState("");
  useEffect(() => {
    if (!runner) return;
    setAddresses(runner.addresses.join("\n"));
    setPort(String(runner.port));
  }, [runner?.id]);

  if (!runner) return null;
  const list = lines(addresses);
  const portNumber = Number(port);
  const portValid = /^\d{1,5}$/.test(port.trim()) && portNumber >= 1 && portNumber <= 65535;
  const patch: RunnerPatch = {};
  if (list.join("\n") !== runner.addresses.join("\n")) patch.addresses = list;
  if (portValid && portNumber !== runner.port) patch.port = portNumber;
  const changed = Object.keys(patch).length > 0;
  const saving = actions.isBusy("update", runner.id);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!changed || list.length === 0 || !portValid || saving) return;
    actions.update.mutate({ runner, patch }, { onSuccess: onClose });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>Addresses of “{runner.name}”</DialogTitle>
            <DialogDescription>
              Where Godmode finds it. It tries them from the top, so put the fastest first — the address in your network, then its Tailscale address.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="runner-addresses">Addresses</Label>
            <Textarea
              id="runner-addresses"
              value={addresses}
              onChange={(e) => setAddresses(e.target.value)}
              rows={4}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={list.length === 0 || undefined}
              aria-describedby="runner-addresses-hint"
              placeholder={"192.168.1.20\n100.101.102.103\nmac-mini.local"}
              className="font-mono text-[13px] md:text-[13px]"
            />
            <p id="runner-addresses-hint" className={list.length === 0 ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
              {list.length === 0 ? (
                "Add at least one address."
              ) : runner.address ? (
                <>
                  One per line. Connected through <span className="font-mono text-foreground/85">{runner.address}</span> right now.
                </>
              ) : (
                "One per line: an IP address or a name."
              )}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="runner-port">Port</Label>
            <Input
              id="runner-port"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              inputMode="numeric"
              autoComplete="off"
              aria-invalid={!portValid || undefined}
              className="w-28 font-mono text-[13px] md:text-[13px]"
            />
            <p className={portValid ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>
              {portValid ? (
                <InlineCode text={`The port the runner listens on — ${RUNNER_DEFAULT_PORT} unless \`godmode runner status\` says otherwise.`} />
              ) : (
                "A port is a number from 1 to 65535."
              )}
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!changed || list.length === 0 || !portValid || saving}>
              {saving && <Spinner />} Save addresses
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RemoveRunnerDialog({ runner, onClose, actions }: { runner: RemoteRunner | null; onClose: () => void; actions: RunnerActions }) {
  const chats = runner?.conversations ?? 0;
  const working = runner?.activeRuns ?? 0;
  return (
    <AlertDialog open={!!runner} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove “{runner?.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            Godmode forgets this runner, and the runner forgets this computer.
            {chats === 1 && " Its chat stays here with everything in it; new messages in it are answered on this computer."}
            {chats > 1 && ` Its ${chats} chats stay here with everything in them; new messages in them are answered on this computer.`}
            {working === 1 && " An agent is still working there — what it finishes from now on won't show up here."}
            {working > 1 && ` ${working} agents are still working there — what they finish from now on won't show up here.`} Godmode itself stays installed on{" "}
            {runner?.hostname || "the other computer"}.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              if (runner) actions.remove.mutate(runner);
              onClose();
            }}
          >
            <Trash2 /> Remove runner
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
