import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { Mascot } from "@/components/mascot";
import { PageBody } from "@/components/page";
import { Button } from "@/components/ui/button";

/** notFound() inside the signed-in area (a computer that is not yours, an unknown page) stays inside the shell. */
export default function AppNotFound() {
  return (
    <PageBody className="pt-6 @2xl:pt-8">
      <EmptyState
        art={<Mascot mood="thinking" size={72} />}
        title="This page does not exist"
        description="The link may be old, or what it pointed to is not yours any more."
        action={
          <Button asChild>
            <Link href="/devices">
              <ArrowLeft />
              Go to your computers
            </Link>
          </Button>
        }
      />
    </PageBody>
  );
}
