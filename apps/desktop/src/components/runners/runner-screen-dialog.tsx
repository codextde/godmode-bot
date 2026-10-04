import { useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence } from "motion/react";
import { MonitorOff, RefreshCw, WifiOff } from "lucide-react";
import { runnerView, type ComputerSources, type RemoteRunner } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { ComputerLiveView } from "@/components/computer/computer-live-view";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";

/**
 * A runner's screen, live, with its mouse and keyboard taken over — for the things only a person can do there (a
 * macOS question, a sign-in). Its displays are tabs of the view. Until there is a picture to show, a small dialog says
 * why not.
 */
export function RunnerScreenDialog({ runner, onClose }: { runner: RemoteRunner | null; onClose: () => void }) {
  // Kept while the dialog closes, so its text doesn't empty mid-animation.
  const [last, setLast] = useState(runner);
  if (runner && runner !== last) setLast(runner);
  const shown = runner ?? last;
  const online = runner?.state === "online";

  const sources = useQuery({
    queryKey: qk.runnerSources(runner?.id ?? ""),
    queryFn: () => api.runners.proxy<ComputerSources>(runner!.id, "GET", "/computer/sources"),
    enabled: !!runner && online,
    staleTime: 0,
    retry: false,
  });
  const displays = online ? [...(sources.data?.displays ?? [])].sort((a, b) => Number(b.primary) - Number(a.primary)) : [];
  const live = !!runner && displays.length > 0;

  return (
    <>
      {createPortal(
        <AnimatePresence>
          {live && (
            <ComputerLiveView
              key={runner.id}
              target={{ kind: "display", displayId: displays[0]!.id, name: runner.name }}
              views={displays.map((d) => ({ view: runnerView(runner.id, `display:${d.id}`), label: d.name }))}
              expanded
              onExpandedChange={(expanded) => !expanded && onClose()}
              defaultTakeover
              notes={{
                watching: `Live from ${runner.name}. Take over to use its mouse and keyboard from here.`,
                control: `You're in control — clicks and typing go to ${runner.name}'s mouse and keyboard.`,
              }}
            />
          )}
        </AnimatePresence>,
        document.body,
      )}

      <Dialog open={!!runner && !live} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Screen of {shown?.name}</DialogTitle>
            <DialogDescription>See what is on its screen and use its mouse and keyboard from here.</DialogDescription>
          </DialogHeader>
          {!online ? (
            <div className="flex items-start gap-2.5 rounded-lg border bg-paper-2 px-3 py-2.5 text-xs text-muted-foreground">
              <WifiOff className="mt-px size-3.5 shrink-0" aria-hidden />
              <p className="min-w-0 leading-relaxed">
                <span className="font-medium text-foreground">{shown?.name} isn't connected.</span> Its screen shows up here once it's back online.
              </p>
            </div>
          ) : sources.isError ? (
            <div className="rounded-lg border border-destructive/25 bg-destructive/[0.05] p-3.5 text-sm" role="alert">
              <p className="font-medium text-destructive">Couldn't get the screen</p>
              <p className="mt-1 text-xs leading-relaxed break-words text-muted-foreground">{errorMessage(sources.error)}</p>
            </div>
          ) : sources.data ? (
            <div className="space-y-2.5 rounded-lg border bg-paper-2 p-3.5 text-xs text-muted-foreground">
              <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                <MonitorOff className="size-4 shrink-0" aria-hidden /> No screen to show
              </p>
              {sources.data.problems.length > 0 ? (
                <ul className="list-disc space-y-1 pl-4 leading-relaxed">
                  {sources.data.problems.map((problem) => (
                    <li key={problem} className="break-words">
                      {problem}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="leading-relaxed">{shown?.name} didn't report a display.</p>
              )}
              <p className="leading-relaxed">
                A runner needs someone logged in on its screen, and Screen Recording allowed for Godmode there. Check health tells you which of the two is missing.
              </p>
            </div>
          ) : (
            <div className="flex items-center gap-2.5 rounded-lg border bg-paper-2 px-3 py-3 text-xs text-muted-foreground" role="status">
              <Spinner className="size-3.5 shrink-0" aria-hidden />
              Asking {shown?.name} for its screen…
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            {online && (sources.isError || sources.data) && (
              <Button variant="outline" onClick={() => void sources.refetch()} disabled={sources.isFetching}>
                {sources.isFetching ? <Spinner /> : <RefreshCw />} Try again
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
