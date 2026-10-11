/**
 * A decision or question an agent left for the human in the answer it finished with, instead of asking with a tool
 * (`ask_human`, `request_approval`): "## Decision for you", "What I need from you:", or a closing question such as
 * "Should I take it live?". Godmode puts it on the human's task list (services/humanTasks.ts `noteOpenDecision`), so
 * work that looks finished doesn't quietly wait for an answer nobody was asked for.
 *
 * A heuristic over English and German, like the missing-login one (stream.ts): a section whose heading says it is for
 * the human to decide, else a closing question to them. Offers of extra work ("Want me to also …?") and pleasantries
 * ("Anything else?") are not decisions.
 */

export interface OpenDecision {
  /** The question in one sentence. */
  title: string;
  /** The section or paragraph it stands in (Markdown), "" when the title says it all. */
  body: string;
}

const TITLE_MAX = 200;
const BODY_MAX = 4000;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "you", or the human by name. */
function youOf(human: string): string {
  const names = [...new Set([human.trim(), human.trim().split(/\s+/)[0] ?? ""].filter((n) => n.length > 1))];
  return `(?:you|${["dich", "sie", "euch", ...names.map(escapeRe)].join("|")})`;
}

function headingPatterns(human: string): RegExp[] {
  const you = youOf(human);
  return [
    new RegExp(`\\b(?:decisions?|questions?|choices?|approvals?)\\b.{0,30}\\b(?:for|from)\\s+${you}\\b`, "i"),
    /\b(?:your|ihre|deine|eure)\s+(?:decision|call|input|answer|ok|okay|approval|choice|go-ahead|entscheidung|antwort|freigabe|rückmeldung|wahl)\b/i,
    new RegExp(`\\b(?:needs?|needed|required?)\\s+(?:from\\s+${you}|your\\b|a decision|an answer)`, "i"),
    /\b(?:decisions?|answers?|approvals?|input|sign-off)\s+(?:needed|required|pending|wanted)\b/i,
    /^(?:open|remaining|outstanding)\s+(?:questions?|decisions?)\b/i,
    /\b(?:for you to decide|you (?:need to|have to|must|should) decide|please decide|up to you)\b/i,
    new RegExp(`\\b(?:waiting|blocked)\\s+(?:for|on)\\s+${you}\\b`, "i"),
    new RegExp(`\\b(?:entscheidung(?:en)?|fragen?|rückfragen?|freigaben?)\\b.{0,30}\\b(?:für|an|von)\\s+${you}\\b`, "i"),
    /^(?:offene|ausstehende)\s+(?:fragen?|entscheidung(?:en)?|rückfragen?)\b/i,
    /\b(?:brauche|benötige|brauchen|benötigen)\b.{0,30}\b(?:von dir|von ihnen|von euch|deine|ihre)\b/i,
    /\b(?:von dir|von ihnen|von euch)\b.{0,30}\b(?:brauche|benötige|brauchen|benötigen)\b/i,
    /\b(?:entscheidung|freigabe|rückmeldung|antwort)\s+(?:nötig|erforderlich|benötigt|gebraucht|offen|ausstehend)\b/i,
    /\b(?:bitte entscheiden?|du entscheidest|musst du entscheiden|sie entscheiden|zu entscheiden)\b/i,
    /\bwarte(?:t)?\s+auf\s+(?:dich|sie|deine|ihre)\b/i,
  ];
}

/** A closing question that waits for the human. */
const ASKS = [
  /\b(?:should|shall|may|can|could)\s+(?:i|we)\b/i,
  /\b(?:do|would|did|will|can|could)\s+you\b/i,
  /\bwant\s+me\s+to\b/i,
  /\b(?:are|were)\s+you\b/i,
  /\b(?:is|was)\s+(?:it|that|this)\s+(?:ok|okay|fine|alright|all right|what you)\b/i,
  /\b(?:ok|okay)\s+(?:to|if i|with you)\b/i,
  /\b(?:which|what|how|where|when|who)\b.{0,60}\b(?:you|i|we)\b/i,
  /\byour\s+(?:call|decision|preference|pick|choice)\b/i,
  /\b(?:go ahead|proceed)\b/i,
  /\b(?:soll|sollen|sollte|sollten|darf|dürfen|kann|können)\s+(?:ich|wir)\b/i,
  /\b(?:möchtest|willst|kannst|könntest|würdest|bist|hast|magst)\s+du\b/i,
  /\b(?:möchten|wollen|können|könnten|würden|sind|haben)\s+sie\b/i,
  /\b(?:welche[rsnm]?|was|wie|wo|wann|wer)\b.{0,60}\b(?:du|dir|dich|sie|ich|wir)\b/i,
  /\b(?:passt|ist)\s+(?:das|dir|es)\b/i,
  /\beinverstanden\b/i,
];

