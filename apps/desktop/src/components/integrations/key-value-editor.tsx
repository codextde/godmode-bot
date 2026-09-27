import { useId } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Lock, Pencil, Plus, Trash2, Undo2 } from "lucide-react";
import { SECRET_MASK } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PasswordInput } from "@/components/vault/password-input";
import { cn } from "@/lib/utils";

export interface KeyValueRow {
  /** Stable React key */
  uid: string;
  key: string;
  value: string;
  /** Value is stored server side (encrypted) and not known to the UI. */
  stored: boolean;
  /** Stored value is being replaced by `value`. */
  replacing?: boolean;
}

let seq = 0;
const uid = () => `kv-${++seq}`;

/** Rows for keys already saved on the server (values unknown → SECRET_MASK). */
export function rowsFromKeys(keys: string[]): KeyValueRow[] {
  return keys.map((key) => ({ uid: uid(), key, value: SECRET_MASK, stored: true }));
}

export function newRow(key = "", value = ""): KeyValueRow {
  return { uid: uid(), key, value, stored: false };
}

/** API payload: untouched stored values are sent as SECRET_MASK so the server keeps them. */
export function rowsToRecord(rows: KeyValueRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (!k) continue;
    out[k] = r.stored && !r.replacing ? SECRET_MASK : r.value;
  }
  return out;
}

export function rowsError(rows: KeyValueRow[], pattern: RegExp, kind: string): string | null {
  const seen = new Set<string>();
  for (const r of rows) {
    const k = r.key.trim();
    if (!k) {
      if (r.value && r.value !== SECRET_MASK) return `Every ${kind} value needs a name.`;
      continue;
    }
    if (!pattern.test(k)) return `“${k}” is not a valid ${kind} name.`;
    if (seen.has(k.toLowerCase())) return `“${k}” is listed twice.`;
    seen.add(k.toLowerCase());
  }
  return null;
}

/**
 * Editor for secret key/value pairs (env vars, HTTP headers). Existing values are never sent to the UI —
 * they show as locked "stored" rows that can be replaced or removed.
 */
export function KeyValueEditor({
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder = "Value",
  addLabel,
  keyTransform,
  label,
}: {
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  keyPlaceholder: string;
  valuePlaceholder?: string;
  addLabel: string;
  keyTransform?: (s: string) => string;
  label: string;
}) {
  const id = useId();
  const update = (u: string, patch: Partial<KeyValueRow>) => onChange(rows.map((r) => (r.uid === u ? { ...r, ...patch } : r)));
  const remove = (u: string) => onChange(rows.filter((r) => r.uid !== u));

  return (
    <div className="space-y-2" role="group" aria-label={label}>
      <AnimatePresence initial={false}>
        {rows.map((r, i) => (
          <motion.div
            key={r.uid}
            layout
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, height: 0, marginTop: 0 }}
            className="flex items-start gap-2"
          >
            <Input
              aria-label={`${label} name ${i + 1}`}
              value={r.key}
              readOnly={r.stored}
              onChange={(e) => update(r.uid, { key: keyTransform ? keyTransform(e.target.value) : e.target.value })}
              placeholder={keyPlaceholder}
              className={cn("h-10 w-[42%] shrink-0 font-mono text-[13px]", r.stored && "bg-muted/40 text-muted-foreground")}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <div className="min-w-0 flex-1">
              {r.stored && !r.replacing ? (
                <div className="flex h-10 items-center gap-2 rounded-md border border-dashed px-3 text-xs text-muted-foreground">
                  <Lock className="size-3.5 shrink-0 text-brand-strong" />
                  <span className="truncate font-mono tracking-widest">{SECRET_MASK}</span>
                  <span className="ml-auto hidden shrink-0 sm:inline">stored encrypted</span>
                </div>
              ) : (
                <PasswordInput
                  aria-label={`${label} value ${i + 1}`}
                  value={r.value === SECRET_MASK ? "" : r.value}
                  onChange={(e) => update(r.uid, { value: e.target.value })}
                  placeholder={r.replacing ? "New value" : valuePlaceholder}
                  autoFocus={r.replacing}
                  id={`${id}-v-${r.uid}`}
                />
              )}
            </div>
            {r.stored &&
              (r.replacing ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button type="button" size="icon" variant="ghost" className="size-10" aria-label="Keep stored value" onClick={() => update(r.uid, { replacing: false, value: SECRET_MASK })}>
                      <Undo2 />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Keep stored value</TooltipContent>
                </Tooltip>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button type="button" size="icon" variant="ghost" className="size-10" aria-label={`Replace ${r.key}`} onClick={() => update(r.uid, { replacing: true, value: "" })}>
                      <Pencil />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Replace value</TooltipContent>
                </Tooltip>
              ))}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" size="icon" variant="ghost" className="size-10 text-muted-foreground hover:text-destructive" aria-label={`Remove ${r.key || "row"}`} onClick={() => remove(r.uid)}>
                  <Trash2 />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Remove</TooltipContent>
            </Tooltip>
          </motion.div>
        ))}
      </AnimatePresence>
      <Button type="button" variant="outline" size="sm" className="border-dashed" onClick={() => onChange([...rows, newRow()])}>
        <Plus /> {addLabel}
      </Button>
    </div>
  );
}
