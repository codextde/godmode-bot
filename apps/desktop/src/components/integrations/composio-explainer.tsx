import { motion } from "motion/react";
import { Boxes, Layers, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ToolkitLogo, toolkitLogoUrl } from "./toolkit-logo";
import { EASE_OUT } from "@/lib/motion";

const SHOWCASE = ["gmail", "slack", "github", "notion", "googlecalendar", "linear", "hubspot", "jira", "googledrive", "stripe"];
const NAMES: Record<string, string> = {
  gmail: "Gmail",
  slack: "Slack",
  github: "GitHub",
  notion: "Notion",
  googlecalendar: "Google Calendar",
  linear: "Linear",
  hubspot: "HubSpot",
  jira: "Jira",
  googledrive: "Google Drive",
  stripe: "Stripe",
};

const POINTS = [
  { icon: Boxes, title: "explainer.apps.title", body: "explainer.apps.body" },
  { icon: ShieldCheck, title: "explainer.oauth.title", body: "explainer.oauth.body" },
  { icon: Layers, title: "explainer.scoped.title", body: "explainer.scoped.body" },
] as const;

/** Shown while Composio isn't configured: what it is and why it's worth two minutes. */
export function ComposioExplainer() {
  const { t } = useTranslation("integrations");
  return (
    <div className="relative overflow-hidden rounded-xl border bg-card p-5 shadow-card @2xl:p-8">
      <div className="relative grid grid-cols-1 items-center gap-8 @5xl:grid-cols-[1fr_minmax(0,300px)]">
        <div>
          <p className="eyebrow">Composio</p>
          <h3 className="mt-2 text-[22px] leading-tight font-medium tracking-[-0.025em]">{t("explainer.title")}</h3>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            {t("explainer.description")}
          </p>
          <div className="mt-6 grid grid-cols-1 gap-3 @3xl:grid-cols-3">
            {POINTS.map((p, i) => (
              <motion.div
                key={p.title}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 + i * 0.06 }}
                className="rounded-lg border bg-paper-2 p-3.5"
              >
                <p.icon className="size-4 text-foreground" />
                <p className="mt-2 text-sm font-medium">{t(p.title)}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t(p.body)}</p>
              </motion.div>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-5 gap-3 justify-self-center rounded-xl border bg-paper-2 bg-dots p-5" aria-hidden>
          {SHOWCASE.map((slug, i) => (
            <motion.div
              key={slug}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.15 + i * 0.04, duration: 0.35, ease: EASE_OUT }}
              title={NAMES[slug]}
            >
              <ToolkitLogo src={toolkitLogoUrl(slug)} name={NAMES[slug]} size="md" />
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}
