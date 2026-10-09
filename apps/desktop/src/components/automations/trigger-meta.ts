import type { LucideIcon } from "lucide-react";
import { Blocks, CalendarClock, Hand, Radar, Webhook } from "lucide-react";
import type { AutomationEventSource, AutomationEventStatus, Routine, RoutineTriggerType } from "@godmode/shared";
import { cronToHuman, scheduleToHuman } from "@/components/agents/cron";
import { prettySlug } from "@/components/integrations/toolkit-logo";

export interface TriggerTypeMeta {
  icon: LucideIcon;
  /** Short noun for filters and badges. */
  label: string;
  /** Filter chip label (plural). */
  plural: string;
  /** Picker title, reads as the start of a sentence. */
  title: string;
  hint: string;
  /** Tooltip / label of the item's primary action. */
  runLabel: string;
  /** Placeholder for "What should it do?". */
  promptPlaceholder: string;
}

export const TRIGGER_TYPES: Record<RoutineTriggerType, TriggerTypeMeta> = {
  schedule: {
    icon: CalendarClock,
    label: "Schedule",
    plural: "Schedule",
    title: "On a schedule",
    hint: "Every morning, each Monday, on the 1st…",
    runLabel: "Run now",
    promptPlaceholder: "Collect last week's numbers from Stripe and Google Analytics, write a short report and send it to me.",
  },
  app: {
    icon: Blocks,
    label: "App event",
    plural: "App events",
    title: "When something happens in an app",
    hint: "A new email, Slack message, calendar event…",
    runLabel: "Send test event",
    promptPlaceholder: "Save the invoice PDF to Drive and log sender, amount and due date in my Invoices sheet. The event details are passed along.",
  },
  condition: {
    icon: Radar,
    label: "Condition",
    plural: "Conditions",
    title: "When a condition is met",
    hint: "Checked regularly, in plain language",
    runLabel: "Check now",
    promptPlaceholder: "Compare their new plans with ours and update the pricing battlecard in Notion. What the check found is passed along.",
  },
  webhook: {
    icon: Webhook,
    label: "Webhook",
    plural: "Webhooks",
    title: "When a webhook is called",
    hint: "Any service that can send an HTTP POST",
    runLabel: "Send test event",
    promptPlaceholder: "Check whether the order qualifies for a recovery offer and draft a friendly email. The request body is passed along.",
  },
};

export const TRIGGER_ORDER: RoutineTriggerType[] = ["schedule", "app", "condition", "webhook"];

/** App and webhook automations react to incoming events (and can be tested with a sample one). */
export function isEventTrigger(type: RoutineTriggerType): boolean {
  return type === "app" || type === "webhook";
}

/** Plain-text trigger description — for search, compact lists and tooltips. */
export function triggerText(routine: Routine): string {
  const t = routine.trigger;
  switch (t.type) {
    case "schedule":
      return scheduleToHuman(routine.cron, t.startWindowMinutes, t.runsPerWindow);
    case "app":
      return `${t.triggerName} · ${prettySlug(t.toolkit)}`;
    case "condition":
      return `When ${t.condition} · checked ${lowerFirst(cronToHuman(routine.cron))}`;
    case "webhook":
      return "Webhook";
  }
}

export function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

export const EVENT_SOURCES: Record<AutomationEventSource, { label: string; icon: LucideIcon }> = {
  schedule: { label: "Schedule", icon: CalendarClock },
  app: { label: "App event", icon: Blocks },
  webhook: { label: "Webhook", icon: Webhook },
  condition: { label: "Condition met", icon: Radar },
  manual: { label: "Manual", icon: Hand },
};

export const EVENT_STATUS: Record<AutomationEventStatus, { label: string; className: string; dot: string }> = {
  pending: { label: "Waiting", className: "border-warning/25 bg-warning/[0.08] text-warning", dot: "bg-warning" },
  running: { label: "Running", className: "border-brand/25 bg-brand-soft text-brand-strong", dot: "bg-brand animate-live-dot" },
  done: { label: "Done", className: "border-success/20 bg-success/[0.08] text-success", dot: "bg-success" },
  failed: { label: "Failed", className: "border-destructive/20 bg-destructive/[0.06] text-destructive", dot: "bg-destructive" },
  skipped: { label: "Skipped", className: "border-border bg-secondary text-muted-foreground", dot: "bg-muted-foreground/60" },
};
