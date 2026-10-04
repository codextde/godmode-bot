/** What every signed-out page shows around its content: the cloud's name, legal links and the announcement. */
import { DEFAULT_APP_NAME } from "@/components/brand";
import type { Announcement, LegalInfo } from "@/components/shell-parts";
import { getSettings } from "@/server/settings";

export interface ShellInfo {
  appName: string;
  legal: LegalInfo;
  announcement: Announcement | null;
}

export async function shellInfo(): Promise<ShellInfo> {
  const general = await getSettings("general");
  return {
    appName: general.appName.trim() || DEFAULT_APP_NAME,
    legal: {
      termsUrl: general.termsUrl,
      privacyUrl: general.privacyUrl,
      imprintUrl: general.imprintUrl,
      supportEmail: general.supportEmail,
    },
    announcement: general.announcement.trim() ? { text: general.announcement, tone: general.announcementTone } : null,
  };
}
