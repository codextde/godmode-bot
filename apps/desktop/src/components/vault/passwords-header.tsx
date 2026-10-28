import type { ReactNode } from "react";
import { NavLink } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Fingerprint, KeyRound, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/common";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

export const PASSWORD_TABS = ["/vault/logins", "/vault/2fa", "/vault/passkeys"] as const;

/** One screen for what agents sign in with: the title, a tab each for logins, 2FA codes and passkeys, and the tab's actions. */
export function PasswordsHeader({ actions }: { actions?: ReactNode }) {
  const logins = useQuery({ queryKey: qk.credentialList("all", ""), queryFn: () => api.credentials.list({ workspaceId: "all" }) });
  const codes = useQuery({ queryKey: qk.totpList("all"), queryFn: () => api.totp.list({ workspaceId: "all" }) });
  const passkeys = useQuery({ queryKey: qk.passkeyList("all"), queryFn: () => api.passkeys.list({ workspaceId: "all" }) });
  const tabs = [
    { to: PASSWORD_TABS[0], label: "Logins", icon: <KeyRound />, count: logins.data?.length },
    { to: PASSWORD_TABS[1], label: "2FA codes", icon: <ShieldCheck />, count: codes.data?.length },
    { to: PASSWORD_TABS[2], label: "Passkeys", icon: <Fingerprint />, count: passkeys.data?.length },
  ];
  return (
    <>
      <PageHeader
        icon={<KeyRound />}
        title="Passwords"
        description="The logins, 2FA codes and passkeys your agents sign in with. Encrypted on this computer; agents never see the secrets."
        actions={actions}
        className="pb-4 @2xl:pb-5"
      />
      <div className="px-5 pb-5 @2xl:px-8">
        <nav aria-label="Passwords" className="scroll-fade-x -mx-1 flex overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="inline-flex h-10 shrink-0 items-center rounded-lg bg-muted p-1">
            {tabs.map((t) => (
              <NavLink
                key={t.to}
                to={t.to}
                className={({ isActive }) =>
                  cn(
                    "inline-flex h-full items-center gap-2 rounded-md border border-transparent px-3.5 text-sm font-medium whitespace-nowrap text-foreground/60 outline-none transition-all hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:text-muted-foreground dark:hover:text-foreground [&_svg]:size-4 [&_svg]:shrink-0",
                    isActive && "bg-background text-foreground shadow-sm dark:border-input dark:bg-input/30 dark:text-foreground",
                  )
                }
              >
                {t.icon}
                {t.label}
                {t.count !== undefined && (
                  <span className="min-w-5 rounded-[5px] bg-foreground/[0.07] px-1.5 text-center font-mono text-[10.5px] leading-4 text-foreground/70 tabular-nums">{t.count}</span>
                )}
              </NavLink>
            ))}
          </div>
        </nav>
      </div>
    </>
  );
}
