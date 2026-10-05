import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { getSession } from "@/lib/session";
import { isOwner } from "@/server/rbac/permissions";
import { getSettings } from "@/server/settings";
import { setupGate, setupStartedBy } from "@/server/setup";
import { ownerStep } from "./_lib/steps";
import { ClaimWizard, OwnerWizard } from "./_components/wizard";

export const metadata: Metadata = { title: "Setup" };

/**
 * First run. Nobody has an account: the claim step. The owner exists: they continue where they left off; anyone else
 * is told who started and asked to sign in. Finished: the proxy already sends people to the start page.
 */
export default async function SetupPage({ searchParams }: PageProps<"/setup">) {
  const params = await searchParams;
  const gate = await setupGate();
  if (gate === "done") redirect("/");
  const { appName } = await getSettings("general");
  if (gate === "claim") return <ClaimWizard appName={appName} />;

  const session = await getSession();
  if (!session) {
    const startedBy = await setupStartedBy();
    return (
      <AuthShell
        appName={appName}
        mascot="working"
        title="Setup has started"
        description={
          <>
            {startedBy ? (
              <>
                Setup was started by <span className="font-mono text-foreground">{startedBy}</span>. Sign in as the owner to continue.
              </>
            ) : (
              "Sign in as the owner to continue."
            )}
          </>
        }
        footer={
          <Button asChild>
            <Link href="/login?next=%2Fsetup">Sign in to continue</Link>
          </Button>
        }
      />
    );
  }
  if (!isOwner(session)) {
    return (
      <AuthShell
        appName={appName}
        mascot="thinking"
        title="This cloud is still being set up"
        description={
          <>
            You are signed in as <span className="font-medium break-all text-foreground">{session.user.email}</span>, but only an owner can finish
            the setup. Come back once it is done.
          </>
        }
        footer={
          <Button variant="outline" asChild>
            <Link href="/logout">Sign out</Link>
          </Button>
        }
      />
    );
  }
  return <OwnerWizard step={ownerStep(params.step)} ctx={session} />;
}
