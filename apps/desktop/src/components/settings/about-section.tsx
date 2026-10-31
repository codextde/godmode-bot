import type { ReactNode } from "react";
import { motion } from "motion/react";
import { formatDistanceToNow } from "date-fns";
import { Trans, useTranslation } from "react-i18next";
import { AppWindow, ArrowUpRight, Bot, CircleArrowDown, ExternalLink, Globe, Heart, Layers, Plug, RefreshCw, RotateCw, Scale } from "lucide-react";
import { LICENSE_SITE } from "@godmode/shared";
import { Backdrop, Logo } from "@/components/brand";
import { useRestartToUpdate } from "@/components/layout/update-button";
import { SettingRow, SettingsGroup } from "@/components/settings/settings-kit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { openExternal } from "@/lib/desktop";
import { EASE_OUT } from "@/lib/motion";
import { dateLocale } from "@/i18n";
import { checkForUpdates, setCanaryUpdates, useUpdater } from "@/stores/updater";

export const SITE = LICENSE_SITE;

const CREDITS = [
  { name: "Claude Code", descriptionKey: "about.credits.claude", url: "https://docs.anthropic.com/en/docs/claude-code", icon: <Bot /> },
  { name: "browser-use", descriptionKey: "about.credits.browserUse", url: "https://github.com/browser-use/browser-use", icon: <Globe /> },
  { name: "Composio", descriptionKey: "about.credits.composio", url: "https://composio.dev", icon: <Plug /> },
  { name: "shadcn/ui", descriptionKey: "about.credits.shadcn", url: "https://ui.shadcn.com", icon: <Layers /> },
  { name: "Tauri", descriptionKey: "about.credits.tauri", url: "https://tauri.app", icon: <AppWindow /> },
] as const satisfies readonly { name: string; descriptionKey: string; url: string; icon: ReactNode }[];

export function AboutSection({ version }: { version: string | undefined }) {
  const { t } = useTranslation("settings");
  return (
    <div className="space-y-5">
      <motion.section
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative overflow-hidden rounded-xl border bg-card px-6 py-12 text-center shadow-card"
      >
        <Backdrop className="opacity-70" />
        <div className="relative flex flex-col items-center">
          <motion.div initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.4, ease: EASE_OUT }}>
            <Logo className="size-16" />
          </motion.div>
          <p className="eyebrow mt-6">Godmode Pro · Codext GmbH</p>
          <h2 className="heading-display mt-2 text-[36px]">
            Godmode <span className="text-foreground/35">Bot</span>
          </h2>
          {version && (
            <Badge variant="secondary" className="mt-3 font-mono text-[11px] font-normal tabular-nums">
              v{version}
            </Badge>
          )}
          <p className="mt-3 max-w-md text-balance text-muted-foreground">{t("about.tagline")}</p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Button onClick={() => void openExternal(SITE)}>
              <Globe /> {t("about.website")}
            </Button>
            <Button variant="outline" onClick={() => void openExternal(`${SITE}/legal/terms`)}>
              <Scale /> {t("about.terms")}
            </Button>
          </div>
        </div>
      </motion.section>

      <UpdatesCard version={version} />

      <section className="rounded-xl border bg-card p-5 shadow-card">
        <h3 className="eyebrow flex items-center gap-2">
          <Heart className="size-3.5" /> {t("about.builtOn")}
        </h3>
        <div className="mt-4 grid grid-cols-1 gap-3 @xl:grid-cols-2">
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
                <span className="mt-0.5 block text-xs text-muted-foreground">{t(c.descriptionKey)}</span>
              </span>
            </motion.button>
          ))}
        </div>
        <p className="mt-5 text-center text-xs text-muted-foreground">
          <Trans
            t={t}
            i18nKey="about.footer"
            components={{ link: <button type="button" className="font-medium text-foreground underline-offset-4 hover:underline" onClick={() => void openExternal(`${SITE}/legal/terms`)} /> }}
          />
        </p>
      </section>
    </div>
  );
}

const MB = 1024 * 1024;

function UpdatesCard({ version }: { version: string | undefined }) {
  const { t } = useTranslation("settings");
  const update = useUpdater((s) => s.update);
  const canary = useUpdater((s) => s.canary);
  const { restart, dialog } = useRestartToUpdate();
  if (update.status === "disabled") return null;

  const checkButton = (
    <Button variant="outline" size="sm" onClick={() => void checkForUpdates().catch(() => {})}>
      <RefreshCw /> {t("system.updates.checkNow")}
    </Button>
  );

  let label: ReactNode;
  let description: ReactNode = null;
  let action: ReactNode = checkButton;
  switch (update.status) {
    case "idle":
      label = t("about.updates.idle");
      description = t("about.updates.idleDescription");
      break;
    case "checking":
      label = t("about.updates.checkingLabel");
      action = (
        <Button variant="outline" size="sm" disabled>
          <Spinner className="size-3.5" /> {t("about.updates.checking")}
        </Button>
      );
      break;
    case "upToDate":
      label = t("about.updates.upToDate");
      description = `${version ? t("about.updates.latest", { version }) : t("about.updates.latestInstalled")} · ${t("cleanup.storage.checked", { time: formatDistanceToNow(update.checkedAt, { addSuffix: true, locale: dateLocale() }) })}`;
      break;
    case "downloading": {
      const pct = update.total ? Math.min(100, Math.round((update.downloaded / update.total) * 100)) : null;
      label = t("about.updates.downloading", { version: update.version });
      description = (
        <div className="flex items-center gap-3 pt-1">
          <Progress value={pct ?? 0} className="h-1 max-w-56 bg-foreground/[0.07] [&>[data-slot=progress-indicator]]:bg-brand" />
          <span className="shrink-0 font-mono text-[11px] tabular-nums">
            {pct !== null ? `${pct}%` : `${(update.downloaded / MB).toFixed(1)} MB`}
          </span>
        </div>
      );
      action = null;
      break;
    }
    case "ready":
      label = t("about.updates.ready", { version: update.version });
      description = (
        <>
          {t("about.updates.readyDescription")}{" "}
          <button
            type="button"
            onClick={() => void openExternal(`${SITE}/changelog#v${update.version}`)}
            className="inline-flex items-center gap-0.5 font-medium text-foreground underline-offset-4 hover:underline"
          >
            {t("about.updates.whatsNew")} <ArrowUpRight className="size-3" />
          </button>
        </>
      );
      action = (
        <Button size="sm" onClick={restart}>
          <RotateCw /> {t("about.updates.restart")}
        </Button>
      );
      break;
    case "installing":
      label = t("about.updates.installing", { version: update.version });
      description = t("about.updates.installingDescription");
      action = (
        <Button size="sm" disabled>
          <Spinner className="size-3.5" /> {t("about.updates.restarting")}
        </Button>
      );
      break;
    case "error":
      label = t("system.updates.checkError");
      description = <span className="line-clamp-2 break-all" title={update.message}>{update.message}</span>;
      break;
  }

  return (
    <SettingsGroup
      icon={<CircleArrowDown />}
      title={t("system.updates.title")}
      description={t("about.updates.description")}
    >
      <SettingRow label={label} description={description}>
        {action ?? undefined}
      </SettingRow>
      <SettingRow
        label={t("about.updates.canary")}
        htmlFor="updates-canary"
        description={t("about.updates.canaryDescription")}
      >
        <Switch id="updates-canary" checked={canary} onCheckedChange={(enabled) => void setCanaryUpdates(enabled).catch(() => {})} />
      </SettingRow>
      {dialog}
    </SettingsGroup>
  );
}
