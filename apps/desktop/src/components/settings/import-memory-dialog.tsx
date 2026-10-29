import { useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { IMPORT_MAX_CHARS, MEMORY_EXPORT_PROMPT, MEMORY_SOURCES, type MemorySource } from "@godmode/shared";
import { copyText } from "@/components/chat/copy-button";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage } from "@/lib/api";
import { openExternal } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="grid grid-cols-[1.5rem_1fr] gap-x-3 gap-y-2">
      <span className="grid size-6 place-items-center rounded-full border bg-secondary font-mono text-[11px] tabular-nums" aria-hidden>
        {n}
      </span>
      <h3 className="self-center text-[13px] font-medium">{title}</h3>
      <div className="col-start-2 min-w-0">{children}</div>
    </section>
  );
}

/**
 * Bring what ChatGPT, Claude or Gemini remember about the human into the main agent's memory: copy a prompt into the
 * other assistant, paste its answer back, and the main agent merges it in a chat of its own.
 */
export function ImportMemoryDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [source, setSource] = useState<MemorySource>("chatgpt");
  const [text, setText] = useState("");
  const [copied, setCopied] = useState(false);
  const picked = MEMORY_SOURCES.find((s) => s.id === source)!;
  const name = source === "other" ? "the assistant" : picked.label;

  const importMemory = useMutation({
    mutationFn: () => api.memory.import({ source, text: text.trim() }),
    onSuccess: ({ conversation }) => {
      qc.invalidateQueries({ queryKey: qk.conversationsAll });
      onOpenChange(false);
      setText("");
      navigate(`/chat/${conversation.id}`);
    },
    onError: (err) => toast.error("Couldn't import it", { description: errorMessage(err) }),
  });

  const copy = async () => {
    if (!(await copyText(MEMORY_EXPORT_PROMPT))) return toast.error("Couldn't copy the prompt");
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const tooLong = text.length > IMPORT_MAX_CHARS;

  return (
    <Dialog open={open} onOpenChange={(o) => !importMemory.isPending && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Bring your memory</DialogTitle>
          <DialogDescription>
            Another assistant already knows a lot about you. Copy it over once, and your main agent knows you from day one.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <Step n={1} title="Pick the assistant">
            <div role="radiogroup" aria-label="Assistant" className="flex flex-wrap gap-1.5">
              {MEMORY_SOURCES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={source === s.id}
                  onClick={() => setSource(s.id)}
                  className={cn(
                    "h-8 rounded-md border px-3 text-[13px] transition focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                    source === s.id ? "border-foreground/25 bg-secondary font-medium text-foreground" : "bg-card text-muted-foreground hover:text-foreground",
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </Step>

          <Step n={2} title={`Ask ${name} to write out what it remembers`}>
            <pre className="max-h-36 overflow-y-auto rounded-lg border bg-muted/40 px-3 py-2 font-sans text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
              {MEMORY_EXPORT_PROMPT}
            </pre>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Button size="sm" variant="outline" onClick={copy}>
                {copied ? <Check /> : <Copy />}
                {copied ? "Copied" : "Copy prompt"}
              </Button>
              {picked.url && (
                <Button size="sm" variant="ghost" onClick={() => void openExternal(picked.url!)}>
                  Open {picked.label}
                  <ExternalLink />
                </Button>
              )}
            </div>
          </Step>

          <Step n={3} title="Paste its answer">
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={`Paste what ${name} wrote…`}
              aria-label={`What ${name} wrote`}
              aria-invalid={tooLong || undefined}
              className="min-h-36 text-[13px]"
            />
            <p className={cn("mt-1.5 text-xs text-muted-foreground", tooLong && "text-destructive")}>
              {tooLong
                ? `That is more than ${IMPORT_MAX_CHARS.toLocaleString("en-US")} characters — paste the most important part.`
                : "Your main agent keeps what matters, merges it with what it knows and leaves out passwords and keys."}
            </p>
          </Step>
        </div>

        <DialogFooter>
          <Button variant="ghost" disabled={importMemory.isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!text.trim() || tooLong || importMemory.isPending} onClick={() => importMemory.mutate()}>
            {importMemory.isPending && <Spinner />}
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
