import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { getSession } from "@/lib/session";
import { setupGate } from "@/server/setup";
import { getInviteByToken } from "@/server/users/invites";
import { shellInfo } from "../../_lib/shell";
import { JoinView } from "./_components/join-view";

export const metadata: Metadata = { title: "Invitation" };

export default async function InvitePage({ params }: PageProps<"/invite/[token]">) {
  const { token } = await params;
  const [shell, gate] = await Promise.all([shellInfo(), setupGate()]);

  if (gate !== "done") {
    return (
      <AuthShell
        appName={shell.appName}
        legal={shell.legal}
        mascot="working"
        title="This cloud is still being set up"
        description="Your invitation stays valid. Open this link again a little later."
      />
    );
  }

  const [invite, session] = await Promise.all([getInviteByToken(token), getSession()]);
  if (!invite) {
    return (
      <AuthShell
        appName={shell.appName}
        legal={shell.legal}
        announcement={shell.announcement}
        mascot="thinking"
        title="This invitation no longer works"
        description="It was used, withdrawn or has expired. Ask the person who invited you for a new one, or sign in if you already have an account."
        footer={
          <Button asChild>
            <Link href="/login">Go to sign in</Link>
          </Button>
        }
      />
    );
  }

  return (
    <JoinView
      shell={shell}
      token={token}
      email={invite.email}
      inviter={invite.inviter}
      role={invite.role.name}
      signedInAs={session && session.user.email !== invite.email ? session.user.email : null}
    />
  );
}
