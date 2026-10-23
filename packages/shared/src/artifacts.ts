/**
 * Artifacts: small web apps an agent builds in a chat (a sales dashboard, a KPI tracker, a calculator) and the human
 * changes by chatting. One HTML document runs in a sandboxed frame; its data lives next to it as JSON, so a refresh
 * rewrites the numbers without touching the code. Every change to the code is a new version the human can go back to.
 *
 * The frame reaches Godmode only through `window.godmode` (ARTIFACT_BRIDGE_DOC): read the data, save what the app
 * changed, ask the agent for something, follow the theme.
 */
import type { ID, ISODate } from "./models";

/** Largest document an agent may save (characters). */
export const MAX_ARTIFACT_HTML = 400_000;
/** Largest data the app or the agent may save (characters of JSON). */
export const MAX_ARTIFACT_DATA = 1_000_000;
/** Versions kept per artifact (older ones are dropped). */
export const MAX_ARTIFACT_VERSIONS = 50;

export interface ArtifactSummary {
  id: ID;
  title: string;
  description: string;
  /** The code's version: 1 for the first, +1 for every change to the HTML. */
  version: number;
  /** What the agent does when the human presses Refresh ("" = no refresh). */
  refreshPrompt: string;
  pinned: boolean;
  agentId: ID | null;
  agentName: string | null;
  /** The chat it was made in; changes asked for in the artifact go there. */
  conversationId: ID | null;
  conversationTitle: string | null;
  workspaceId: ID | null;
  /** When the data last changed (by the agent or the app). */
  dataUpdatedAt: ISODate | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface Artifact extends ArtifactSummary {
  html: string;
  data: unknown;
}

export interface ArtifactVersion {
  version: number;
  /** What changed, in the agent's words. */
  note: string;
  createdAt: ISODate;
}

export interface ArtifactVersionDetail extends ArtifactVersion {
  html: string;
}

export interface ArtifactPatch {
  title?: string;
  description?: string;
  pinned?: boolean;
  refreshPrompt?: string;
}

export interface ArtifactDataInput {
  data: unknown;
  /** The version the app was showing: a save from an older one still goes through, it never touches the code. */
  version?: number;
}

/** A message for the artifact's agent: it goes to the artifact's chat (a new one when that chat is gone). */
export interface ArtifactMessageInput {
  content: string;
  /** `app`: the artifact's own code suggested it and the human confirmed (the agent is told). */
  source?: "human" | "app";
}

export interface ArtifactMessageResult {
  conversationId: ID;
  /** The agent was busy there: the message waits in the chat's queue. */
  queued: boolean;
}

/** Start a new artifact from a description: a new chat with the agent that builds it. */
export interface ArtifactStartInput {
  prompt: string;
  agentId?: ID;
  workspaceId?: ID | null;
}

export interface ArtifactStartResult {
  conversationId: ID;
}

/** Ready-made starting points shown on the Artifacts page. */
export interface ArtifactStarter {
  id: string;
  title: string;
  blurb: string;
  prompt: string;
}

export const ARTIFACT_STARTERS: readonly ArtifactStarter[] = [
  {
    id: "sales",
    title: "Sales dashboard",
    blurb: "Revenue, orders and top products at a glance",
    prompt:
      "Build me a sales dashboard: revenue, orders and average order value for the last 30 days with the change to the 30 days before, a daily revenue chart and the top products. Use my real numbers if you can reach them (shop, Stripe, invoices); otherwise start with clearly marked sample data and tell me where to connect it. Add a refresh that pulls the latest numbers.",
  },
  {
    id: "kpi",
    title: "KPI tracker",
    blurb: "A handful of numbers you check every morning",
    prompt:
      "Build a KPI tracker with 4–6 key numbers I care about, each with a target, the trend of the last weeks and a status color. Ask me which numbers matter if you don't know, and make it easy to add or edit a KPI right in the app.",
  },
  {
    id: "pipeline",
    title: "Deal pipeline",
    blurb: "Drag deals through your sales stages",
    prompt:
      "Build a small deal pipeline board: stages (Lead, Contacted, Offer, Won, Lost), cards with company, value and next step, drag and drop between stages, totals per stage, and a form to add a deal. Save every change so it is still there next time.",
  },
  {
    id: "budget",
    title: "Budget planner",
    blurb: "Income, costs and what's left each month",
    prompt:
      "Build a monthly budget planner: income and expense categories I can edit, a chart of where the money goes, what's left at the end of the month, and a comparison with last month. Save my entries.",
  },
  {
    id: "content",
    title: "Content calendar",
    blurb: "Plan posts across your channels",
    prompt:
      "Build a content calendar: a month view with posts per channel (LinkedIn, Instagram, X, newsletter), status (idea, draft, scheduled, posted), quick add and filters. Save my changes.",
  },
  {
    id: "calculator",
    title: "Price calculator",
    blurb: "A quote or margin calculator for your offers",
    prompt:
      "Build a price and margin calculator for my offers: inputs for cost, hours, hourly rate, discount and VAT, with the net and gross price, margin and a short summary I can copy into an email.",
  },
];

/**
 * What an artifact's code can use. The same text goes into the tool descriptions, so agents and the frame agree.
 * The frame has no network access to Godmode and no cookies of the app.
 */
export const ARTIFACT_BRIDGE_DOC = `Inside the artifact, \`window.godmode\` is ready before your scripts run:
- \`godmode.data\` — the artifact's data (the JSON you saved with it, or what the app saved). Read it on load.
- \`godmode.onData(fn)\` — fn(data) now and whenever the data changes (a refresh, another window). Render from here.
- \`await godmode.setData(next)\` — save data the human entered (a new deal, a ticked box); it stays and you can read it later with artifact_get. Pass the whole object.
- \`godmode.ask(text)\` — offer to send text to you in the chat (the human confirms), e.g. a "Ask for a chart" button.
- \`godmode.refresh()\` — ask you to refresh the data (the human's Refresh button does the same).
- \`godmode.theme\` ("light" | "dark") and \`godmode.onTheme(fn)\`; the CSS variables --gm-bg, --gm-card, --gm-fg, --gm-muted, --gm-border, --gm-accent, --gm-accent-fg, --gm-positive, --gm-negative and --gm-font follow the app's theme, and \`<html>\` gets class "dark" in dark mode.
Scripts and styles may load from https CDNs (e.g. https://cdn.tailwindcss.com, https://cdn.jsdelivr.net/npm/chart.js); \`fetch\` may reach public https APIs only. Links open in the human's browser. No localStorage, cookies, alert, confirm or prompt: keep state in godmode.setData and build dialogs in the page.`;
