import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { Laptop } from "lucide-react";
import { logoutAction } from "@/app/(auth)/actions";
import { AppShell } from "@/components/app-shell";
import type { CommandEntry } from "@/components/command-palette";
import { buildNav, SIDEBAR_COOKIE } from "@/components/nav";
import { requireUser } from "@/lib/session";
import { listDevicesFor } from "@/server/devices";
import { isOwner } from "@/server/rbac/permissions";
import { relayHub } from "@/server/relay-bridge";
import { getSettings } from "@/server/settings";

/** The signed-in frame: sidebar by permission, the person's computers in the command palette, cloud-wide notices. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const ctx = await requireUser();
  const [general, email, devices, store] = await Promise.all([
    getSettings("general"),
    getSettings("email"),
    listDevicesFor(ctx.user.id),
    cookies(),
  ]);
  const owner = isOwner(ctx);
  const hub = relayHub();
  const commands: CommandEntry[] = devices.map(({ device, role }) => {
    const online = device.status === "active" && hub.isOnline(device.id);
    return {
      id: `device:${device.id}`,
      label: device.name,
      group: "Computers",
      // A computer that is not connected has nothing to open; its page says why.
      href: online ? `/d/${device.id}/` : `/devices/${device.id}`,
      icon: <Laptop />,
      keywords: ["computer", "open", device.platform],
      hint: online ? (role === "owner" ? "Online" : "Online · shared with you") : "Offline",
    };
  });
  const sidebar = store.get(SIDEBAR_COOKIE)?.value;

  return (
    <AppShell
      user={{ name: ctx.user.name, email: ctx.user.email, roleName: ctx.role.name }}
      nav={buildNav({ permissions: ctx.role.permissions, isOwner: owner })}
      legal={{
        termsUrl: general.termsUrl,
        privacyUrl: general.privacyUrl,
        imprintUrl: general.imprintUrl,
        supportEmail: general.supportEmail,
      }}
      announcement={general.announcement.trim() ? { text: general.announcement, tone: general.announcementTone } : null}
      // Only owners may edit the e-mail settings, so only they are told that delivery is not set up.
      emailNotice={owner && email.transport === "log"}
      onSignOut={logoutAction}
      commands={commands}
      appName={general.appName}
      sidebarCollapsed={sidebar === "collapsed" ? true : sidebar === "expanded" ? false : undefined}
    >
      {children}
    </AppShell>
  );
}
