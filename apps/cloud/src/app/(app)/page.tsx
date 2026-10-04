import { redirect } from "next/navigation";

/** The signed-in home is the list of computers. */
export default function AppHome() {
  redirect("/devices");
}
