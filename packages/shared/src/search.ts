export const SEARCH_MARK_START = "\u0002";
export const SEARCH_MARK_END = "\u0003";

export interface SearchChatHit {
  id: string;
  title: string;
  agentId: string;
  archived: boolean;
  at: string;
  messageId: string | null;
  snippet: string | null;
  titleMatch: boolean;
}

export interface SearchTaskHit {
  id: string;
  number: number;
  title: string;
  status: string;
  archived: boolean;
  snippet: string | null;
}

export interface SearchNoteHit {
  agentId: string;
  path: string;
  line: number;
  heading: string;
  snippet: string;
}

export interface SearchResults {
  query: string;
  corrected: string | null;
  chats: SearchChatHit[];
  tasks: SearchTaskHit[];
  notes: SearchNoteHit[];
  tookMs: number;
}

export function searchSegments(text: string): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  let hit = false;
  let buf = "";
  for (const ch of text) {
    if (ch === SEARCH_MARK_START || ch === SEARCH_MARK_END) {
      if (buf) out.push({ text: buf, hit });
      buf = "";
      hit = ch === SEARCH_MARK_START;
    } else buf += ch;
  }
  if (buf) out.push({ text: buf, hit });
  return out;
}
