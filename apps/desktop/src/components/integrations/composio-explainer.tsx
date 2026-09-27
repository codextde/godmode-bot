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
    <div className="relative overflow-hidden rounded-2xl border bg-card/40 p-6 sm:p-8">
      <div aria-hidden className="pointer-events-none absolute -top-24 -right-24 size-72 rounded-full bg-glow-a/15 blur-3xl" />
      <div aria-hidden className="pointer-events-none absolute -bottom-24 -left-16 size-64 rounded-full bg-glow-b/10 blur-3xl" />
      <div className="relative grid items-center gap-8 lg:grid-cols-[1fr_minmax(0,300px)]">
        <div>
          <p className="text-xs font-semibold tracking-[0.16em] text-primary uppercase">Composio</p>
          <h3 className="mt-2 text-xl font-semibold tracking-tight">Plug your agents into the apps you already use</h3>
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
                className="rounded-xl border bg-background/40 p-3.5"
              >
                <p.icon className="size-4 text-primary" />
                <p className="mt-2 text-sm font-medium">{p.title}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{p.body}</p>
              </motion.div>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-5 gap-3 justify-self-center" aria-hidden>
          {SHOWCASE.map((slug, i) => (
            <motion.div
              key={slug}
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1, y: [0, i % 2 ? -5 : 5, 0] }}
              transition={{
                opacity: { delay: 0.15 + i * 0.04 },
                scale: { delay: 0.15 + i * 0.04, type: "spring", stiffness: 260, damping: 18 },
                y: { duration: 5 + (i % 3), repeat: Infinity, ease: "easeInOut", delay: i * 0.3 },
              }}
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
