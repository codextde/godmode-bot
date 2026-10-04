import { forbidden, redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { editableSettingsGroups } from "@/server/rbac/permissions";
import { settingsHref } from "./_lib/groups";

/** /admin/settings opens the first group the person may edit. */
export default async function SettingsIndexPage() {
  const ctx = await requireUser();
  const [first] = editableSettingsGroups(ctx);
  if (!first) forbidden();
  redirect(settingsHref(first));
}
