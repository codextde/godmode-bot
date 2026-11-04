import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { Conversation } from "@godmode/shared";
import { Copy, Download, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { api, errorMessage } from "@/lib/api";
import { saveBlob } from "@/lib/desktop";
import { cn } from "@/lib/utils";

const SLACK_MESSAGE_CHARS = 40_000;

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function Option({ label, hint, checked, disabled, onChange }: { label: string; hint: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-start justify-between gap-3">
      <span className="flex flex-col gap-0.5">
        <span>{label}</span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </label>
  );
}

export function ShareChatDialog({ conversation, open, onOpenChange }: { conversation: Conversation; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation("chat");
  const remote = !!conversation.runnerId;
  const [context, setContext] = useState(true);
  const [screenshots, setScreenshots] = useState(false);
  const [files, setFiles] = useState(false);
  const opts = { context: context && !remote, files: files && !remote, screenshots };
  const share = useQuery({
    queryKey: ["chat-share", conversation.id, opts],
    queryFn: () => api.conversations.share(conversation.id, opts),
    enabled: open,
    gcTime: 0,
    staleTime: 0,
    placeholderData: keepPreviousData,
  });
  const result = share.isPlaceholderData ? undefined : share.data;
  const long = !!result && result.bytes > SLACK_MESSAGE_CHARS;

  const copyCode = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.code);
      toast.success(t("share.copied"), { description: t("share.copiedHint") });
      onOpenChange(false);
    } catch (err) {
      toast.error(t("share.error"), { description: errorMessage(err) });
    }
  };

  const saveFile = async () => {
    if (!result) return;
    try {
      if (await saveBlob(new Blob([result.code], { type: "text/plain" }), result.fileName)) {
        toast.success(t("share.saved"), { description: t("share.savedHint") });
        onOpenChange(false);
      }
    } catch (err) {
      toast.error(t("share.error"), { description: errorMessage(err) });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("share.title")}</DialogTitle>
          <DialogDescription>{t("share.description")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-sm">
          <Option label={t("share.context")} hint={remote ? t("share.contextRemote") : t("share.contextHint")} checked={opts.context} disabled={remote} onChange={setContext} />
          <Option label={t("share.screenshots")} hint={t("share.screenshotsHint")} checked={screenshots} onChange={setScreenshots} />
          <Option label={t("share.files")} hint={remote ? t("share.contextRemote") : t("share.filesHint")} checked={opts.files} disabled={remote} onChange={setFiles} />
          <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/40 px-2.5 py-2 text-xs">
            <span className="text-muted-foreground">{t("share.privacy")}</span>
            <span className={cn("shrink-0 tabular-nums font-medium", long && "text-warning")}>
              {share.isFetching || !result ? <Loader2 className="size-3.5 animate-spin" /> : size(result.bytes)}
            </span>
          </div>
          {share.isError && <p className="text-xs text-destructive">{errorMessage(share.error)}</p>}
          {long && <p className="text-xs text-muted-foreground">{t("share.long")}</p>}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant={long ? "outline" : "default"} disabled={!result} onClick={() => void copyCode()}>
            <Copy /> {t("share.copyCode")}
          </Button>
          <Button variant={long ? "default" : "outline"} disabled={!result} onClick={() => void saveFile()}>
            <Download /> {t("share.saveFile")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
