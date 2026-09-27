import { motion } from "motion/react";
import { Boxes, Layers, ShieldCheck } from "lucide-react";
import { ToolkitLogo } from "./toolkit-logo";

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
  { icon: Boxes, title: "Hundreds of apps", body: "Gmail, Slack, GitHub, Notion, CRMs, calendars — each becomes a set of tools your agents can call." },
  { icon: ShieldCheck, title: "OAuth, not passwords", body: "You sign in on the app's own page. Tokens live in Composio; Godmode only keeps your API key, encrypted." },
  { icon: Layers, title: "Scoped accounts", body: "Connect an account for everyone, one workspace, or a single agent — e.g. work vs. personal Gmail." },
];

/** Shown while Composio isn't configured: what it is and why it's worth two minutes. */
export function ComposioExplainer() {
  return (
    <div className="relative overflow-hidden rounded-xl border bg-card p-6 shadow-card sm:p-8">
      <div className="relative grid items-center gap-8 lg:grid-cols-[1fr_minmax(0,300px)]">
        <div>
          <p className="eyebrow">Composio</p>
          <h3 className="mt-2 text-[22px] leading-tight font-medium tracking-[-0.025em]">Plug your agents into the apps you already use</h3>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            Composio handles sign-in and API plumbing for hundreds of services. Connect an account once and every agent in reach gets
            it as MCP tools — no scraping, no shared passwords.
          </p>
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            {POINTS.map((p, i) => (
              <motion.div
                key={p.title}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 + i * 0.06 }}
                className="rounded-lg border bg-paper-2 p-3.5"
              >
                <p.icon className="size-4 text-foreground" />
                <p className="mt-2 text-sm font-medium">{p.title}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{p.body}</p>
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
              transition={{ delay: 0.15 + i * 0.04, duration: 0.35, ease: [0.2, 0.8, 0.2, 1] }}
              title={NAMES[slug]}
            >
              <ToolkitLogo src={`https://logos.composio.dev/api/${slug}`} name={NAMES[slug]} size="md" />
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}
