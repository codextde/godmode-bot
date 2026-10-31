import { useId, type ReactNode } from "react";
import { Link } from "react-router";
import { motion } from "motion/react";
import { ArrowRight } from "lucide-react";
import type { Settings } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useSettingsPatch } from "./settings-kit";

export const FEATURES = ["activity", "artifacts", "integrations", "plugins", "messaging", "phone", "cards", "vm", "ssh", "android"] as const;
export type Feature = (typeof FEATURES)[number];

export const featureOn = (settings: Pick<Settings, Feature> | undefined, feature: Feature) => !!settings?.[feature].enabled;

/** The Settings section of each feature (phone calls and VMs keep their older ids). */
export const FEATURE_SECTION: Record<Feature, string> = {
  activity: "activity",
  artifacts: "artifacts",
  integrations: "integrations",
  plugins: "plugins",
  messaging: "messaging",
  phone: "calls",
  cards: "cards",
  vm: "vms",
  ssh: "ssh",
  android: "android",
};

/** Pages in the sidebar that belong to a feature: they leave it while the feature is off. */
export const PAGE_FEATURE: Record<string, Feature> = {
  "/activity": "activity",
  "/calls": "phone",
  "/plugins": "plugins",
  "/vault/cards": "cards",
  "/vms": "vm",
  "/ssh": "ssh",
};

export const pageOn = (settings: Pick<Settings, Feature> | undefined, path: string) => {
  const feature = PAGE_FEATURE[path];
  return !feature || !settings || featureOn(settings, feature);
};

/**
 * An optional feature's home in Settings: its switch and what it does at the top, then the feature itself — or, while
 * it is off, what it would bring and a way to turn it on.
 */
export function FeatureSection({
  feature,
  settings,
  title,
  summary,
  icon,
  points,
  offNote = "Agents don't get its tools while it's off. Turn it on whenever you need it.",
  children,
}: {
  feature: Feature;
  settings: Settings;
  title: string;
  summary: string;
  icon: ReactNode;
  points: { icon: ReactNode; text: string }[];
  offNote?: string;
  children: ReactNode;
}) {
  const { patch } = useSettingsPatch();
  const on = featureOn(settings, feature);
  const id = useId();
  const set = (enabled: boolean) => patch({ [feature]: { enabled } });
  const off = `${title} ${title.endsWith("s") ? "are" : "is"} off`;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1 basis-72">
          <h2 className="text-[22px] leading-tight font-medium tracking-[-0.025em]">{title}</h2>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">{summary}</p>
        </div>
        <label
          htmlFor={id}
          className="flex shrink-0 cursor-pointer items-center gap-2.5 rounded-full border bg-card py-1.5 pr-1.5 pl-3.5 shadow-card transition hover:border-foreground/15"
        >
          <span className={cn("text-[13px] font-medium tabular-nums", on ? "text-foreground" : "text-muted-foreground")}>{on ? "On" : "Off"}</span>
          <Switch id={id} checked={on} onCheckedChange={set} aria-label={`${title}: ${on ? "on" : "off"}`} />
        </label>
      </header>

      {on ? (
        <motion.div key="on" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
          {children}
        </motion.div>
      ) : (
        <motion.section
          key="off"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
          aria-label={off}
          className="@container rounded-xl border border-dashed bg-card/60 px-5 py-8 text-center @xl:px-8"
        >
          <div className="mx-auto grid size-11 place-items-center rounded-xl border bg-card text-foreground shadow-card [&_svg]:size-5">{icon}</div>
          <p className="mt-4 text-[15px] font-medium tracking-[-0.01em]">{off}</p>
          <p className="mx-auto mt-1 max-w-sm text-[13px] text-muted-foreground">{offNote}</p>
          <ul className="mx-auto mt-6 grid max-w-2xl gap-2 text-left @xl:grid-cols-3">
            {points.map((p) => (
              <li key={p.text} className="flex items-start gap-2.5 rounded-lg border bg-card px-3 py-2.5 text-xs leading-relaxed text-muted-foreground shadow-card">
                <span className="mt-px shrink-0 text-foreground [&_svg]:size-3.5">{p.icon}</span>
                {p.text}
              </li>
            ))}
          </ul>
          <Button className="mt-6" onClick={() => set(true)}>
            Turn on {title}
          </Button>
        </motion.section>
      )}
    </div>
  );
}

/** A feature whose home is its own page: where to find it while it's on. */
export function FeaturePageLink({ to, icon, title, description }: { to: string; icon: ReactNode; title: string; description: string }) {
  return (
    <Link
      to={to}
      className="group flex items-center gap-4 rounded-xl border bg-card px-5 py-4 shadow-card outline-none transition hover:border-foreground/15 focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-lg border bg-paper-2 text-foreground [&_svg]:size-[18px]">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-[13px] text-muted-foreground">{description}</span>
      </span>
      <ArrowRight className="size-4 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-foreground" />
    </Link>
  );
}
