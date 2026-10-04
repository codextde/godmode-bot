import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "No access" };

/** Rendered with status 403 when a page calls forbidden() (requirePermission without the permission). */
export default function Forbidden() {
  return (
    <AuthShell
      mascot="attention"
      title="You don't have access to this page"
      description={
        <>
          <span className="mb-2 block font-mono text-xs tabular-nums">403</span>
          Your role doesn&apos;t include it. Ask an administrator of this cloud if you need it.
        </>
      }
      footer={
        <Button asChild>
          <Link href="/">
            <ArrowLeft /> Go to your computers
          </Link>
        </Button>
      }
    />
  );
}
