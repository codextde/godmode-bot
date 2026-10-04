import { redirect } from "next/navigation";

/** Plans live on the billing overview. */
export default function PlansIndexPage() {
  redirect("/admin/billing#plans");
}
