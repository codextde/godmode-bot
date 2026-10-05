import type { ReactNode } from "react";
import { requirePermission } from "@/lib/session";
import { PAGE_PERMISSIONS } from "@/server/rbac/permissions";

/** The admin area. Every page below checks its own permission as well; this gate keeps everyone else out. */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requirePermission(PAGE_PERMISSIONS["/admin"]);
  return children;
}
