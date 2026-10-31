import { useEffect, useId, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { Trans, useTranslation } from "react-i18next";
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

/**
 * Connect an app: Claude Code on this computer in one click (Godmode adds itself to it), or any other MCP client with a
 * key and the lines to paste. The key is on screen once, right after it was made.
 */
export function ConnectAppDialog({ tab, onClose, claudeCode }: { tab: ConnectTab | null; onClose: () => void; claudeCode: boolean }) {
  const { t } = useTranslation(["settings", "common"]);
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
          <DialogTitle className="text-lg font-medium tracking-[-0.02em]">{t("connect.apps.connect")}</DialogTitle>
          <DialogDescription>{t("connect.dialog.description")}</DialogDescription>
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
                    <TabsTrigger value="other">{t("connect.dialog.another")}</TabsTrigger>
                  </TabsList>
                  <TabsContent value="claude-code" className="space-y-3">
                    <p className="text-sm text-muted-foreground">{t("connect.dialog.claudeBody")}</p>
                    {!claudeCode && (
                      <Callout tone="info" title={t("connect.dialog.notFound")}>
                        {t("connect.dialog.notFoundBody")}
                      </Callout>
                    )}
                  </TabsContent>
                  <TabsContent value="other" className="space-y-2">
                    <Label htmlFor={nameId}>{t("common:words.name")}</Label>
                    <Input id={nameId} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" placeholder={t("connect.dialog.namePlaceholder")} autoFocus />
                    <p className="text-xs text-muted-foreground">{t("connect.dialog.nameHint")}</p>
                  </TabsContent>
                </Tabs>

                <div className="space-y-2">
                  <p className="text-sm font-medium">{t("connect.dialog.mayDo")}</p>
                  <ChoiceCards
                    name="connect-access"
                    value={access}
                    onChange={setAccess}
                    className="@container grid-cols-1 sm:grid-cols-2"
                    options={[
                      { value: "manage", icon: <Wand2 />, title: t("connect.dialog.manage"), description: t("connect.dialog.manageDescription") },
                      { value: "read", icon: <Eye />, title: t("connect.dialog.read"), description: t("connect.dialog.readDescription") },
                    ]}
                  />
                </div>

                {create.isError && (
                  <Callout tone="danger" title={t("connect.dialog.error")}>
                    {errorMessage(create.error)}
                  </Callout>
                )}
              </div>
              <div className="flex shrink-0 items-center justify-end gap-2 border-t px-6 py-4">
                <Button type="button" variant="ghost" onClick={onClose} disabled={create.isPending}>
                  {t("common:actions.cancel")}
                </Button>
                <Button type="submit" disabled={!ready || create.isPending}>
                  {create.isPending ? <Spinner /> : client === "claude-code" && claudeCode ? <SquareTerminal /> : <KeyRound />}
                  {client === "claude-code" && claudeCode ? (create.isPending ? t("connect.dialog.adding") : t("connect.dialog.add")) : t("connect.dialog.createKey")}
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
  const { t } = useTranslation(["settings", "common"]);
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
            <h3 className="text-base font-medium tracking-[-0.01em]">{added ? t("connect.created.connected") : t("connect.created.keyReady", { name: connector.name })}</h3>
            <p className="mt-1 text-sm text-muted-foreground" aria-live="polite">
              {added ? t("connect.created.connectedBody") : t("connect.created.keyReadyBody")}
            </p>
          </div>
        </div>

        {added ? (
          <div className="space-y-2">
            <CommandBlock text={t("connect.created.tryPrompt")} title={t("connect.created.tryTitle")} label={t("importMemory.copyPrompt")} />
            <p className="text-xs text-muted-foreground">
              <Trans t={t} i18nKey="connect.created.asks" values={{ command: "/mcp" }} components={{ code: <span className="font-mono text-[11px]" /> }} />
            </p>
          </div>
        ) : connector.client === "claude-code" ? (
          <div className="space-y-3">
            {install && (
              <Callout tone="warning" title={t("connect.created.installError")}>
                {install.detail}
              </Callout>
            )}
            <CommandBlock text={setup.claudeCommand} title={t("connect.created.runInTerminal")} />
            <p className="text-xs text-muted-foreground">{t("connect.created.runHint")}</p>
          </div>
        ) : (
          <Tabs defaultValue="config" className="gap-3">
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="config">{t("connect.created.configTab")}</TabsTrigger>
              <TabsTrigger value="claude">Claude Code</TabsTrigger>
              <TabsTrigger value="url">URL</TabsTrigger>
              <TabsTrigger value="terminal">Terminal</TabsTrigger>
            </TabsList>
            <TabsContent value="config" className="space-y-2">
              <CommandBlock text={setup.json} title={t("connect.created.mcpServers")} label={t("connect.created.copyConfig")} />
              <p className="text-xs text-muted-foreground">{t("connect.created.configHint")}</p>
            </TabsContent>
            <TabsContent value="claude" className="space-y-2">
              <CommandBlock text={setup.claudeCommand} title="Terminal" />
              <p className="text-xs text-muted-foreground">{t("connect.created.claudeHint")}</p>
            </TabsContent>
            <TabsContent value="url" className="space-y-2">
              <CommandBlock text={`${setup.url}\nAuthorization: Bearer ${setup.token}`} title="Streamable HTTP" label={t("connect.created.copyAddress")} />
              <p className="text-xs text-muted-foreground">{t("connect.created.urlHint")}</p>
            </TabsContent>
            <TabsContent value="terminal" className="space-y-2">
              <CommandBlock text={setup.cli} title="Terminal" label={t("connect.created.copyCommands")} />
              <p className="text-xs text-muted-foreground">
                <Trans t={t} i18nKey="connect.created.cliHint" components={{ code: <span className="font-mono text-[11px]" /> }} />
              </p>
            </TabsContent>
          </Tabs>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t px-6 py-4">
        <p className="min-w-0 flex-1 basis-48 text-xs text-muted-foreground">
          {connector.access === "manage" ? t("connect.created.footerManage") : t("connect.created.footerRead")}
        </p>
        <Button onClick={onDone}>{t("common:actions.done")}</Button>
      </div>
    </>
  );
}
