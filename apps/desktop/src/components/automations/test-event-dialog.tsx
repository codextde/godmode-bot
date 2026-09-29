import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FlaskConical } from "lucide-react";
import type { Routine } from "@godmode/shared";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { modKey } from "@/lib/desktop";
import { Kbd } from "@/components/common";
import { prettySlug } from "@/components/integrations/toolkit-logo";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * Text that looks like JSON (starts with `{` or `[`) is sent parsed, anything else as plain text (webhooks accept
 * both); empty = the core's small example. `error` is set when JSON-looking text doesn't parse.
 */
function parsePayload(text: string): { input: { payload?: unknown }; error: string | null } {
  const raw = text.trim();
  if (!raw) return { input: {}, error: null };
  if (!raw.startsWith("{") && !raw.startsWith("[")) return { input: { payload: raw }, error: null };
  try {
    return { input: { payload: JSON.parse(raw) }, error: null };
  } catch {
    return { input: {}, error: "That looks like JSON but doesn't parse. Fix it, or send plain text." };
  }
}

/** Queue a sample event for an app/webhook automation; it goes through the filter like a real one. */
export function TestEventDialog({
  routine,
  open,
  onOpenChange,
  onViewEvents,
}: {
  routine: Routine;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onViewEvents: () => void;
}) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const asIf = routine.trigger.type === "app" ? `as if ${prettySlug(routine.trigger.toolkit)} sent this` : "as if its URL was called with this";
  const placeholder =
    routine.trigger.type === "app"
      ? '{\n  "from": "billing@acme.com",\n  "subject": "Invoice #1042"\n}'
      : '{\n  "event": "checkout.abandoned",\n  "items": 2,\n  "total": 128\n}';

  const parsed = parsePayload(text);
  const send = useMutation({
    mutationFn: () => api.routines.testEvent(routine.id, parsed.input),
    onSuccess: (event) => {
      qc.invalidateQueries({ queryKey: qk.automationEvents });
      qc.invalidateQueries({ queryKey: qk.routines });
      toast.success("Test event sent", { description: event.title, action: { label: "View events", onClick: onViewEvents } });
      setText("");
      onOpenChange(false);
    },
    onError: (err) => toast.error("Couldn't send the test event", { description: errorMessage(err) }),
  });

  const submit = () => {
    if (!send.isPending && !parsed.error) send.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="grid size-10 shrink-0 place-items-center rounded-lg border bg-card text-foreground shadow-card">
              <FlaskConical className="size-5" />
            </div>
            <div className="min-w-0">
              <DialogTitle>Send a test event</DialogTitle>
              <DialogDescription>
                Runs “{routine.name}” {asIf}. The filter is checked just as for a real event.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          className="space-y-4"
        >
          <div className="space-y-1.5">
            <Label htmlFor="test-event-payload">
              Event data <span className="font-normal text-muted-foreground">optional</span>
            </Label>
            <Textarea
              id="test-event-payload"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={placeholder}
              spellCheck={false}
              aria-invalid={!!parsed.error}
              aria-describedby={parsed.error ? "test-event-error test-event-hint" : "test-event-hint"}
              className="min-h-32 font-mono text-xs leading-relaxed"
            />
            {parsed.error && (
              <p id="test-event-error" className="text-xs text-destructive">
                {parsed.error}
              </p>
            )}
            <p id="test-event-hint" className="text-xs text-muted-foreground">
              JSON or plain text. Leave it empty to send a small example.
            </p>
          </div>
          <DialogFooter className="items-center sm:justify-between">
            <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
              <Kbd>{modKey}</Kbd>
              <Kbd>↵</Kbd> to send
            </span>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={send.isPending || !!parsed.error}>
                {send.isPending ? <Spinner /> : <FlaskConical />} Send test event
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
