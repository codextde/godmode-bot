import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, ExternalLink, Link2 } from "lucide-react";
import { toast } from "sonner";
import type { MessagingConnection } from "@godmode/shared";
import { CopyButton } from "@/components/chat/copy-button";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { api, errorMessage } from "@/lib/api";
import { openExternal, saveBlob } from "@/lib/desktop";

/** The address Azure delivers Teams messages to (null until the public address is set). */
export function teamsEndpoint(c: MessagingConnection): string | null {
  if (!c.config.publicUrl || !c.endpointPath) return null;
  return `${c.config.publicUrl}${c.endpointPath}`;
}

export async function downloadTeamsApp(c: MessagingConnection) {
  try {
    const blob = await api.messaging.teamsApp(c.id);
    const name = `${c.name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "godmode"}-teams-app.zip`;
    if (await saveBlob(blob, name)) toast.success(t("messaging:teams.appSaved"), { description: t("messaging:teams.appSavedDescription") });
  } catch (err) {
    toast.error(t("messaging:teams.appError"), { description: errorMessage(err) });
  }
}

function Step({ n, title, children }: { n: number; title: string; children?: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-px grid size-5 shrink-0 place-items-center rounded-full border bg-card font-mono text-[10.5px] text-muted-foreground">{n}</span>
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm">{title}</p>
        {children}
      </div>
    </li>
  );
}

/** What's left after connecting a Teams bot: the endpoint in Azure, the app in Teams. */
export function TeamsFinishSteps({ connection }: { connection: MessagingConnection }) {
  const { t } = useTranslation("messaging");
  const endpoint = teamsEndpoint(connection);
  const [downloading, setDownloading] = useState(false);
  return (
    <ol className="space-y-4">
      <Step n={1} title={t("teams.step1")}>
        {endpoint ? (
          <div className="flex items-center gap-1 rounded-lg border bg-paper-2 py-1 pr-1 pl-2.5">
            <Link2 className="size-3.5 shrink-0 text-muted-foreground" />
            <code className="min-w-0 flex-1 truncate font-mono text-[12px]" title={endpoint}>
              {endpoint}
            </code>
            <CopyButton text={endpoint} label={t("teams.copyEndpoint")} size="xs" showLabel />
          </div>
        ) : (
          <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">{t("teams.needPublicUrl")}</p>
        )}
      </Step>
      <Step n={2} title={t("teams.step2")}>
        <Button
          size="sm"
          variant="outline"
          disabled={downloading}
          onClick={async () => {
            setDownloading(true);
            await downloadTeamsApp(connection);
            setDownloading(false);
          }}
        >
          <Download /> {t("teams.download")}
        </Button>
      </Step>
      <Step n={3} title={t("teams.step3")}>
        {connection.bot.url && (
          <Button size="sm" variant="outline" onClick={() => void openExternal(connection.bot.url!)}>
            <ExternalLink /> {t("teams.openInTeams")}
          </Button>
        )}
      </Step>
    </ol>
  );
}
