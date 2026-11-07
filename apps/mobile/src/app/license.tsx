import { Redirect } from "expo-router";

/** A `godmode://license?key=…` link from the web: a key is entered on the computer, so the phone shows the licence's status. */
export default function LicenseLink() {
  return <Redirect href="/settings/license" />;
}
