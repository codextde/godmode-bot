import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { confirmWithBiometrics, NeedsFullAccess, needsFullAccess, useFullAccess } from "./full-access";
import type { IconName } from "./icon";
import { FormSkeleton } from "./settings-state";
import { ErrorState } from "./ui";
import { errorText } from "@/lib/api";

export { confirmWithBiometrics, NeedsFullAccess, useFullAccess };

/** The computer refused this phone: it has no full access (any more). */
export const isRefused = needsFullAccess;

/** A screen only full-access phones use: the lock state for the others, a skeleton while that is unknown. */
export function FullAccessGate({ children, skeleton }: { children: ReactNode; skeleton?: ReactNode }) {
  const { fullAccess } = useFullAccess();
  if (fullAccess === undefined) return <>{skeleton ?? <FormSkeleton />}</>;
  if (!fullAccess) return <NeedsFullAccess />;
  return <>{children}</>;
}

/** Like QueryState, for full-access routes: a refusal shows the lock state instead of "update Godmode". */
export function AdminQueryState<T>({
  query,
  errorTitle,
  skeleton,
  children,
}: {
  query: UseQueryResult<T>;
  icon?: IconName;
  errorTitle: string;
  skeleton?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (query.data !== undefined) return <>{children(query.data)}</>;
  if (query.isLoading || query.isPending) return <>{skeleton ?? <FormSkeleton />}</>;
  if (isRefused(query.error)) return <NeedsFullAccess />;
  return <ErrorState title={errorTitle} error={errorText(query.error)} onRetry={() => void query.refetch()} />;
}
