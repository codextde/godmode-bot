import { useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { CircleX, RotateCcw, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { McpServer } from "@godmode/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DrawCheck } from "@/components/aicss/Motion";
import { Orb } from "@/components/aicss/Orb";
import { api, errorMessage } from "@/lib/api";

/** Starts the server once and lists the tools it exposes (or shows why it failed). */
export function McpTestDialog({ server, onOpenChange }: { server: McpServer | null; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation(["integrations", "common"]);
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
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("mcpTest.title", { name: server?.name })}</DialogTitle>
          <DialogDescription>{t("mcpTest.description")}</DialogDescription>
        </DialogHeader>
        <AnimatePresence mode="wait" initial={false}>
          {test.isPending ? (
            <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col items-center gap-3 py-8 text-sm text-muted-foreground">
              <Orb variant="C1" size={24} label={t("mcpTest.connectingLabel")} />
              <span className="text-shimmer font-medium">{t("mcpTest.connecting")}</span>
            </motion.div>
          ) : failed ? (
            <motion.div key="error" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-destructive">
                <CircleX className="size-5" /> {t("mcpTest.failed")}
              </div>
              <pre className="max-h-64 overflow-auto rounded-lg border bg-paper-2 p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-foreground">
                {test.isError ? errorMessage(test.error) : result?.error || t("mcpTest.unknownError")}
              </pre>
              <p className="text-xs text-muted-foreground">{t("mcpTest.failedHint")}</p>
            </motion.div>
          ) : result ? (
            <motion.div key="ok" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-success">
                <DrawCheck className="size-5" /> {t("mcpTest.connected", { count: tools.length })}
              </div>
              {tools.length > 0 ? (
                <div className="flex max-h-64 flex-wrap gap-1.5 overflow-auto rounded-lg border bg-paper-2 p-3">
                  {tools.map((tool, i) => (
                    <motion.span key={tool} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: Math.min(i, 30) * 0.015 }}>
                      <Badge variant="secondary" className="gap-1 font-mono text-[11px] font-normal">
                        <Wrench className="size-3 text-muted-foreground" />
                        {tool}
                      </Badge>
                    </motion.span>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{t("mcpTest.noTools")}</p>
              )}
            </motion.div>
          ) : null}
        </AnimatePresence>
        <DialogFooter>
          {server && !test.isPending && (
            <Button variant="outline" onClick={() => mutate(server.id)}>
              <RotateCcw /> {t("mcpTest.runAgain")}
            </Button>
          )}
          <Button onClick={() => onOpenChange(false)}>{t("common:actions.done")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
