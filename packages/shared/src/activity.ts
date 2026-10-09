/**
 * What a running tool call is doing, the way a person says it: "Opening github.com…", "Filling in the password…",
 * "Handing this to Mia…". The core sends these as the run's live activity (after masking saved secrets), so the live
 * pill, Home, the side panels, voice mode and the phone all read the same plain words.
 */

/** Resolves ids in tool input to names a person knows. Must never return a secret. */
export interface ActivityNames {
  agent?: (id: string) => string | undefined;
  login?: (id: string) => string | undefined;
  /** Masks saved secrets. Applied to every value before it is shortened, so no part of a secret is ever shown. */
  redact?: (text: string) => string;
}

type Input = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
/** One line, at most 48 characters. */
const short = (v: unknown, max = 48): string => {
  const s = str(v).replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const hostOf = (v: unknown): string => {
  const s = str(v).trim();
  if (!s) return "";
  // The host part of a URL or a bare domain, without "www." (no URL parser here: this runs on the phone too).
  const host = /^(?:[a-z][\w+.-]*:\/\/)?(?:[^@/?#]*@)?([^/?#:\s]+)/i.exec(s)?.[1] ?? "";
  return short(host.toLowerCase().replace(/^www\./, ""), 40);
};
const fileOf = (v: unknown): string => short(str(v).split(/[\\/]/).filter(Boolean).pop() ?? "", 40);
const taskNo = (v: unknown): string => /^#?(\d+)$/.exec(str(v).trim())?.[1] ?? "";
const humanize = (name: string): string => {
  const s = name.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Working";
};

const agentName = (input: Input, names: ActivityNames): string => {
  const id = str(input.agentId) || str(input.id);
  return (id && names.agent?.(id)) || "a teammate";
};
const loginFor = (input: Input, names: ActivityNames): string => {
  const id = str(input.credentialId);
  const name = id ? names.login?.(id) : undefined;
  return name ? ` for ${short(name, 40)}` : "";
};

/** Present-tense phrases of Godmode's own tools, keyed by tool name (without "…"). */
export const GATEWAY_ACTIVITY: Record<string, (input: Input, names: ActivityNames) => string> = {
  vault_list_logins: (i) => (hostOf(i.domain) ? `Looking up logins for ${hostOf(i.domain)}` : "Looking up saved logins"),
  vault_fill_login: (i, n) => `Filling in the ${str(i.field) === "username" ? "username" : "password"}${loginFor(i, n)}`,
  vault_fill_totp: (i, n) => `Entering the 2FA code${loginFor(i, n)}`,
  vault_save_login: (i) => `Saving the login${hostOf(i.url) ? ` for ${hostOf(i.url)}` : ""} to the vault`,
  vault_get_login: () => "Opening a saved login",
  vault_get_totp: () => "Reading a 2FA code",
  vault_list_cards: () => "Looking up saved cards",
  vault_card_purchase: (i) => `Asking to pay${short(i.merchant) ? ` ${short(i.merchant, 40)}` : ""} with a saved card`,
  vault_fill_card: () => "Entering card details",
  vault_card_purchase_result: (i) => (str(i.outcome) === "failed" ? "Noting that the payment failed" : "Recording the payment"),
  report_missing_login: (i) => `Noting that it needs a login for ${short(i.service) || hostOf(i.url) || "a site"}`,
  notify_user: () => "Sending you a notification",
  ask_human: () => "Asking you",
  request_approval: () => "Asking for your OK",
  human_task_create: () => "Giving you a task",
  human_task_cancel: () => "Taking back a task it gave you",
  human_tasks_list: () => "Looking at your tasks",
  followup_schedule: () => "Planning when to continue",
  followup_cancel: () => "Cancelling its follow-up",
  api_tools_list: () => "Checking its API tools",
  api_tool_docs: (i) => `Reading how ${short(i.toolId ?? i.tool) || "an API"} works`,
  api_tool_request: (i) => `Calling ${short(i.toolId ?? i.tool) || "an API"}`,
  agents_list: () => "Looking at the team",
  agent_get: (i, n) => `Looking at ${agentName(i, n)}`,
  agent_delegate: (i, n) => {
    const who = agentName(i, n);
    if (i.wait === false) return `Handing this to ${who}`;
    return who === "a teammate" ? "A teammate is working on it" : `${who} is working on it`;
  },
  delegation_status: () => "Checking on handed-over work",
  agent_create: (i) => `Setting up ${short(i.name) || "a new agent"}`,
  agent_update: (i, n) => `Updating ${agentName(i, n)}`,
  agent_delete: (i, n) => `Removing ${agentName(i, n)}`,
  routine_list: () => "Looking at automations",
  routine_create: (i) => (short(i.name) ? `Setting up the automation ${short(i.name)}` : "Setting up an automation"),
  routine_update: () => "Changing an automation",
  routine_run: () => "Starting an automation",
  routine_delete: () => "Deleting an automation",
  automation_triggers_list: () => "Looking up app events",
  automation_events_list: () => "Checking automation events",
  automation_check_result: () => "Reporting what it found",
  task_report_blocked: () => "Reporting what it needs",
  tasks_list: () => "Looking at the board",
  task_get: (i) => (taskNo(i.taskId) ? `Reading task #${taskNo(i.taskId)}` : "Reading a task"),
  task_create: () => "Filing a task",
  task_split: () => "Splitting the ticket into parts",
  goals_list: () => "Looking at the goals",
  task_update: (i) => (taskNo(i.taskId) ? `Updating task #${taskNo(i.taskId)}` : "Updating a task"),
  task_message: (i) => (taskNo(i.taskId) ? `Writing into task #${taskNo(i.taskId)}` : "Writing into a task"),
  task_note: () => "Leaving a note on the task",
  memory_dream_report: () => "Writing down what it consolidated",
  runs_list: () => "Checking recent runs",
  run_continue: () => "Continuing work a restart cut off",
  workspaces_list: () => "Looking at workspaces",
  workspace_create: (i) => (short(i.name) ? `Creating the workspace ${short(i.name)}` : "Creating a workspace"),
  workspace_update: () => "Updating a workspace",
  project_create: (i) => (short(i.name) ? `Creating the project ${short(i.name)}` : "Creating a project"),
  project_update: () => "Updating a project",
  mods_list: () => "Looking at the mods",
  mod_save: (i) => (short(i.title) ? `Saving the mod ${short(i.title, 40)} as a draft` : "Saving a mod as a draft"),
  logins_overview: () => "Checking which logins are saved",
  missing_logins_list: () => "Checking missing logins",
  vms_list: () => "Looking at the virtual machines",
  vm_create: (i) => (short(i.name) ? `Creating the VM ${short(i.name)}` : "Creating a VM"),
  vm_assign: () => "Assigning a VM",
  vm_power: (i) => (str(i.action) === "stop" ? "Stopping a VM" : str(i.action) === "suspend" ? "Suspending a VM" : "Starting a VM"),
  spend_overview: () => "Checking what the team costs",
};

function browserActivity(tool: string, input: Input): string {
  const t = tool.replace(/^browser_/, "");
  if (t === "navigate" || t === "open" || t === "goto") return hostOf(input.url) ? `Opening ${hostOf(input.url)}` : "Opening a page";
  if (/click/.test(t)) return "Clicking on the page";
  if (/type|input_text|fill/.test(t)) return "Typing on the page";
  if (/state|extract|html|content|snapshot|read/.test(t)) return "Reading the page";
  if (/scroll/.test(t)) return "Scrolling";
  if (/back/.test(t)) return "Going back";
  if (/screenshot/.test(t)) return "Looking at the page";
  if (/tab/.test(t)) return "Switching tabs";
  if (/key/.test(t)) return "Pressing keys";
  if (/agent/.test(t)) return "Letting the browser agent try";
  return "Using the browser";
}

function computerActivity(tool: string, input: Input): string {
  const action = str(input.action) || tool;
  if (tool === "computer_ui") return "Reading the window";
  if (tool === "computer_info") return "Checking the shared screen";
  if (tool === "computer_windows") return "Switching windows";
  if (/launch|open_app/.test(tool)) return short(input.name ?? input.app) ? `Opening ${short(input.name ?? input.app)}` : "Opening an app";
  if (/screenshot/.test(action)) return "Looking at the screen";
  if (/click/.test(action)) return "Clicking";
  if (/type|set_value/.test(action)) return "Typing";
  if (/key/.test(action)) return "Pressing keys";
  if (/scroll/.test(action)) return "Scrolling";
  if (/move|drag/.test(action)) return "Moving the pointer";
  if (/wait/.test(action)) return "Waiting a moment";
  if (/zoom/.test(action)) return "Zooming in";
  return "Using the computer";
}

function remoteActivity(tool: string, input: Input, where: string): string | null {
  if (/shell|exec|run/.test(tool)) return `Running a command ${where}`;
  if (/read/.test(tool)) return fileOf(input.path) ? `Reading ${fileOf(input.path)} ${where}` : `Reading a file ${where}`;
  if (/write|edit/.test(tool)) return fileOf(input.path) ? `Editing ${fileOf(input.path)} ${where}` : `Editing a file ${where}`;
  if (/upload/.test(tool)) return `Uploading ${where.replace(/^(in|on) /, "to ")}`;
  if (/download/.test(tool)) return `Downloading ${where.replace(/^(in|on) /, "from ")}`;
  return null;
}

function builtinActivity(name: string, input: Input): string {
  switch (name) {
    case "Bash":
      return short(input.description, 60) || "Running a command";
    case "BashOutput":
    case "Monitor":
      return "Checking a command's output";
    case "Read":
      return fileOf(input.file_path) ? `Reading ${fileOf(input.file_path)}` : "Reading a file";
    case "Write":
      return fileOf(input.file_path) ? `Writing ${fileOf(input.file_path)}` : "Writing a file";
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return fileOf(input.file_path ?? input.notebook_path) ? `Editing ${fileOf(input.file_path ?? input.notebook_path)}` : "Editing a file";
    case "Glob":
      return "Looking for files";
    case "Grep":
      return short(input.pattern, 32) ? `Searching for “${short(input.pattern, 32)}”` : "Searching the files";
    case "LS":
      return fileOf(input.path) ? `Looking through ${fileOf(input.path)}` : "Looking through a folder";
    case "WebFetch":
      return hostOf(input.url) ? `Reading ${hostOf(input.url)}` : "Reading a web page";
    case "WebSearch":
      return short(input.query, 40) ? `Searching the web for “${short(input.query, 40)}”` : "Searching the web";
    case "Task":
    case "Agent":
      return short(input.description, 60) || "Working with a helper";
    case "Workflow":
      return "Starting a workflow";
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
      return "Updating the plan";
    case "TaskList":
    case "TaskGet":
      return "Checking the plan";
    default:
      return humanize(name);
  }
}

/** What a running tool call is doing, the way a person says it ("Opening github.com…"). Always ends with "…". */
export function toolActivity(name: string, input: unknown, names: ActivityNames = {}): string {
  const raw: Input = input && typeof input === "object" && !Array.isArray(input) ? (input as Input) : {};
  const i: Input = names.redact ? Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, typeof v === "string" ? names.redact!(v) : v])) : raw;
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  const server = m?.[1] ?? "";
  const tool = m?.[2] ?? name;
  let phrase: string;
  if (server === "browser" || (!server && tool.startsWith("browser_"))) phrase = browserActivity(tool, i);
  else if (server === "computer" || server === "cua") phrase = computerActivity(tool, i);
  else if (server === "vm") phrase = remoteActivity(tool, i, "in the VM") ?? (tool === "info" ? "Checking the VM" : computerActivity(tool, i));
  else if (server === "ssh") {
    const named = str(i.server);
    const where = `on ${named && !/^ssh_/.test(named) ? short(named, 32) : "the server"}`;
    phrase = tool === "list_servers" ? "Checking SSH servers" : (remoteActivity(tool, i, where) ?? `Working ${where}`);
  } else if (server === "godmode" || (!server && GATEWAY_ACTIVITY[tool])) phrase = GATEWAY_ACTIVITY[tool]?.(i, names) ?? humanize(tool);
  else if (server) phrase = `Using ${humanize(server)}`;
  else phrase = builtinActivity(name, i);
  const label = phrase.length > 79 ? `${phrase.slice(0, 78)}…` : phrase;
  return label.endsWith("…") ? label : `${label}…`;
}

