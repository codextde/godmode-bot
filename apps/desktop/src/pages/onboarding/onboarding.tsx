import type { Bootstrap } from "@godmode/shared";

export function OnboardingPage({ bootstrap }: { bootstrap: Bootstrap }) {
  return <div className="p-8">Welcome — {bootstrap.version}</div>;
}
