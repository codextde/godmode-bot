import { motion } from "motion/react";
import { AppWindow, Bot, Code, ExternalLink, Globe, Heart, Layers, Plug, Scale } from "lucide-react";
import type { ReactNode } from "react";
import { Backdrop, Logo } from "@/components/brand";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { openExternal } from "@/lib/desktop";

const REPO = "https://github.com/codextde/godmode-bot";

const CREDITS: { name: string; description: string; url: string; icon: ReactNode }[] = [
  { name: "Claude Code", description: "The agentic brain behind every coworker.", url: "https://docs.anthropic.com/en/docs/claude-code", icon: <Bot /> },
  { name: "browser-use", description: "Lets agents see and drive a real browser.", url: "https://github.com/browser-use/browser-use", icon: <Globe /> },
  { name: "Composio", description: "Hundreds of app integrations with managed OAuth.", url: "https://composio.dev", icon: <Plug /> },
  { name: "shadcn/ui", description: "Beautiful, accessible building blocks for the UI.", url: "https://ui.shadcn.com", icon: <Layers /> },
  { name: "Tauri", description: "A tiny, secure native shell for the desktop app.", url: "https://tauri.app", icon: <AppWindow /> },
];

export function AboutSection({ version }: { version: string | undefined }) {
  return (
    <div className="space-y-5">
      <motion.section
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative overflow-hidden rounded-xl border bg-card px-6 py-12 text-center shadow-card"
      >
        <Backdrop className="opacity-70" />
        <div className="relative flex flex-col items-center">
          <motion.div initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.4, ease: [0.2, 0.8, 0.2, 1] }}>
            <Logo className="size-16" />
          </motion.div>
          <p className="eyebrow mt-6">Open source · MIT</p>
          <h2 className="heading-display mt-2 text-[36px]">
            Godmode <span className="text-foreground/35">Bot</span>
          </h2>
          {version && (
            <Badge variant="secondary" className="mt-3 font-mono text-[11px] font-normal tabular-nums">
              v{version}
            </Badge>
          )}
          <p className="mt-3 max-w-md text-balance text-muted-foreground">An AI teammate you can trust to get work done.</p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Button onClick={() => void openExternal(REPO)}>
              <Code /> Source on GitHub
            </Button>
            <Button variant="outline" onClick={() => void openExternal(`${REPO}/blob/main/LICENSE`)}>
              <Scale /> MIT License
            </Button>
          </div>
        </div>
      </motion.section>

      <section className="rounded-xl border bg-card p-5 shadow-card">
        <h3 className="eyebrow flex items-center gap-2">
          <Heart className="size-3.5" /> Built on the shoulders of
        </h3>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {CREDITS.map((c, i) => (
            <motion.button
              key={c.name}
              type="button"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(i, 12) * 0.03 }}
              onClick={() => void openExternal(c.url)}
              className="group flex items-start gap-3 rounded-lg border bg-card p-3.5 text-left transition hover:border-foreground/15 hover:shadow-float focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-paper-2 text-foreground [&_svg]:size-4">{c.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  {c.name}
                  <ExternalLink className="size-3 text-muted-foreground opacity-0 transition group-hover:opacity-100" />
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{c.description}</span>
              </span>
            </motion.button>
          ))}
        </div>
        <p className="mt-5 text-center text-xs text-muted-foreground">Open source under the MIT License. Made with care for people who'd rather delegate.</p>
      </section>
    </div>
  );
}
