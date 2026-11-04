import { useState } from "react";
import type { Conversation } from "@godmode/shared";
import { CHAT_SHARE_CODE_PREFIX } from "@godmode/shared";
import { Copy, Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { api, errorMessage } from "@/lib/api";
import { saveBlob } from "@/lib/desktop";
import { CHAT_FILE_EXT } from "@/stores/chatImport";

const SLACK_MESSAGE_CHARS = 40_000;

function fileName(title: string): string {
  const stem = title.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "_").trim().slice(0, 80) || "chat";
  return `${stem}${CHAT_FILE_EXT}`;
}

export function ShareChatDialog({ conversation, open, onOpenChange }: { conversation: Conversation; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation("chat");
  const [context, setContext] = useState(true);
  const [files, setFiles] = useState(true);
  const [busy, setBusy] = useState<"file" | "code" | null>(null);
  const remote = !!conversation.runnerId;

  const saveFile = async () => {
    setBusy("file");
    try {
      const blob = await api.conversations.exportFile(conversation.id, { context, files });
      if (await saveBlob(blob, fileName(conversation.title || t("header.newChat")))) {
        toast.success(t("share.saved"), { description: t("share.savedHint") });
        onOpenChange(false);
      }
    } catch (err) {
      toast.error(t("share.error"), { description: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const copyCode = async () => {
    setBusy("code");
    try {
      const { code } = await api.conversations.shareCode(conversation.id);
      await navigator.clipboard.writeText(code);
      const long = code.length > SLACK_MESSAGE_CHARS;
      toast[long ? "warning" : "success"](t("share.copied"), { description: long ? t("share.copiedLong") : t("share.copiedHint") });
      onOpenChange(false);
    } catch (err) {
      toast.error(t("share.error"), { description: errorMessage(err) });
    } finally {
      setBusy(null);
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
          <label className="flex items-start justify-between gap-3">
            <span className="flex flex-col gap-0.5">
              <span>{t("share.context")}</span>
              <span className="text-xs text-muted-foreground">{remote ? t("share.contextRemote") : t("share.contextHint")}</span>
            </span>
            <Switch checked={context && !remote} disabled={remote} onCheckedChange={setContext} />
          </label>
          <label className="flex items-start justify-between gap-3">
            <span className="flex flex-col gap-0.5">
              <span>{t("share.files")}</span>
              <span className="text-xs text-muted-foreground">{t("share.filesHint")}</span>
            </span>
            <Switch checked={files && !remote} disabled={remote} onCheckedChange={setFiles} />
          </label>
          <p className="rounded-md border bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground">{t("share.privacy")}</p>
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" disabled={!!busy} onClick={() => void copyCode()} title={t("share.codeHint", { prefix: CHAT_SHARE_CODE_PREFIX })}>
            <Copy /> {t("share.copyCode")}
          </Button>
          <Button disabled={!!busy} onClick={() => void saveFile()}>
            <Download /> {t("share.saveFile")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
