import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FolderSearch, Plus, RotateCcw, Save, X } from "lucide-react";
import { toast } from "sonner";
import { MOD_MANIFEST_PATH, type Mod, type ModOption, type ModOptionValue } from "@godmode/shared";
import { FolderPickerDialog } from "@/components/chat/folder-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { PasswordInput } from "@/components/vault/password-input";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { ModActions } from "./use-mod-actions";

/** What a field holds while it is edited: numbers stay text until they are saved. */
type Field = string | boolean | string[];
/** By option key. Missing: untouched · null: taken back to the default. */
type Draft = Partial<Record<string, Field | null>>;

function toField(o: ModOption, v: ModOptionValue | null | undefined): Field {
  if (o.multiple) return Array.isArray(v) ? v.map(String) : v === null || v === undefined || v === "" ? [] : [String(v)];
  if (o.type === "boolean") return v === true;
  return v === null || v === undefined || Array.isArray(v) ? "" : String(v);
}

function same(a: Field, b: Field): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return a === b;
  const x = a.filter(Boolean);
  const y = b.filter(Boolean);
  return x.length === y.length && x.every((s, i) => s === y[i]);
}

/** A form made from the options a mod declares; it saves only what changed, and `null` for what went back to its default. */
export function ModOptions({ mod, actions, onDirtyChange }: { mod: Mod; actions: ModActions; onDirtyChange: (dirty: boolean) => void }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft>({});
  const [showProblems, setShowProblems] = useState(false);

  const hasSecret = (o: ModOption) => o.sensitive && mod.secretKeys.includes(o.key);
  const saved = (o: ModOption): Field => (o.sensitive ? "" : toField(o, o.key in mod.values ? mod.values[o.key] : o.default));
  const fallback = (o: ModOption): Field => (o.sensitive ? "" : toField(o, o.default));
  const current = (o: ModOption): Field => {
    const d = draft[o.key];
    return d === undefined ? saved(o) : d === null ? fallback(o) : d;
  };
  const changed = (o: ModOption): boolean => {
    const d = draft[o.key];
    if (d === undefined) return false;
    if (d === null) return o.key in mod.values || hasSecret(o);
    return o.sensitive ? d !== "" : !same(d, saved(o));
  };
  const resettable = (o: ModOption): boolean => {
    const d = draft[o.key];
    if (o.sensitive) return (hasSecret(o) && d !== null) || (typeof d === "string" && d !== "");
    return !same(current(o), fallback(o));
  };
  const problem = (o: ModOption): string | null => {
    const v = current(o);
    if (o.type === "number" && typeof v === "string") {
      const text = v.trim();
      if (!text) return o.required && o.default === null ? "Enter a number." : null;
      const n = Number(text);
      if (!Number.isFinite(n)) return "Enter a number.";
      if (o.min !== null && n < o.min) return `Enter ${o.min} or more.`;
      if (o.max !== null && n > o.max) return `Enter ${o.max} or less.`;
      return null;
    }
    if (!o.required) return null;
    if (o.sensitive) return v !== "" || (hasSecret(o) && draft[o.key] !== null) ? null : "This mod needs a value here.";
    if (Array.isArray(v)) return v.some(Boolean) ? null : "Add at least one entry.";
    return v === "" ? "This mod needs a value here." : null;
  };

  const dirty = mod.options.some(changed);
  const invalid = mod.options.some((o) => problem(o));
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const set = (o: ModOption, value: Field | null) => setDraft((d) => ({ ...d, [o.key]: value }));

  const save = useMutation({
    mutationFn: (values: Record<string, ModOptionValue | null>) => api.mods.update(mod.id, { values }),
    onSuccess: (next) => {
      actions.put(next);
      setDraft({});
      setShowProblems(false);
      toast.success("Options saved", { description: "They apply from the next message." });
    },
    onError: (e) => toastApiError(e, "Couldn't save the options", qc),
  });

  const submit = () => {
    if (invalid) return setShowProblems(true);
    const values: Record<string, ModOptionValue | null> = {};
    for (const o of mod.options) {
      if (!changed(o)) continue;
      const d = draft[o.key];
      if (d === null || d === undefined) values[o.key] = null;
      else if (Array.isArray(d)) values[o.key] = d.filter(Boolean);
      else if (o.type === "number" && typeof d === "string") values[o.key] = d.trim() ? Number(d) : null;
      else values[o.key] = d;
    }
    save.mutate(values);
  };

  if (mod.options.length === 0) {
    return (
      <p className="p-5 text-sm text-muted-foreground">
        This mod has no options. A mod declares them under <span className="font-mono text-[12.5px] text-foreground/80">userConfig</span> in{" "}
        <span className="font-mono text-[12.5px] text-foreground/80">{MOD_MANIFEST_PATH}</span>.
      </p>
    );
  }

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="min-h-0 flex-1 divide-y overflow-y-auto px-5">
        {mod.options.map((o) => {
          const id = `mod-option-${mod.id}-${o.key}`;
          const hintId = o.description ? `${id}-hint` : undefined;
          const error = problem(o);
          const shownError = error && (showProblems || draft[o.key] !== undefined) ? error : null;
          const describedBy = [shownError ? `${id}-error` : null, hintId].filter(Boolean).join(" ") || undefined;
          const value = current(o);
          const isSwitch = o.type === "boolean" && !o.multiple;
          const canReset = resettable(o);

          let control: ReactNode = null;
          if (Array.isArray(value)) {
            control = o.choices?.length ? (
              <ChoiceToggles id={id} choices={o.choices} values={value} onChange={(v) => set(o, v)} label={o.title} />
            ) : (
              <ListEditor id={id} label={o.title} values={value} onChange={(v) => set(o, v)} describedBy={describedBy} invalid={!!shownError} />
            );
          } else if (typeof value === "string") {
            if (o.sensitive) {
              control = (
                <PasswordInput
                  id={id}
                  value={value}
                  onChange={(e) => set(o, e.target.value)}
                  placeholder={hasSecret(o) ? (draft[o.key] === null ? "The saved value goes when you save" : "A value is saved — type to replace it") : "Not set"}
                  aria-invalid={!!shownError}
                  aria-describedby={describedBy}
                  groupClassName="h-9 @xl:max-w-md"
                />
              );
            } else if (o.choices?.length) {
              control = (
                <Select value={value} onValueChange={(v) => set(o, v)}>
                  <SelectTrigger id={id} className="w-full @xl:w-72" aria-invalid={!!shownError} aria-describedby={describedBy}>
                    <SelectValue placeholder="Choose…" />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    {o.choices.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              );
            } else if (o.type === "number") {
              control = (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Input
                    id={id}
                    type="number"
                    inputMode="decimal"
                    step="any"
                    min={o.min ?? undefined}
                    max={o.max ?? undefined}
                    value={value}
                    onChange={(e) => set(o, e.target.value)}
                    aria-invalid={!!shownError}
                    aria-describedby={describedBy}
                    className="w-36 tabular-nums"
                  />
                  {(o.min !== null || o.max !== null) && (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {o.min !== null && o.max !== null ? `${o.min} to ${o.max}` : o.min !== null ? `${o.min} or more` : `${o.max} or less`}
                    </span>
                  )}
                </div>
              );
            } else if (o.type === "directory") {
              control = <DirectoryInput id={id} value={value} onChange={(v) => set(o, v)} title={o.title} invalid={!!shownError} describedBy={describedBy} />;
            } else {
              control = (
                <Input
                  id={id}
                  value={value}
                  onChange={(e) => set(o, e.target.value)}
                  placeholder={o.type === "file" ? "/path/to/file" : undefined}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={!!shownError}
                  aria-describedby={describedBy}
                  className={cn("@xl:max-w-md", o.type === "file" && "font-mono text-[13px] md:text-[13px]")}
                />
              );
            }
          }

          return (
            <div key={o.key} className="py-5">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <Label htmlFor={id} className="text-sm leading-snug font-medium">
                      {o.title}
                    </Label>
                    <span className="font-mono text-[11px] text-muted-foreground">{o.key}</span>
                    {o.required && <span className="text-[11px] text-muted-foreground">· required</span>}
                  </div>
                  {o.description && (
                    <p id={hintId} className="mt-1 max-w-prose text-xs leading-relaxed text-muted-foreground">
                      {o.description}
                    </p>
                  )}
                </div>
                {/* Always laid out, so the row doesn't jump when a value leaves its default. */}
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={!canReset}
                  onClick={() => set(o, null)}
                  aria-label={`Reset ${o.title} to its default`}
                  className={cn("shrink-0 text-muted-foreground hover:text-foreground", !canReset && "invisible")}
                >
                  <RotateCcw /> Reset
                </Button>
                {isSwitch && <Switch id={id} checked={value === true} onCheckedChange={(v) => set(o, v)} aria-describedby={describedBy} className="mt-0.5 shrink-0" />}
              </div>
              {control && <div className="mt-2.5">{control}</div>}
              {shownError && (
                <p id={`${id}-error`} className="mt-1.5 text-xs text-destructive">
                  {shownError}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t bg-paper-2/70 px-5 py-3">
        <p className="text-xs text-muted-foreground">{dirty ? "Unsaved changes. They apply from the next message once saved." : "Changes apply from the next message."}</p>
        <Button type="submit" size="sm" disabled={!dirty || save.isPending}>
          {save.isPending ? <Spinner /> : <Save />} Save options
        </Button>
      </div>
    </form>
  );
}

/** A list of plain strings — often regular expressions, so they are set in mono. Enter adds a row. */
function ListEditor({
  id,
  label,
  values,
  onChange,
  describedBy,
  invalid,
}: {
  id: string;
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  describedBy?: string;
  invalid?: boolean;
}) {
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const focusNext = useRef<number | null>(null);
  const rows = values.length ? values : [""];

  useEffect(() => {
    if (focusNext.current === null) return;
    inputs.current[focusNext.current]?.focus();
    focusNext.current = null;
  });

  const insert = (at: number, entries: string[] = [""]) => {
    const next = [...rows];
    next.splice(at, 0, ...entries);
    focusNext.current = at + entries.length - 1;
    onChange(next);
  };
  const remove = (at: number) => {
    const next = rows.filter((_, i) => i !== at);
    focusNext.current = Math.max(0, at - 1);
    onChange(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>, i: number) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (rows[i]) insert(i + 1);
    } else if (e.key === "Backspace" && !rows[i] && rows.length > 1) {
      e.preventDefault();
      remove(i);
    }
  };
  // A pasted block of lines becomes one row each.
  const onPaste = (e: ClipboardEvent<HTMLInputElement>, i: number) => {
    const lines = e.clipboardData.getData("text").split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return;
    e.preventDefault();
    if (rows[i]) insert(i + 1, lines);
    else {
      const next = [...rows];
      next.splice(i, 1, ...lines);
      focusNext.current = i + lines.length - 1;
      onChange(next);
    }
  };

  return (
    <div role="group" aria-label={label} className="space-y-1.5">
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <span aria-hidden className="w-5 shrink-0 text-right font-mono text-[10.5px] text-muted-foreground/70 tabular-nums">
            {i + 1}
          </span>
          <Input
            ref={(el) => {
              inputs.current[i] = el;
            }}
            id={i === 0 ? id : undefined}
            aria-label={i === 0 ? undefined : `${label}, entry ${i + 1}`}
            aria-describedby={i === 0 ? describedBy : undefined}
            aria-invalid={invalid && i === 0}
            value={row}
            onChange={(e) => onChange(rows.map((r, j) => (j === i ? e.target.value : r)))}
            onKeyDown={(e) => onKeyDown(e, i)}
            onPaste={(e) => onPaste(e, i)}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="h-8 font-mono text-[12.5px] md:text-[12.5px]"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={rows.length === 1 && !row}
            onClick={() => (rows.length === 1 ? onChange([]) : remove(i))}
            aria-label={`Remove entry ${i + 1}`}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <X />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="xs" className="ml-[26px] border-dashed" onClick={() => insert(rows.length)}>
        <Plus /> Add entry
      </Button>
    </div>
  );
}

/** Several of a fixed set of choices. */
function ChoiceToggles({ id, label, choices, values, onChange }: { id: string; label: string; choices: string[]; values: string[]; onChange: (values: string[]) => void }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {choices.map((c, i) => {
        const on = values.includes(c);
        return (
          <button
            key={c}
            id={i === 0 ? id : undefined}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? values.filter((v) => v !== c) : choices.filter((x) => x === c || values.includes(x)))}
            className={cn(
              "h-7 rounded-md border px-2.5 text-xs font-medium transition outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              on ? "border-foreground/30 bg-paper-2 text-foreground" : "bg-card text-muted-foreground hover:border-foreground/20 hover:text-foreground",
            )}
          >
            {c}
          </button>
        );
      })}
    </div>
  );
}

function DirectoryInput({
  id,
  value,
  onChange,
  title,
  invalid,
  describedBy,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  title: string;
  invalid?: boolean;
  describedBy?: string;
}) {
  const [picking, setPicking] = useState(false);
  return (
    <div className="flex gap-2 @xl:max-w-xl">
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="/path/to/folder"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        className="font-mono text-[13px] md:text-[13px]"
      />
      <Button type="button" variant="outline" onClick={() => setPicking(true)}>
        <FolderSearch /> Browse
      </Button>
      <FolderPickerDialog
        open={picking}
        onOpenChange={setPicking}
        value={value || null}
        onPick={onChange}
        title={title}
        description="A folder on the computer running Godmode."
      />
    </div>
  );
}
