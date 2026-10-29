/** Assistants whose memory can be brought into Godmode (Settings → Memory → Import). */
export const MEMORY_SOURCES = [
  { id: "chatgpt", label: "ChatGPT", url: "https://chatgpt.com/" },
  { id: "claude", label: "Claude", url: "https://claude.ai/new" },
  { id: "gemini", label: "Gemini", url: "https://gemini.google.com/app" },
  { id: "other", label: "Another assistant", url: null },
] as const;

export type MemorySource = (typeof MEMORY_SOURCES)[number]["id"];

/** Pasted into the other assistant: it writes out everything it remembers about the human, ready to import. */
export const MEMORY_EXPORT_PROMPT = `I'm moving to a new AI assistant. Write out everything you remember about me — from your saved memory and from our past conversations — so it can pick up where you left off.

Use these sections, one fact per line, with dates where you know them:
- About me: name, where I live, languages, job, family
- Work: company, role, projects, colleagues and clients, tools I use
- How I like answers: tone, format, length, language
- Preferences and limits: likes, dislikes, things to never do
- Ongoing: goals, plans, deadlines and open tasks
- Anything else you know about me

Leave nothing out, add nothing you aren't sure of, and put it all in one code block.`;

export const IMPORT_MAX_CHARS = 100_000;

export interface ImportMemoryInput {
  source: MemorySource;
  text: string;
}
