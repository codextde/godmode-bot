"use client";

import { AuthRouteError } from "./_components/auth-route-error";

export default function AuthError(props: { error: Error & { digest?: string }; retry: () => void }) {
  return <AuthRouteError {...props} />;
}
