import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileUp, History, MessagesSquare, Paperclip } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { AgentPicker } from "@/components/chat/agent-picker";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useAgents, useScopeProject, useScopeWorkspace } from "@/lib/hooks";
import { dateLocale } from "@/i18n";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { CHAT_FILE_EXT, closeChatImport, isChatFile, readChatFile, useChatImport } from "@/stores/chatImport";

export function ImportChatDialog() {
  const { t } = useTranslation("chat");
  const { open, data: given, name: givenName } = useChatImport();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const workspace = useScopeWorkspace();
  const project = useScopeProject();
  const { data: agents = [] } = useAgents();
  const usable = agents.filter((a) => a.enabled);
  const [data, setData] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [agentId, setAgentId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setData(given);
    setName(givenName);
    setCode("");
  }, [open, given, givenName]);

  useEffect(() => {
    if (agentId && usable.some((a) => a.id === agentId)) return;
    setAgentId((usable.find((a) => a.isDefault) ?? usable[0])?.id ?? null);
  }, [usable, agentId]);

  const payload = data ?? (code.trim() || null);
  const preview = useQuery({
    queryKey: ["chat-import-preview", payload],
    queryFn: () => api.conversations.previewImport(payload!),
    enabled: open && !!payload,
    retry: false,
    staleTime: Infinity,
  });

  const agent = usable.find((a) => a.id === agentId);
  const projectId = project && agent && (!agent.workspaceId || agent.workspaceId === project.workspaceId) ? project.id : null;
  const importChat = useMutation({
    mutationFn: () => api.conversations.import({ data: payload!, agentId: agentId!, workspaceId: workspace?.id ?? null, projectId }),
    onSuccess: (chat) => {
      qc.invalidateQueries({ queryKey: qk.conversationsAll });
      toast.success(t("import.done"), { description: chat.title });
      closeChatImport();
      navigate(`/chat/${chat.id}`);
    },
    onError: (err) => toast.error(t("import.error"), { description: errorMessage(err) }),
  });

  const takeFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      setData(await readChatFile(file));
      setName(file.name);
      setCode("");
    } catch (err) {
      toast.error(t("import.error"), { description: errorMessage(err) });
    }
  };

  const p = preview.data;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && closeChatImport()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("import.title")}</DialogTitle>
          <DialogDescription>{t("import.description")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-sm">
          {data ? (
            <div className="flex items-center gap-2 rounded-md border bg-card px-2.5 py-2">
              <Paperclip className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{name ?? t("import.sharedChat")}</span>
              <Button variant="ghost" size="sm" onClick={() => { setData(null); setName(null); }}>
                {t("import.change")}
              </Button>
            </div>
          ) : (
            <>
              <button
                type="button"
                onClick={() => input.current?.click()}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes("Files")) return;
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  void takeFile(Array.from(e.dataTransfer.files).find(isChatFile) ?? e.dataTransfer.files[0]);
                }}
                className={cn(
                  "flex flex-col items-center gap-1 rounded-lg border border-dashed px-4 py-5 text-center text-muted-foreground transition hover:bg-accent/40",
                  dragging && "border-primary bg-accent/40",
                )}
              >
                <FileUp className="size-5" />
                <span className="text-foreground">{t("import.pickFile")}</span>
                <span className="text-xs">{t("import.pickFileHint", { ext: CHAT_FILE_EXT })}</span>
              </button>
              <input ref={input} type="file" accept={`${CHAT_FILE_EXT},.json,.gz`} className="hidden" onChange={(e) => void takeFile(e.target.files?.[0])} />
              <Textarea value={code} onChange={(e) => setCode(e.target.value)} placeholder={t("import.pastePlaceholder")} rows={3} className="max-h-32 font-mono text-xs" />
            </>
          )}
          {payload && preview.isError && <p className="text-xs text-destructive">{errorMessage(preview.error)}</p>}
          {p && (
            <div className="flex flex-col gap-1 rounded-md border bg-muted/40 px-2.5 py-2">
              <span className="font-medium">{p.title}</span>
              <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <MessagesSquare className="size-3" /> {t("import.messages", { count: p.messages })}
                </span>
                {p.files > 0 && <span>{t("import.files", { count: p.files })}</span>}
                {p.withContext && (
                  <span className="inline-flex items-center gap-1">
                    <History className="size-3" /> {t("import.withContext")}
                  </span>
                )}
              </span>
              <span className="text-xs text-muted-foreground">
                {t("import.from", { agent: p.agentName || "—", date: format(new Date(p.exportedAt), "PPp", { locale: dateLocale() }) })}
              </span>
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">{t("import.continueWith")}</span>
            <AgentPicker agents={usable} value={agentId} onChange={setAgentId} />
          </div>
        </div>
        <DialogFooter>
          <Button disabled={!p || !agentId || importChat.isPending} onClick={() => importChat.mutate()}>
            {t("import.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
