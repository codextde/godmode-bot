import { File, Paths } from "expo-file-system";
import { useState } from "react";
import { create } from "zustand";
import { useSession } from "./session";

/** The form of a new agent that wasn't created yet, by the role it started from (`SCRATCH` without one). */
export interface AgentDraft {
  templateId: string;
  name: string;
  role: string;
  instructions: string;
  workspaceId: string;
  at: number;
}

export type AgentDraftFields = Omit<AgentDraft, "templateId" | "at">;

interface Stored {
  drafts: Record<string, AgentDraft>;
  /** The unsent "describe it" box. */
  describe: string;
}

export const SCRATCH = "scratch";

const SAVE_AFTER_MS = 400;
const VERSION = 1;

/** On this phone only, and gone with the pairing. Too long for the secure store; a cache folder could lose it. */
const file = () => new File(Paths.document, "godmode-agent-drafts.json");

export const useAgentDrafts = create<Stored>(() => ({ drafts: {}, describe: "" }));

let timer: ReturnType<typeof setTimeout> | null = null;
let loaded = false;

function save() {
  timer = null;
  try {
    const { drafts, describe } = useAgentDrafts.getState();
    const device = useSession.getState().connection?.deviceId;
    file().writeSync(JSON.stringify({ v: VERSION, device, drafts, describe }));
  } catch {
    /* the next change tries again */
  }
}

function change(patch: Partial<Stored>) {
  useAgentDrafts.setState(patch);
  timer ??= setTimeout(save, SAVE_AFTER_MS);
}

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const saved = file();
    if (!saved.exists) return;
    const { v, device, drafts, describe } = JSON.parse(saved.textSync()) as Stored & { v: number; device?: string };
    if (v === VERSION && device === useSession.getState().connection?.deviceId) useAgentDrafts.setState({ drafts, describe });
    else saved.delete();
  } catch {
    forgetAgentDrafts();
  }
}

/** Reads what the last session left, once: call it where drafts show. */
export function useLoadAgentDrafts() {
  useState(load);
}

export function keepAgentDraft(templateId: string, fields: AgentDraftFields) {
  const { drafts } = useAgentDrafts.getState();
  change({ drafts: { ...drafts, [templateId]: { ...fields, templateId, at: Date.now() } } });
}

export function dropAgentDraft(templateId: string) {
  const { drafts } = useAgentDrafts.getState();
  if (!drafts[templateId]) return;
  const { [templateId]: _gone, ...rest } = drafts;
  change({ drafts: rest });
}

export const setDescribeDraft = (describe: string) => change({ describe });

export function forgetAgentDrafts() {
  if (timer) clearTimeout(timer);
  timer = null;
  loaded = false;
  useAgentDrafts.setState({ drafts: {}, describe: "" });
  try {
    const saved = file();
    if (saved.exists) saved.delete();
  } catch {
    /* nothing to forget */
  }
}
