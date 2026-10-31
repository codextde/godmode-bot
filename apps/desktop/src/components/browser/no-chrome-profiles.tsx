import { AppWindow, ExternalLink, RefreshCw, ShieldAlert } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { isTauri } from "@/lib/core";
import { openExternal } from "@/lib/desktop";
import { useBootstrap } from "@/lib/hooks";
import { cn } from "@/lib/utils";

const FULL_DISK_ACCESS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

/**
 * Empty state for GET /api/browser/chrome-profiles. On macOS the list stays empty until Godmode has
 * Full Disk Access, because Chrome's data folder is privacy-protected — so explain that and offer a retry.
 */
export function NoChromeProfiles({
  onRetry,
  retrying,
  footer,
  className,
}: {
  onRetry: () => void;
  retrying?: boolean;
  footer?: string;
  className?: string;
}) {
  const { t } = useTranslation("browser");
  const { data: boot } = useBootstrap();
  const mac = boot?.platform === "darwin";

  if (mac)
    return (
      <div className={cn("rounded-lg border border-warning/30 bg-warning/[0.07] p-4 text-sm", className)}>
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-warning" />
          <div className="min-w-0 space-y-1.5">
            <p className="font-medium">{t("noChrome.macTitle")}</p>
            <p className="text-muted-foreground">
              <Trans t={t} i18nKey="noChrome.macBody" components={{ b: <span className="font-medium text-foreground" /> }} />
            </p>
            {footer && <p className="text-xs text-muted-foreground">{footer}</p>}
            <div className="flex flex-wrap gap-2 pt-1.5">
              <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying}>
                {retrying ? <Spinner /> : <RefreshCw />} {t("noChrome.retry")}
              </Button>
              {isTauri && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => openExternal(FULL_DISK_ACCESS_URL).catch(() => toast.error(t("noChrome.openSettingsFailed")))}
                >
                  <ExternalLink /> {t("noChrome.openSettings")}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    );

  return (
    <div className={cn("rounded-lg border border-dashed bg-paper-2/60 p-5 text-center text-sm", className)}>
      <AppWindow className="mx-auto size-6 text-muted-foreground" />
      <p className="mt-2 font-medium">{t("noChrome.noneTitle")}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {t("noChrome.supported")}
        {footer ? ` ${footer}` : ""}
      </p>
      <Button size="sm" variant="outline" className="mt-3" onClick={onRetry} disabled={retrying}>
        {retrying ? <Spinner /> : <RefreshCw />} {t("noChrome.retry")}
      </Button>
    </div>
  );
}