/** Past tense of Godmode's own tools, for a finished step ("Checked what the team costs"). Same words on every client. */
export const GATEWAY_DONE: Record<string, string> = {
  vault_list_logins: "Looked up saved logins",
  vault_fill_login: "Filled in a login from the vault",
  vault_fill_totp: "Entered a 2FA code",
  vault_save_login: "Saved a login to the vault",
  vault_get_login: "Opened a saved login",
  vault_get_totp: "Read a 2FA code",
  vault_list_cards: "Looked up saved cards",
  vault_card_purchase: "Asked to pay with a saved card",
  vault_fill_card: "Entered card details",
  vault_card_purchase_result: "Recorded the payment",
  report_missing_login: "Noted a missing login",
  notify_user: "Sent you a notification",
  ask_human: "Asked you",
  request_approval: "Asked for your OK",
  human_task_create: "Gave you a task",
  human_task_cancel: "Took back a task it gave you",
  human_tasks_list: "Looked at your tasks",
  followup_schedule: "Planned when to continue",
  followup_cancel: "Cancelled its follow-up",
  api_tools_list: "Checked its API tools",
  api_tool_docs: "Read how an API works",
  api_tool_request: "Called an API",
  agents_list: "Looked at the team",
  agent_get: "Looked at a teammate",
  agent_delegate: "Handed a task to a teammate",
  delegation_status: "Checked on handed-over work",
  agent_create: "Set up a new agent",
  agent_update: "Updated an agent",
  agent_delete: "Removed an agent",
  routine_list: "Looked at automations",
  routine_create: "Set up an automation",
  routine_update: "Changed an automation",
  routine_run: "Started an automation",
  routine_delete: "Deleted an automation",
  automation_triggers_list: "Looked up app events",
  automation_events_list: "Checked automation events",
  automation_check_result: "Reported what it found",
  task_report_blocked: "Reported what it needs",
  tasks_list: "Looked at the board",
  task_get: "Read a task",
  task_create: "Filed a task",
  task_split: "Split the ticket into parts",
  goals_list: "Looked at the goals",
  task_update: "Updated a task",
  task_message: "Wrote into a task",
  task_note: "Left a note on the task",
  memory_dream_report: "Wrote down what it consolidated",
  runs_list: "Checked recent runs",
  run_continue: "Continued work a restart cut off",
  workspaces_list: "Looked at workspaces",
  workspace_create: "Created a workspace",
  workspace_update: "Updated a workspace",
  project_create: "Created a project",
  project_update: "Updated a project",
  mods_list: "Looked at the mods",
  mod_save: "Saved a mod as a draft",
  logins_overview: "Checked which logins are saved",
  missing_logins_list: "Checked missing logins",
  vms_list: "Looked at the virtual machines",
  vm_create: "Created a VM",
  vm_assign: "Assigned a VM",
  vm_power: "Switched a VM on or off",
  spend_overview: "Checked what the team costs",
  runner_health: "Checked a runner",
  runner_exec: "Ran a command on a runner",
  runner_fix: "Fixed a runner",
};

/** A finished gateway step's title; a plain humanized name for a tool newer than this table (never "godmode"). */
export function gatewayDone(tool: string): string {
  return GATEWAY_DONE[tool] ?? humanize(tool);
}
