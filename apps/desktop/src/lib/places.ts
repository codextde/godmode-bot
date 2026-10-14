import type { DeviceGroup, RemoteRunner, RunnerState } from "@godmode/shared";
import { useDeviceGroup, useRunners } from "./hooks";

/**
 * Where a chat can work, as this app names it. `runnerId` is what the API calls the place (null = the computer the
 * API belongs to: this one, or on a secondary of a device group its primary, whose Godmode the app shows).
 */
export interface Place {
  runnerId: string | null;
  name: string;
  /** The computer this app runs on. */
  here: boolean;
  kind: "primary" | "device" | "runner";
  state: RunnerState;
  runner: RemoteRunner | null;
}

export interface Places {
  group: DeviceGroup | undefined;
  /** In a device group. */
  inGroup: boolean;
  /** What this computer is called in `runnerId` terms: null on its own or as the primary, its id on a secondary. */
  hereId: string | null;
  places: Place[];
  placeOf(runnerId: string | null): Place | null;
  isHere(runnerId: string | null): boolean;
}

export function usePlaces(): Places {
  const { data: runners = [] } = useRunners();
  const { data: group } = useDeviceGroup();
  const role = group?.role ?? null;
  // A secondary shows its primary's Godmode while the primary is there; while it isn't, its own (where it is null).
  const forwarded = role === "secondary" && !!group?.primaryOnline;
  const hereId = forwarded ? (group?.selfId ?? null) : null;
  const places: Place[] = [];
  if (forwarded) {
    const self = runners.find((r) => r.id === hereId) ?? null;
    places.push({ runnerId: hereId, name: "This Mac", here: true, kind: "device", state: "online", runner: self });
    places.push({
      runnerId: null,
      name: group?.primaryName ?? "Primary",
      here: false,
      kind: "primary",
      state: group?.primaryOnline ? "online" : "offline",
      runner: null,
    });
  } else {
    places.push({ runnerId: null, name: "This Mac", here: true, kind: role === "primary" ? "primary" : "runner", state: "online", runner: null });
  }
  for (const r of runners) {
    if (r.id === hereId) continue;
    places.push({ runnerId: r.id, name: r.name, here: false, kind: r.kind === "device" ? "device" : "runner", state: r.state, runner: r });
  }
  return {
    group,
    inGroup: role !== null,
    hereId,
    places,
    placeOf: (runnerId) => places.find((p) => p.runnerId === runnerId) ?? null,
    isHere: (runnerId) => runnerId === hereId,
  };
}
