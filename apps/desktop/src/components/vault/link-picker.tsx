import { useMemo, useState, type ReactNode } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { Favicon } from "./favicon";

export interface LinkPickerItem {
  id: string;
  title: string;
  subtitle?: string | null;
  domain?: string | null;
  suggested?: boolean;
}

const LIMIT = 50;

/** Searchable picker for linking a vault item; renders only the best matches so huge vaults stay fast. */
export function LinkPicker({
  id,
  value,
  onChange,
  items,
  loading,
  noneLabel,
  searchPlaceholder,
  noun,
  autoFocus,
}: {
  id?: string;
  value: string | null;
  onChange: (id: string | null) => void;
  items: LinkPickerItem[];
  loading?: boolean;
  noneLabel: string;
  searchPlaceholder: string;
  noun: string;
  autoFocus?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const indexed = useMemo(
    () => items.map((item) => ({ item, haystack: `${item.title} ${item.subtitle ?? ""} ${item.domain ?? ""}`.toLowerCase() })),
    [items],
  );
  const selected = useMemo(() => items.find((i) => i.id === value) ?? null, [items, value]);

  const { suggested, rest, total, hidden } = useMemo(() => {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = tokens.length ? indexed.filter((x) => tokens.every((t) => x.haystack.includes(t))).map((x) => x.item) : items;
    const top = hits.filter((i) => i.suggested || i.id === value).slice(0, LIMIT);
    const others = hits.filter((i) => !i.suggested && i.id !== value).slice(0, LIMIT - top.length);
    return { suggested: top, rest: others, total: hits.length, hidden: hits.length - top.length - others.length };
  }, [indexed, items, query, value]);

  const pick = (next: string | null) => {
    onChange(next);
    setOpen(false);
  };

  return (
    <Popover
      modal
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <Button id={id} type="button" variant="outline" role="combobox" aria-expanded={open} autoFocus={autoFocus} className="w-full justify-between px-3 font-normal">
          {selected ? (
            <span className="flex min-w-0 items-center gap-2.5">
              <Favicon domain={selected.domain} name={selected.title} size="xs" />
              <span className="truncate">
                {selected.title}
                {selected.subtitle && <span className="text-muted-foreground"> · {selected.subtitle}</span>}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">{noneLabel}</span>
          )}
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) min-w-64 overflow-hidden rounded-xl p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput value={query} onValueChange={setQuery} placeholder={searchPlaceholder} />
          <CommandList className="max-h-[min(20rem,50vh)] scroll-py-1">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Spinner /> Loading {noun}s…
              </div>
            ) : (
              <CommandEmpty>No {noun} matches “{query}”.</CommandEmpty>
            )}
            {!query && (
              <CommandGroup>
                <Row value="__none__" selected={!value} onSelect={() => pick(null)}>
                  <span className="text-muted-foreground">{noneLabel}</span>
                </Row>
              </CommandGroup>
            )}
            {suggested.length > 0 && (
              <CommandGroup heading={query ? "Best matches" : "Suggested"}>
                {suggested.map((item) => (
                  <ItemRow key={item.id} item={item} selected={item.id === value} onSelect={pick} />
                ))}
              </CommandGroup>
            )}
            {rest.length > 0 && (
              <CommandGroup heading={query ? (suggested.length ? "Other matches" : `${total.toLocaleString()} ${total === 1 ? "match" : "matches"}`) : `All ${noun}s`}>
                {rest.map((item) => (
                  <ItemRow key={item.id} item={item} selected={item.id === value} onSelect={pick} />
                ))}
              </CommandGroup>
            )}
            {hidden > 0 && (
              <p className="px-3 pt-1 pb-3 text-xs text-muted-foreground">
                {hidden.toLocaleString()} more {query ? "matches" : `${noun}s`}. Keep typing to narrow it down.
              </p>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function ItemRow({ item, selected, onSelect }: { item: LinkPickerItem; selected: boolean; onSelect: (id: string) => void }) {
  return (
    <Row value={item.id} selected={selected} onSelect={() => onSelect(item.id)}>
      <Favicon domain={item.domain} name={item.title} size="xs" />
      <span className="min-w-0 flex-1 truncate">
        {item.title}
        {item.subtitle && <span className="text-muted-foreground"> · {item.subtitle}</span>}
      </span>
    </Row>
  );
}

function Row({ value, selected, onSelect, children }: { value: string; selected: boolean; onSelect: () => void; children: ReactNode }) {
  return (
    <CommandItem value={value} onSelect={onSelect} className="gap-2.5 py-1.5">
      {children}
      <Check className={cn("ml-auto size-4 shrink-0", selected ? "opacity-100" : "opacity-0")} />
    </CommandItem>
  );
}
