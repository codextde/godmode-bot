import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "react-native";
import type { Agent, Effort, Project, Settings, Workspace } from "@godmode/shared";
import { api, errorText, type AgentPatch, type ProjectPatch, type SettingsPatch, type WorkspacePatch } from "./api";
import { qk, queryClient } from "./query";

export function useSettings() {
  return useQuery({ queryKey: qk.settings, queryFn: api.settings.get });
}

/** The values `base` had at the keys `patch` changes: undoes one save without undoing another. */
function before(base: unknown, patch: unknown): unknown {
  if (typeof base !== "object" || base === null || typeof patch !== "object" || patch === null || Array.isArray(patch)) return base;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) out[k] = before((base as Record<string, unknown>)[k], (patch as Record<string, unknown>)[k]);
  return out;
}

function merge<T>(base: T, patch: unknown): T {
  if (typeof base !== "object" || base === null || typeof patch !== "object" || patch === null || Array.isArray(patch)) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) out[k] = merge(out[k], v);
  return out as T;
}

/** Quiet saves (text as it is typed) report failures inline instead of with an alert. */
type Options = { quiet?: boolean };

function failed(err: unknown, opts?: Options): false {
  if (!opts?.quiet) Alert.alert("Couldn't save", errorText(err));
  return false;
}

/** Shows on the phone right away; goes back when the computer refuses it. */
export async function patchSettings(patch: SettingsPatch, opts?: Options): Promise<boolean> {
  const prev = queryClient.getQueryData<Settings>(qk.settings);
  const undo = before(prev, patch);
  if (prev) queryClient.setQueryData(qk.settings, merge(prev, patch));
  try {
    queryClient.setQueryData(qk.settings, await api.settings.update(patch));
    void queryClient.invalidateQueries({ queryKey: qk.bootstrap });
    return true;
  } catch (err) {
    queryClient.setQueryData<Settings>(qk.settings, (now) => (now ? merge(now, undo) : now));
    return failed(err, opts);
  }
}

function setWorkspace(id: string, fn: (w: Workspace) => Workspace) {
  queryClient.setQueryData<Workspace[]>(qk.workspaces, (list) => list?.map((w) => (w.id === id ? fn(w) : w)));
}

export async function patchWorkspace(id: string, patch: WorkspacePatch, opts?: Options): Promise<boolean> {
  const { sources: _, ...shown } = patch;
  const undo = before(queryClient.getQueryData<Workspace[]>(qk.workspaces)?.find((w) => w.id === id), shown);
  setWorkspace(id, (w) => ({ ...w, ...shown }));
  try {
    const next = await api.workspace.update(id, patch);
    setWorkspace(id, () => next);
    return true;
  } catch (err) {
    setWorkspace(id, (w) => merge(w, undo));
    return failed(err, opts);
  }
}

function setProject(id: string, fn: (p: Project) => Project) {
  queryClient.setQueryData<Workspace[]>(qk.workspaces, (list) => list?.map((w) => ({ ...w, projects: w.projects.map((p) => (p.id === id ? fn(p) : p)) })));
}

export async function patchProject(id: string, patch: ProjectPatch, opts?: Options): Promise<boolean> {
  const { sources: _, ...shown } = patch;
  const project = queryClient.getQueryData<Workspace[]>(qk.workspaces)?.flatMap((w) => w.projects).find((p) => p.id === id);
  const undo = before(project, shown);
  setProject(id, (p) => ({ ...p, ...shown }));
  try {
    const next = await api.projects.update(id, patch);
    setProject(id, () => next);
    return true;
  } catch (err) {
    setProject(id, (p) => merge(p, undo));
    return failed(err, opts);
  }
}

function setAgent(id: string, fn: (a: Agent) => Agent) {
  queryClient.setQueryData<Agent[]>(qk.agents, (list) => list?.map((a) => (a.id === id ? fn(a) : a)));
}

export async function patchAgent(id: string, patch: AgentPatch, opts?: Options): Promise<boolean> {
  const undo = before(queryClient.getQueryData<Agent[]>(qk.agents)?.find((a) => a.id === id), patch);
  setAgent(id, (a) => merge(a, patch));
  try {
    const next = await api.agents.update(id, patch);
    setAgent(id, () => next);
    return true;
  } catch (err) {
    setAgent(id, (a) => merge(a, undo));
    return failed(err, opts);
  }
}

export type SaveState = "idle" | "saving" | "saved" | "failed";

/**
 * Text that saves itself: a moment after typing stops, when the field loses focus and when the screen closes. Follows
 * the computer's value while nothing is being edited.
 */
export function useAutosave(value: string, save: (next: string) => Promise<boolean>, delayMs = 900) {
  const [draft, setDraftState] = useState(value);
  const [state, setState] = useState<SaveState>("idle");
  const current = useRef(value);
  const saved = useRef(value);
  const dirty = useRef(false);
  const running = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saver = useRef(save);

  useEffect(() => {
    saver.current = save;
  }, [save]);

  useEffect(() => {
    // The computer trims what it stores: that's still what is being typed here (a trailing newline stays).
    if (dirty.current || value === saved.current.trim()) return;
    current.current = value;
    saved.current = value;
    setDraftState(value);
  }, [value]);

  const flush = useCallback(async (): Promise<void> => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    // One save at a time; the next one sends whatever was typed meanwhile.
    while (running.current) await running.current;
    if (!dirty.current) return;
    const next = current.current;
    if (next.trim() === saved.current.trim()) {
      dirty.current = false;
      return;
    }
    setState("saving");
    running.current = saver.current(next).then((ok) => {
      if (ok) saved.current = next;
      if (current.current === next) dirty.current = !ok;
      setState(ok ? "saved" : "failed");
    });
    await running.current;
    running.current = null;
  }, []);

  const setDraft = useCallback(
    (next: string) => {
      current.current = next;
      dirty.current = true;
      setDraftState(next);
      setState("idle");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), delayMs);
    },
    [delayMs, flush],
  );

  useEffect(() => () => void flush(), [flush]);

  return { draft, setDraft, flush, state };
}

/** Text that shows the computer's value until you edit it; `done` hands back what changed (null when nothing did). */
export function useEditable(value: string) {
  const [draft, setDraft] = useState<string | null>(null);
  const done = () => {
    const next = draft?.trim() ?? null;
    setDraft(null);
    return next !== null && next !== value.trim() ? next : null;
  };
  return { text: draft ?? value, setText: setDraft, done };
}

/** Effort names short enough for a segmented control. */
export const EFFORT_SHORT: Record<Effort, string> = { low: "Low", medium: "Med", high: "High", xhigh: "X-High", max: "Max" };

export function lineCount(text: string): number {
  return text.split("\n").filter((l) => l.trim()).length;
}

export function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean)
      ?.replace(/^([-*]|\d+[.)])\s+/, "") ?? ""
  );
}
