import type { DeviceGroup, GroupDevice, RemoteRunner, RunnerState } from "@godmode/shared";
import { THIS_COMPUTER } from "@/components/runners/runner-parts";
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
  /** A runner from an older setup on a computer that is in the group now: what that computer is called here. */
  twinOf: string | null;
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

/** The name inside a sentence: a runner twin says it is the runner, next to the computer of the same name. */
export function placeName(place: Place): string {
  return place.twinOf ? `${place.name} (runner)` : place.name;
}

/** Whether to tag it "Runner": in a group runners sit next to full computers, which may carry the same name. */
export function isRunnerPlace(place: Place | null, inGroup: boolean): boolean {
  return !!place && inGroup && !place.here && place.kind === "runner";
}

/** A runner from before device groups: its chats keep working, but nothing new goes there. */
export function isOlderRunner(place: Place | null): boolean {
  return !!place && !place.here && place.kind === "runner";
}

export function usePlaces(): Places {
  const { data: runners = [] } = useRunners();
  const { data: group } = useDeviceGroup();
  const role = group?.role ?? null;
  // A secondary shows its primary's Godmode while the primary is there; while it isn't, its own (where it is null).
  const forwarded = role === "secondary" && !!group?.primaryOnline;
  const hereId = forwarded ? (group?.selfId ?? null) : null;
  const twins = new Map<string, GroupDevice>();
  for (const d of group?.devices ?? []) if (d.runnerTwin) twins.set(d.runnerTwin, d);
  const twinName = (id: string) => {
    const d = twins.get(id);
    return d ? (d.self ? THIS_COMPUTER : d.name) : null;
  };

  const places: Place[] = [];
  if (forwarded) {
    const self = runners.find((r) => r.id === hereId) ?? null;
    places.push({ runnerId: hereId, name: THIS_COMPUTER, here: true, kind: "device", state: "online", runner: self, twinOf: null });
    places.push({
      runnerId: null,
      name: group?.primaryName ?? "Primary",
      here: false,
      kind: "primary",
      state: group?.primaryOnline ? "online" : "offline",
      runner: null,
      twinOf: null,
    });
  } else {
    places.push({ runnerId: null, name: THIS_COMPUTER, here: true, kind: role === "primary" ? "primary" : "runner", state: "online", runner: null, twinOf: null });
  }
  const later: Place[] = [];
  for (const r of runners) {
    if (r.id === hereId) continue;
    const place: Place = { runnerId: r.id, name: r.name, here: false, kind: r.kind === "device" ? "device" : "runner", state: r.state, runner: r, twinOf: role && r.kind !== "device" ? twinName(r.id) : null };
    (place.twinOf ? later : places).push(place);
  }
  // Each runner twin right after the computer it is the old runner of.
  for (const twin of later) {
    const device = twins.get(twin.runnerId!)!;
    const at = places.findIndex((p) => p.runnerId === device.id && p.kind !== "runner");
    places.splice(at < 0 ? places.length : at + 1, 0, twin);
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
