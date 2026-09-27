import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, Globe2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { allTimezones, localTimezone, timezoneOffset } from "./cron";

/** Searchable IANA timezone picker; the local zone is pinned on top. */
export function TimezoneSelect({ value, onChange, id }: { value: string; onChange: (tz: string) => void; id?: string }) {
  const [open, setOpen] = useState(false);
  const local = localTimezone();
  const zones = useMemo(() => allTimezones().filter((z) => z !== local), [local]);
  const pick = (tz: string) => {
    onChange(tz);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button id={id} type="button" variant="outline" role="combobox" aria-expanded={open} className="w-full justify-between font-normal">
          <span className="flex min-w-0 items-center gap-2">
            <Globe2 className="size-4 text-muted-foreground" />
            <span className="truncate">{value.replace(/_/g, " ")}</span>
            <span className="text-xs text-muted-foreground">{timezoneOffset(value)}</span>
          </span>
          <ChevronsUpDown className="size-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) min-w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search timezone…" />
          <CommandList className="max-h-72">
            <CommandEmpty>No timezone found.</CommandEmpty>
            <CommandGroup heading="Your timezone">
              <TzItem tz={local} selected={value === local} onSelect={pick} />
              {value !== local && value !== "UTC" && !zones.includes(value) && (
                <TzItem tz={value} selected onSelect={pick} />
              )}
            </CommandGroup>
            <CommandGroup heading="All timezones">
              {zones.map((tz) => (
                <TzItem key={tz} tz={tz} selected={value === tz} onSelect={pick} />
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function TzItem({ tz, selected, onSelect }: { tz: string; selected: boolean; onSelect: (tz: string) => void }) {
  return (
    <CommandItem value={tz} onSelect={() => onSelect(tz)}>
      <Check className={cn("size-4", selected ? "opacity-100" : "opacity-0")} />
      <span className="truncate">{tz.replace(/_/g, " ")}</span>
    </CommandItem>
  );
}
