import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { LogOut } from "lucide-react";
import { AuthShell } from "@/components/auth-shell";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import { getSession } from "@/lib/session";
import { logoutAction } from "../actions";
import { shellInfo } from "../_lib/shell";

export const metadata: Metadata = { title: "Sign out" };

/** Signing out is a POST (the button), so a link or an image on another site cannot sign anyone out. */
export default async function LogoutPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const shell = await shellInfo();
  return (
    <AuthShell
      appName={shell.appName}
      legal={shell.legal}
      title="Sign out?"
      description={
        <>
          You are signed in as <span className="font-medium break-all text-foreground">{session.user.email}</span>. Other browsers and devices
          stay signed in.
        </>
      }
    >
      <form action={logoutAction} className="flex flex-col gap-3">
        <SubmitButton pendingLabel="Signing out…" icon={<LogOut />} className="w-full">
          Sign out
        </SubmitButton>
        <Button variant="ghost" asChild className="w-full text-muted-foreground">
          <Link href="/">Stay signed in</Link>
        </Button>
      </form>
    </AuthShell>
  );
}
