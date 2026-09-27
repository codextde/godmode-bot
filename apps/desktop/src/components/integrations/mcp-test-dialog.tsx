import { useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { CircleCheck, CircleX, RotateCcw, Wrench } from "lucide-react";
import type { McpServer } from "@godmode/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { api, errorMessage } from "@/lib/api";

/** Starts the server once and lists the tools it exposes (or shows why it failed). */
export function McpTestDialog({ server, onOpenChange }: { server: McpServer | null; onOpenChange: (open: boolean) => void }) {
  const test = useMutation({ mutationFn: (id: string) => api.mcpServers.test(id) });
  const { mutate, reset } = test;

  useEffect(() => {
    if (server) mutate(server.id);
    else reset();
  }, [server, mutate, reset]);

  const result = test.data;
  const failed = test.isError || (result && !result.ok);
  const tools = result?.tools ?? [];

  return (
    <Dialog open={!!server} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-2xl sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Test {server?.name}</DialogTitle>
          <DialogDescription>Godmode starts the server, lists its tools and shuts it down again.</DialogDescription>
        </DialogHeader>
        <AnimatePresence mode="wait" initial={false}>
          {test.isPending ? (
            <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col items-center gap-3 py-8 text-sm text-muted-foreground">
              <Spinner className="size-6 text-primary" />
              <span className="text-shimmer font-medium">Connecting…</span>
            </motion.div>
          ) : failed ? (
            <motion.div key="error" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-destructive">
                <CircleX className="size-5" /> The server didn't respond correctly
              </div>
              <pre className="max-h-64 overflow-auto rounded-xl border bg-black/80 p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-zinc-200">
                {test.isError ? errorMessage(test.error) : result?.error || "Unknown error"}
              </pre>
              <p className="text-xs text-muted-foreground">Check the command, arguments, URL and required environment variables or headers.</p>
            </motion.div>
          ) : result ? (
            <motion.div key="ok" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-success">
                <CircleCheck className="size-5" /> Connected · {tools.length} tool{tools.length === 1 ? "" : "s"}
              </div>
              {tools.length > 0 ? (
                <div className="flex max-h-64 flex-wrap gap-1.5 overflow-auto rounded-xl border bg-muted/30 p-3">
                  {tools.map((t, i) => (
                    <motion.span key={t} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: Math.min(i, 30) * 0.015 }}>
                      <Badge variant="secondary" className="gap-1 font-mono text-[11px] font-normal">
                        <Wrench className="size-3 text-muted-foreground" />
                        {t}
                      </Badge>
                    </motion.span>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">The server started but didn't report any tools.</p>
              )}
            </motion.div>
          ) : null}
        </AnimatePresence>
        <DialogFooter>
          {server && !test.isPending && (
            <Button variant="outline" onClick={() => mutate(server.id)}>
              <RotateCcw /> Run again
            </Button>
          )}
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
