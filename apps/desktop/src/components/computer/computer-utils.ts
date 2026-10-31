import type { ComputerDisplay, ComputerTab, ComputerTarget, ComputerWindow } from "@godmode/shared";
import { computerView } from "@godmode/shared";
import { t as translate } from "@/i18n";

export function windowTarget(w: ComputerWindow): ComputerTarget {
  return { kind: "window", windowId: w.id, pid: w.pid, app: w.app, title: w.title, bundleId: w.bundleId };
}

export function displayTarget(d: ComputerDisplay): ComputerTarget {
  return { kind: "display", displayId: d.id, name: d.name };
}

export function tabTarget(t: ComputerTab): ComputerTarget {
  return { kind: "tab", profileId: t.profileId, targetId: t.targetId, title: t.title, url: t.url };
}

/** Views to show for a shared target: one per display for the whole desktop. */
export function viewsOf(target: ComputerTarget, displays: ComputerDisplay[] | undefined): { view: string; label: string }[] {
  if (target.kind === "desktop") {
    const list = displays?.length ? displays : [];
    if (!list.length) return [{ view: computerView(target), label: translate("computer:primaryDisplay") }];
    return [...list].sort((a, b) => Number(b.primary) - Number(a.primary)).map((d) => ({ view: `display:${d.id}`, label: d.name }));
  }
  return [{ view: computerView(target), label: "" }];
}

/** How the agent works with it — shown next to shares. */
export function controlNote(target: ComputerTarget): string {
  switch (target.kind) {
    case "window":
      return translate("computer:control.window");
    case "tab":
      return translate("computer:control.tab");
    default:
      return translate("computer:control.desktop");
  }
}

/** First letters of an app for its fallback icon tile. */
export function appInitials(app: string): string {
  const words = app.replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  return (words.length === 1 ? words[0]!.slice(0, 2) : words[0]![0]! + words[1]![0]!).toUpperCase();
}
