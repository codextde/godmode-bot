import { Check, Globe, ShieldCheck, TriangleAlert } from "lucide-react";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import type { Agent, MessagingAccess, MessagingProvider } from "@godmode/shared";
import { AgentAvatar } from "@/components/common";
import { cn } from "@/lib/utils";

/** Pick the agents a bot talks to; the first one is where new chats start. */
export function AgentChooser({
  agents,
  value,
  defaultId,
  onChange,
  disabled,
}: {
  agents: Agent[];
  value: string[];
  defaultId: string | null;
  onChange: (ids: string[], defaultId: string | null) => void;
  disabled?: boolean;
}) {
  const toggle = (id: string) => {
    if (value.includes(id)) {
      const next = value.filter((x) => x !== id);
      onChange(next, defaultId === id ? (next[0] ?? null) : defaultId);
    } else onChange([...value, id], defaultId ?? id);
  };

  return (
    <ul className="max-h-72 divide-y overflow-y-auto rounded-xl border bg-card shadow-card" role="group" aria-label="Agents">
      {agents.map((a) => {
        const on = value.includes(a.id);
        const first = on && defaultId === a.id;
        return (
          <li key={a.id} className="group/agent relative">
            <button
              type="button"
              role="checkbox"
              aria-checked={on}
              disabled={disabled}
              onClick={() => toggle(a.id)}
              className={cn(
                "flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition hover:bg-accent/40 focus-visible:bg-accent/50 focus-visible:outline-none disabled:opacity-60",
                on && "bg-accent/25",
              )}
            >
              <span
                className={cn(
                  "grid size-[18px] shrink-0 place-items-center rounded-[5px] border transition",
                  on ? "border-foreground bg-foreground text-background" : "border-input bg-background",
                )}
              >
                {on && <Check className="size-3" strokeWidth={3} />}
              </span>
              <AgentAvatar agent={a} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium">{a.name}</span>
                  {!a.enabled && <span className="rounded-[4px] border px-1 text-[10px] text-muted-foreground">Off</span>}
                </span>
                {a.description && <span className="block truncate text-xs text-muted-foreground">{a.description}</span>}
              </span>
              <span className="w-24 shrink-0" />
            </button>
            {on && (
              <button
                type="button"
                disabled={disabled || first}
                onClick={() => onChange(value, a.id)}
                className={cn(
                  "absolute top-1/2 right-3 -translate-y-1/2 rounded-[5px] px-1.5 py-0.5 text-[11px] font-medium transition",
                  first
                    ? "bg-brand-soft text-brand-strong"
                    : "text-muted-foreground opacity-0 group-hover/agent:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100",
                )}
              >
                {first ? "Starts here" : "Start here"}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function openAccessText(provider: MessagingProvider, team: string | null): string {
  if (provider === "telegram") return "Anyone who finds the bot can use these agents — with the logins and tools they have.";
  if (provider === "slack") return `Everyone in ${team ?? "the Slack workspace"} can talk to the bot without asking.`;
  return "Everyone in your organization who can reach the bot can use it without asking.";
}

/** Who may talk to a bot. */
export function AccessChooser({
  provider,
  team,
  value,
  onChange,
  disabled,
}: {
  provider: MessagingProvider;
  team: string | null;
  value: MessagingAccess;
  onChange: (value: MessagingAccess) => void;
  disabled?: boolean;
}) {
  const options: { value: MessagingAccess; icon: typeof ShieldCheck; title: string; text: string; tag?: string }[] = [
    {
      value: "approved",
      icon: ShieldCheck,
      title: "People you approve",
      text: "Someone new writes → you get a request here and decide. Recommended.",
    },
    { value: "anyone", icon: Globe, title: "Anyone", text: openAccessText(provider, team), tag: provider === "telegram" ? "Public" : undefined },
  ];
  return (
    <RadioGroupPrimitive.Root
      value={value}
      onValueChange={(v) => onChange(v as MessagingAccess)}
      disabled={disabled}
      aria-label="Who can talk to the bot"
      className="grid gap-2 sm:grid-cols-2"
    >
      {options.map((o) => {
        const on = value === o.value;
        return (
          <RadioGroupPrimitive.Item
            key={o.value}
            value={o.value}
            className={cn(
              "flex items-start gap-3 rounded-xl border bg-card p-3.5 text-left shadow-card transition hover:border-foreground/20 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60",
              on && "border-foreground/40 ring-1 ring-foreground/15",
            )}
          >
            <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg border bg-paper-2", on && "bg-foreground text-background")}>
              <o.icon className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                {o.title}
                {o.tag && (
                  <span className="inline-flex items-center gap-1 rounded-[4px] bg-warning/12 px-1 text-[10px] font-medium text-warning">
                    <TriangleAlert className="size-2.5" /> {o.tag}
                  </span>
                )}
              </span>
              <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{o.text}</span>
            </span>
          </RadioGroupPrimitive.Item>
        );
      })}
    </RadioGroupPrimitive.Root>
  );
}
