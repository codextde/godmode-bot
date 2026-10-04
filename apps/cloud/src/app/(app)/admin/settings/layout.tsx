import type { ReactNode } from "react";
import { forbidden } from "next/navigation";
import { Settings } from "lucide-react";
import { PageBody, PageHeader, SectionLayout } from "@/components/page";
import { SectionNav } from "@/components/section-nav";
import { requireUser } from "@/lib/session";
import { editableSettingsGroups } from "@/server/rbac/permissions";
import { SETTINGS_GROUP_META, settingsHref } from "./_lib/groups";

/** Settings frame: the sub-navigation lists only the groups this person may edit; each page checks its own again. */
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const ctx = await requireUser();
  const groups = editableSettingsGroups(ctx);
  if (groups.length === 0) forbidden();
  return (
    <>
      <PageHeader title="Settings" description="How this cloud works for everyone who uses it." icon={<Settings />} />
      <PageBody>
        <SectionLayout
          nav={
            <SectionNav
              label="Settings"
              items={groups.map((group) => ({
                href: settingsHref(group),
                label: SETTINGS_GROUP_META[group].label,
                icon: SETTINGS_GROUP_META[group].icon,
              }))}
            />
          }
        >
          {children}
        </SectionLayout>
      </PageBody>
    </>
  );
}
