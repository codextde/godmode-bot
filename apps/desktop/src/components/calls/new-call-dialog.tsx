import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PhoneOutgoing } from "lucide-react";
import { toast } from "sonner";
import type { PhoneCall } from "@godmode/shared";
import { toE164 } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { useSettings } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { CALL_LANGUAGES } from "./call-parts";

const EMPTY = { to: "", contactName: "", goal: "", context: "" };

/** Have Godmode's voice call someone for you; the call shows up in the list right away. */
export function NewCallDialog({ open, onOpenChange, onPlaced }: { open: boolean; onOpenChange: (open: boolean) => void; onPlaced: (call: PhoneCall) => void }) {
  const qc = useQueryClient();
  const fallback = useSettings().data?.phone.language ?? "en";
  const [form, setForm] = useState(EMPTY);
  const [language, setLanguage] = useState(fallback);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(EMPTY);
    setLanguage(fallback);
    setTouched(false);
  }, [open, fallback]);

  const to = toE164(form.to);
  const ready = !!to && !!form.goal.trim();

  const place = useMutation({
    mutationFn: () =>
      api.calls.place({
        to: to!,
        goal: form.goal.trim(),
        context: form.context.trim() || undefined,
        contactName: form.contactName.trim() || undefined,
        language,
      }),
    onSuccess: (call) => {
      void qc.invalidateQueries({ queryKey: qk.calls });
      toast.success(`Calling ${call.contactName || call.number}`, { description: "The transcript and summary show up here when the call ends." });
      onPlaced(call);
      onOpenChange(false);
    },
    onError: (e) => toastApiError(e, "Couldn't place the call", qc),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (ready && !place.isPending) place.mutate();
  };

  const badNumber = (touched || form.to.length > 6) && !!form.to.trim() && !to;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="contents">
          <DialogHeader>
            <DialogTitle>New call</DialogTitle>
            <DialogDescription>Godmode's voice calls for you and works toward the goal. You get the transcript, a summary and the outcome afterwards.</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="call-to">Number</Label>
                <Input
                  id="call-to"
                  type="tel"
                  inputMode="tel"
                  autoFocus
                  value={form.to}
                  onChange={(e) => setForm({ ...form, to: e.target.value })}
                  placeholder="+49 40 1234567"
                  autoComplete="off"
                  className="font-mono text-[13px]"
                  aria-invalid={badNumber}
                  aria-describedby="call-to-hint"
                />
                <p id="call-to-hint" className={badNumber ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                  {badNumber ? "Add the country code, e.g. +49." : "With the country code."}
                </p>
              </div>
              <div className="grid content-start gap-1.5">
                <Label htmlFor="call-name">Who</Label>
                <Input id="call-name" value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} placeholder="Salon Haarwerk" autoComplete="off" />
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="call-goal">Goal</Label>
              <Textarea
                id="call-goal"
                value={form.goal}
                onChange={(e) => setForm({ ...form, goal: e.target.value })}
                placeholder="Book a haircut for next week, ideally Tuesday or Wednesday after 5 pm."
                className="min-h-20"
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="call-context">
                Good to know <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Textarea
                id="call-context"
                value={form.context}
                onChange={(e) => setForm({ ...form, context: e.target.value })}
                placeholder="Customer number, what's been agreed before, what not to say yes to."
                className="min-h-16"
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="call-language">Language</Label>
              <Select value={language} onValueChange={setLanguage}>
                <SelectTrigger id="call-language" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" align="end" className="max-h-72">
                  {CALL_LANGUAGES.map((l) => (
                    <SelectItem key={l.code} value={l.code}>
                      {l.label} <span className="font-mono text-xs text-muted-foreground">{l.code}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ready || place.isPending}>
              {place.isPending ? <Spinner className="size-3.5" /> : <PhoneOutgoing />} Call now
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
