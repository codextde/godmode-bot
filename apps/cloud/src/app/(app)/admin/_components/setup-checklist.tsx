import Link from "next/link";
import { ArrowRight, Check, ListChecks } from "lucide-react";
import { SettingsGroup } from "@/components/settings-kit";
import { Button } from "@/components/ui/button";

export interface ChecklistItem {
  id: string;
  title: string;
  description: string;
  done: boolean;
  optional?: boolean;
  /** Where to finish it; null when the fix happens outside the admin area (the environment). */
  href: string | null;
  cta?: string;
}

/** Onboarding steps that were skipped or are still open, each with the way to finish it. */
export function SetupChecklist({ items }: { items: ChecklistItem[] }) {
  const open = items.filter((i) => !i.done).length;
  return (
    <SettingsGroup
      title="Finish setting up"
      description={open === 1 ? "One step from the setup is still open." : `${open} steps from the setup are still open.`}
      icon={<ListChecks />}
    >
      {items.map((item) => (
        <div key={item.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
          <div className="flex min-w-0 flex-1 basis-56 items-start gap-3">
            <span
              aria-hidden
              className={
                item.done
                  ? "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-brand-soft text-brand-strong [&_svg]:size-3"
                  : "mt-0.5 size-5 shrink-0 rounded-full border border-dashed"
              }
            >
              {item.done && <Check />}
            </span>
            <div className="min-w-0">
              <p className={item.done ? "text-sm text-muted-foreground line-through decoration-muted-foreground/50" : "text-sm font-medium"}>
                {item.title}
                {item.optional && !item.done && <span className="ml-1.5 text-xs font-normal text-muted-foreground">optional</span>}
              </p>
              {!item.done && <p className="text-xs leading-relaxed text-muted-foreground">{item.description}</p>}
            </div>
          </div>
          {!item.done && item.href && (
            <Button variant="outline" size="sm" asChild>
              <Link href={item.href}>
                {item.cta ?? "Open"}
                <ArrowRight />
              </Link>
            </Button>
          )}
        </div>
      ))}
    </SettingsGroup>
  );
}
