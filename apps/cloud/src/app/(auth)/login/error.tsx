"use client";

import { AuthRouteError } from "../_components/auth-route-error";

export default function RouteError(props: { error: Error & { digest?: string }; retry: () => void }) {
  return <AuthRouteError {...props} title="Could not load the sign-in page" />;
}
