import type { LucideIcon } from "lucide-react";
import { Blocks, CalendarClock, Hand, Radar, Webhook } from "lucide-react";
import type { AutomationEventSource, AutomationEventStatus, Routine, RoutineTriggerType } from "@godmode/shared";
import { t } from "@/i18n";
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
    get label() {
      return t("automations:trigger.schedule.label");
    },
    get plural() {
      return t("automations:trigger.schedule.plural");
    },
    get title() {
      return t("automations:trigger.schedule.title");
    },
    get hint() {
      return t("automations:trigger.schedule.hint");
    },
    get runLabel() {
      return t("automations:trigger.schedule.runLabel");
    },
    get promptPlaceholder() {
      return t("automations:trigger.schedule.promptPlaceholder");
    },
  },
  app: {
    icon: Blocks,
    get label() {
      return t("automations:trigger.app.label");
    },
    get plural() {
      return t("automations:trigger.app.plural");
    },
    get title() {
      return t("automations:trigger.app.title");
    },
    get hint() {
      return t("automations:trigger.app.hint");
    },
    get runLabel() {
      return t("automations:trigger.app.runLabel");
    },
    get promptPlaceholder() {
      return t("automations:trigger.app.promptPlaceholder");
    },
  },
  condition: {
    icon: Radar,
    get label() {
      return t("automations:trigger.condition.label");
    },
    get plural() {
      return t("automations:trigger.condition.plural");
    },
    get title() {
      return t("automations:trigger.condition.title");
    },
    get hint() {
      return t("automations:trigger.condition.hint");
    },
    get runLabel() {
      return t("automations:trigger.condition.runLabel");
    },
    get promptPlaceholder() {
      return t("automations:trigger.condition.promptPlaceholder");
    },
  },
  webhook: {
    icon: Webhook,
    get label() {
      return t("automations:trigger.webhook.label");
    },
    get plural() {
      return t("automations:trigger.webhook.plural");
    },
    get title() {
      return t("automations:trigger.webhook.title");
    },
    get hint() {
      return t("automations:trigger.webhook.hint");
    },
    get runLabel() {
      return t("automations:trigger.webhook.runLabel");
    },
    get promptPlaceholder() {
      return t("automations:trigger.webhook.promptPlaceholder");
    },
  },
};

/** Easy mode: the same triggers in everyday words. */
export const EASY_TRIGGER_TEXT: Record<RoutineTriggerType, { title: string; hint: string }> = {
  schedule: {
    get title() {
      return t("automations:trigger.easy.schedule.title");
    },
    get hint() {
      return t("automations:trigger.easy.schedule.hint");
    },
  },
  app: {
    get title() {
      return t("automations:trigger.easy.app.title");
    },
    get hint() {
      return t("automations:trigger.easy.app.hint");
    },
  },
  condition: {
    get title() {
      return t("automations:trigger.easy.condition.title");
    },
    get hint() {
      return t("automations:trigger.easy.condition.hint");
    },
  },
  webhook: {
    get title() {
      return t("automations:trigger.easy.webhook.title");
    },
    get hint() {
      return t("automations:trigger.easy.webhook.hint");
    },
  },
};

export const TRIGGER_ORDER: RoutineTriggerType[] = ["schedule", "app", "condition", "webhook"];

/** App and webhook automations react to incoming events (and can be tested with a sample one). */
export function isEventTrigger(type: RoutineTriggerType): boolean {
  return type === "app" || type === "webhook";
}

/** Plain-text trigger description — for search, compact lists and tooltips. */
export function triggerText(routine: Routine): string {
  const trigger = routine.trigger;
  switch (trigger.type) {
    case "schedule":
      return scheduleToHuman(routine.cron, trigger.startWindowMinutes, trigger.runsPerWindow);
    case "app":
      return `${trigger.triggerName} · ${prettySlug(trigger.toolkit)}`;
    case "condition":
      return t("automations:trigger.conditionText", { condition: trigger.condition, schedule: lowerFirst(cronToHuman(routine.cron)) });
    case "webhook":
      return t("automations:trigger.webhook.label");
  }
}

export function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

export const EVENT_SOURCES: Record<AutomationEventSource, { label: string; icon: LucideIcon }> = {
  schedule: {
    icon: CalendarClock,
    get label() {
      return t("automations:eventSource.schedule");
    },
  },
  app: {
    icon: Blocks,
    get label() {
      return t("automations:eventSource.app");
    },
  },
  webhook: {
    icon: Webhook,
    get label() {
      return t("automations:eventSource.webhook");
    },
  },
  condition: {
    icon: Radar,
    get label() {
      return t("automations:eventSource.condition");
    },
  },
  manual: {
    icon: Hand,
    get label() {
      return t("automations:eventSource.manual");
    },
  },
};

export const EVENT_STATUS: Record<AutomationEventStatus, { label: string; className: string; dot: string }> = {
  pending: {
    className: "border-warning/25 bg-warning/[0.08] text-warning",
    dot: "bg-warning",
    get label() {
      return t("automations:eventStatus.pending");
    },
  },
  running: {
    className: "border-brand/25 bg-brand-soft text-brand-strong",
    dot: "bg-brand animate-live-dot",
    get label() {
      return t("automations:eventStatus.running");
    },
  },
  done: {
    className: "border-success/20 bg-success/[0.08] text-success",
    dot: "bg-success",
    get label() {
      return t("automations:eventStatus.done");
    },
  },
  failed: {
    className: "border-destructive/20 bg-destructive/[0.06] text-destructive",
    dot: "bg-destructive",
    get label() {
      return t("automations:eventStatus.failed");
    },
  },
  skipped: {
    className: "border-border bg-secondary text-muted-foreground",
    dot: "bg-muted-foreground/60",
    get label() {
      return t("automations:eventStatus.skipped");
    },
  },
};