/** A closing sentence that waits for the human without a question mark. */
const WAITS = [
  /\bplease\s+(?:confirm|decide|choose|approve|pick)\b/i,
  /\bonce\s+you(?:'ve|\s+have)?\s+(?:confirm|approve|decide|choose|chose|pick|repl|answer|give)/i,
  /\b(?:waiting|wait)\s+for\s+your\s+(?:ok|okay|answer|decision|reply|confirmation|approval|go|go-ahead|input)\b/i,
  /\bi\s+need\s+your\s+(?:ok|okay|answer|decision|confirmation|approval|input|go-ahead)\b/i,
  /\bneeds?\s+you\s+to\s+(?:decide|confirm|approve|choose|pick)\b/i,
  /\b(?:let me know|tell me)\s+which\b/i,
  /\bbitte\s+(?:bestätige|bestätigen|entscheide|entscheiden|wähle|wählen)\b/i,
  /\bsobald\s+du\s+(?:bestätigst|entscheidest|freigibst|antwortest|dich entschieden)/i,
  /\bich\s+warte\s+auf\s+dein/i,
  /\bich\s+brauche\s+dein(?:e|en)?\s+(?:ok|okay|entscheidung|freigabe|antwort|bestätigung|rückmeldung)\b/i,
  /\bsag\s+mir,?\s+(?:welche|was|wie|ob)\b/i,
];

/** Extra work on offer, or a polite closing line: nothing waits for it. */
const NOT_A_DECISION = [
  /\b(?:also|as well|anything else|something else|any (?:other )?questions?|make sense|does (?:that|this) help|need anything|further help|more details?)\b/i,
  /\b(?:noch|auch|außerdem|zusätzlich|sonst|hilft (?:das|dir)|weitere fragen|noch fragen|alles klar)\b/i,
];

/** The section says there is nothing to decide. */
const NOTHING =
  /^(?:[-–—]+|(?:none|nothing|n\/a|nope|not (?:right )?now|no (?:open |pending )?(?:decisions?|questions?|action|input)|keine?[rs]?|nichts|aktuell (?:keine|nichts)|derzeit (?:keine|nichts))\b[^\n?]{0,40})$/i;

interface Heading {
  line: number;
  /** 1–6: a Markdown heading; 7: a bold label; 8: a plain line that ends with a colon. */
  level: number;
  label: string;
  /** Text after the label on the same line ("**Decision for you:** Should I …?"). */
  rest: string;
}

function headingOf(raw: string, line: number): Heading | null {
  const md = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw);
  if (md) return { line, level: md[1]!.length, label: plain(md[2]!), rest: "" };
  const bold = /^\s*(?:[-*•]\s+|\d+[.)]\s+)?(?:\*\*|__)(.{2,80}?)(?:\*\*|__)\s*[:：]?\s*(.*)$/.exec(raw);
  if (bold) return { line, level: 7, label: plain(bold[1]!), rest: bold[2]!.trim() };
  const label = /^\s*([^.!?:\n]{3,80})[:：]\s*$/.exec(raw);
  if (label) return { line, level: 8, label: plain(label[1]!), rest: "" };
  return null;
}

/** Without Markdown marks, list bullets and emoji. */
function plain(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(?:>+\s*)?(?:[-*+•]\s+|\d+[.)]\s+)?/, "")
    .replace(/\*|__|~~|`/g, "")
    .replace(/[\p{Extended_Pictographic}️]/gu, "")
    .replace(/\s+/g, " ")
    .replace(/[:：]\s*$/, "")
    .trim();
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map(plain)
    .filter(Boolean);
}

function shorten(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

const isQuestion = (s: string) => /\?["'”’)\]]*$/.test(s);

/** The section's question: its first sentence that asks, else its first sentence. */
function titleOf(section: string): string {
  const all = sentences(section);
  return shorten(all.find(isQuestion) ?? all[0] ?? "", TITLE_MAX);
}

/** What stands around the question; the question itself is the title, so it doesn't open the body a second time. */
function bodyOf(section: string, title: string): string {
  const text = section.trim();
  if (plain(text) === title) return "";
  const rest = text.startsWith(title) ? text.slice(title.length).trim() : text;
  return rest.length > BODY_MAX ? `${rest.slice(0, BODY_MAX - 1)}…` : rest;
}

/**
 * What the answer leaves for the human to decide, or null. `human`: their name, as the agent may address them
 * ("Questions for Dana").
 */
export function detectOpenDecision(text: string, human = ""): OpenDecision | null {
  if (!text?.trim()) return null;
  const lines = text
    .replace(/```[\s\S]*?(?:```|$)/g, "")
    .split("\n")
    .filter((l) => !/^\s*>/.test(l));
  const headings = lines.flatMap((l, i) => headingOf(l, i) ?? []);
  const patterns = headingPatterns(human);
  let saidNothing = false;
  for (const h of headings) {
    if (!h.label || !patterns.some((re) => re.test(h.label))) continue;
    const next = headings.find((o) => o.line > h.line && o.level <= h.level);
    const section = [h.rest, ...lines.slice(h.line + 1, next?.line ?? lines.length)].join("\n").trim();
    const said = plain(section.split("\n").find((l) => l.trim()) ?? "");
    if (!section || NOTHING.test(said)) {
      saidNothing = true;
      continue;
    }
    const title = titleOf(section);
    if (title) return { title, body: bodyOf(section, title) };
  }
  // "Decision for you: none" settles it: a closing line after that is not one either.
  if (saidNothing) return null;

  const paragraphs = lines
    .join("\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => /\p{L}/u.test(p));
  const last = paragraphs.at(-1);
  if (!last) return null;
  const closing = sentences(last);
  const asked = closing.findLast((s) => (isQuestion(s) ? ASKS.some((re) => re.test(s)) : WAITS.some((re) => re.test(s))) && !NOT_A_DECISION.some((re) => re.test(s)));
  if (!asked) return null;
  const title = shorten(asked, TITLE_MAX);
  return { title, body: bodyOf(last, title) };
}
