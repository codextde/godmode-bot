"use client";

import { AuthRouteError } from "@/app/(auth)/_components/auth-route-error";

export default function SetupError(props: { error: Error & { digest?: string }; retry: () => void }) {
  return <AuthRouteError {...props} title="Could not load the setup" home={{ href: "/setup", label: "Back to setup" }} />;
}
