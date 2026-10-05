import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <AuthShell
      mascot="thinking"
      title="This page does not exist"
      description={
        <>
          <span className="mb-2 block font-mono text-xs tabular-nums">404</span>
          The link may be old, or the page has moved.
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
