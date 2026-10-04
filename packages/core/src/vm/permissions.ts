/**
 * macOS privacy permissions (TCC) inside a VM, set without anyone answering a dialog.
 *
 * macOS keeps "may this program do X" in two SQLite databases: the system one (Accessibility, Screen Recording, Input
 * Monitoring, Full Disk Access, Developer Tools) and the guest user's (everything else — Automation, Camera,
 * Microphone, Contacts, folders, …). A program without an entry gets a dialog, or just fails. The Cirrus Labs images
 * run with System Integrity Protection off and authorize the Tart guest agent by writing such entries; Godmode writes
 * them the same way, so an agent gives the software it installs what it needs itself (the `permissions` tool, see
 * tools.ts) and Godmode keeps its own way into the guest working (`ensureAgentAccess`).
 *
 * - An entry names a client: an app's bundle id, or the path of a bare program. macOS reads the databases on every
 *   request, so a change applies at once (an app that already runs may only look again after a restart).
 * - Whatever starts through `tart exec` — the `shell` tool, the in-guest browser and Cua Driver servers — counts as
 *   the guest agent, by the real path of its binary (a Homebrew Cellar path that changes with every upgrade of it).
 *   The spec `"shell"` stands for that client.
 * - Automation is granted per controlled app (`target`). Accessibility also covers sending input events: macOS turns a
 *   leftover PostEvent entry back into Accessibility, so revoking removes both.
 * - A dialog that is closed without "Allow" makes macOS store a refusal over the entry (so nothing here dismisses
 *   dialogs); granting again fixes it.
 *
 * The guest scripts are POSIX sh: the guest runs them in zsh, the tests' stand-in guest in sh.
 */
import type { VmExecResult } from "@godmode/shared";
import { logger } from "../log";
import { shq } from "./service";

const log = logger("vm");

/** Runs a script in the guest (see `execInVm`). */
export type GuestExec = (script: string, opts?: { timeoutMs?: number }) => Promise<VmExecResult>;

/** Something the caller got wrong or macOS refused: the message is for the agent. */
export class PermissionError extends Error {}

interface PermissionDef {
  service: string;
  /** Which database macOS reads it from. */
  db: "system" | "user";
  label: string;
}

/** Which tccd answers for a service was checked on macOS 26 (TCCAccessPreflight per service, then tccd's log). */
export const PERMISSIONS = {
  accessibility: { service: "kTCCServiceAccessibility", db: "system", label: "Accessibility" },
  screen_recording: { service: "kTCCServiceScreenCapture", db: "system", label: "Screen Recording" },
  input_monitoring: { service: "kTCCServiceListenEvent", db: "system", label: "Input Monitoring" },
  full_disk_access: { service: "kTCCServiceSystemPolicyAllFiles", db: "system", label: "Full Disk Access" },
  developer_tools: { service: "kTCCServiceDeveloperTool", db: "system", label: "Developer Tools" },
  automation: { service: "kTCCServiceAppleEvents", db: "user", label: "Automation" },
  microphone: { service: "kTCCServiceMicrophone", db: "user", label: "Microphone" },
  camera: { service: "kTCCServiceCamera", db: "user", label: "Camera" },
  system_audio: { service: "kTCCServiceAudioCapture", db: "user", label: "System Audio Recording" },
  contacts: { service: "kTCCServiceAddressBook", db: "user", label: "Contacts" },
  calendar: { service: "kTCCServiceCalendar", db: "user", label: "Calendars" },
  reminders: { service: "kTCCServiceReminders", db: "user", label: "Reminders" },
  photos: { service: "kTCCServicePhotos", db: "user", label: "Photos" },
  desktop_folder: { service: "kTCCServiceSystemPolicyDesktopFolder", db: "user", label: "Desktop folder" },
  documents_folder: { service: "kTCCServiceSystemPolicyDocumentsFolder", db: "user", label: "Documents folder" },
  downloads_folder: { service: "kTCCServiceSystemPolicyDownloadsFolder", db: "user", label: "Downloads folder" },
  removable_volumes: { service: "kTCCServiceSystemPolicyRemovableVolumes", db: "user", label: "Removable volumes" },
  network_volumes: { service: "kTCCServiceSystemPolicyNetworkVolumes", db: "user", label: "Network volumes" },
  app_management: { service: "kTCCServiceSystemPolicyAppBundles", db: "user", label: "App Management" },
  speech_recognition: { service: "kTCCServiceSpeechRecognition", db: "user", label: "Speech Recognition" },
  bluetooth: { service: "kTCCServiceBluetoothAlways", db: "user", label: "Bluetooth" },
} as const satisfies Record<string, PermissionDef>;

export type PermissionName = keyof typeof PERMISSIONS;
export const PERMISSION_NAMES = Object.keys(PERMISSIONS) as [PermissionName, ...PermissionName[]];

/** The spec for whatever runs through `tart exec` (the Tart guest agent). */
export const SHELL_CLIENT = "shell";
/** Sending input events: part of Accessibility (see the header). */
const POST_EVENT = "kTCCServicePostEvent";
const NO_TARGET = "UNUSED";
const ALLOWED = 2;

/** What Godmode's own way into the guest needs: Cua Driver, and osascript's two usual targets. */
const AGENT_ACCESS: { permission: PermissionName; target?: string }[] = [
  { permission: "accessibility" },
  { permission: "screen_recording" },
  { permission: "automation", target: "com.apple.systemevents" },
  { permission: "automation", target: "com.apple.finder" },
];

const BY_SERVICE = new Map<string, PermissionName>(PERMISSION_NAMES.map((n) => [PERMISSIONS[n].service, n]));

/** The database macOS reads a service from — null for one this module doesn't know. */
function homeOf(service: string): "system" | "user" | null {
  const name = BY_SERVICE.get(service);
  return name ? PERMISSIONS[name].db : service === POST_EVENT ? "system" : null;
}

/** Who a permission belongs to: an app (bundle id) or a bare program (path). */
export interface TccClient {
  client: string;
  /** 0 = bundle id, 1 = absolute path. */
  type: 0 | 1;
  /** App or program name; the client itself for a bundle id that was taken as given. */
  label: string;
  /** Asked for as "shell": the Tart guest agent. */
  shell: boolean;
}

interface TccRow {
  db: "system" | "user";
  service: string;
  client: string;
  type: number;
  value: number;
  target: string;
}

/* ------------------------------------------------------------------ */
/* Guest scripts                                                        */
/* ------------------------------------------------------------------ */

const USER_DB = 'U="$HOME/Library/Application Support/com.apple.TCC/TCC.db"';
const SYSTEM_DB = 'S="/Library/Application Support/com.apple.TCC/TCC.db"';
const NO_TCC = "notcc";

/**
 * `resolve <spec>` prints "ok<TAB>type<TAB>client<TAB>label" or "err<TAB>message": "shell", a path (an app bundle, a
 * program in one, or a bare program — symlinks resolved, like macOS does), an app's name, or a bundle id.
 */
const RESOLVE = [
  USER_DB,
  `if [ ! -f "$U" ]; then echo ${NO_TCC}; exit 0; fi`,
  "real() {",
  "  rf=$1; rn=0",
  '  while [ -L "$rf" ] && [ "$rn" -lt 40 ]; do',
  '    rl=$(readlink "$rf") || break',
  '    case "$rl" in /*) rf=$rl ;; *) rf=$(dirname "$rf")/$rl ;; esac',
  "    rn=$((rn + 1))",
  "  done",
  '  if rd=$(cd -P "$(dirname "$rf")" >/dev/null 2>&1 && pwd -P); then printf \'%s/%s\\n\' "${rd%/}" "$(basename "$rf")"; else printf \'%s\\n\' "$rf"; fi',
  "}",
  "from_path() {",
  '  p=$(real "$1")',
  '  if [ ! -e "$p" ]; then printf \'err\\tThere is nothing at %s in the VM.\\n\' "$1"; return; fi',
  '  case "$p" in',
  "    *.app) b=$p ;;",
  "    *.app/*) b=${p%.app/*}.app ;;",
  "    *) b= ;;",
  "  esac",
  '  if [ -n "$b" ]; then',
  "    id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' \"$b/Contents/Info.plist\" 2>/dev/null)",
  '    if [ -n "$id" ]; then printf \'ok\\t0\\t%s\\t%s\\n\' "$id" "$(basename "$b" .app)"; return; fi',
  "  fi",
  '  if [ -d "$p" ]; then printf \'err\\t%s is a folder, not an app or a program.\\n\' "$1"; return; fi',
  '  printf \'ok\\t1\\t%s\\t%s\\n\' "$p" "$(basename "$p")"',
  "}",
  "resolve() {",
  "  a=$1",
  '  case "$a" in',
  `    ${SHELL_CLIENT})`,
  "      g=$(/bin/ps -axo comm= 2>/dev/null | /usr/bin/grep -m 1 -E '^/.*/tart-guest-agent$')",
  '      if [ -z "$g" ]; then for c in /opt/homebrew/bin/tart-guest-agent /usr/local/bin/tart-guest-agent; do if [ -x "$c" ]; then g=$c; break; fi; done; fi',
  "      if [ -z \"$g\" ]; then printf 'err\\tThe Tart guest agent, which runs your shell commands, was not found in the VM.\\n'; return; fi",
  `      printf 'ok\\t1\\t%s\\t${SHELL_CLIENT}\\n' "$(real "$g")"; return ;;`,
  '    /*) from_path "$a"; return ;;',
  '    "~"/*) from_path "$HOME/${a#??}"; return ;;',
  "  esac",
  "  name=${a%.app}",
  '  for dir in /Applications "$HOME/Applications" /System/Applications /System/Applications/Utilities /Applications/Utilities /System/Library/CoreServices /System/Library/CoreServices/Applications; do',
  '    if [ -d "$dir/$name.app" ]; then from_path "$dir/$name.app"; return; fi',
  "  done",
  // Any capitalisation, one folder deeper too — the name taken literally, not as a pattern.
  "  pattern=$(printf '%s' \"$name\" | sed 's/[][*?\\]/\\\\&/g')",
  "  hit=$(find /Applications \"$HOME/Applications\" /System/Applications -maxdepth 2 -name '*.app' -prune -iname \"$pattern.app\" -print 2>/dev/null | head -n 1)",
  '  if [ -n "$hit" ]; then from_path "$hit"; return; fi',
  // A bundle id needs no installed app — but "Slack.app" that isn't there is a missing app, not an id.
  "  if [ \"$name\" = \"$a\" ] && printf '%s' \"$a\" | /usr/bin/grep -q -E '^[A-Za-z0-9_-]+([.][A-Za-z0-9_-]+)+$'; then printf 'ok\\t0\\t%s\\t%s\\n' \"$a\" \"$a\"; return; fi",
  "  printf 'err\\tNo app named \"%s\" was found in the VM. Pass its bundle id (like com.google.Chrome) or the full path of the app or program.\\n' \"$a\"",
  "}",
].join("\n");

const NOT_MACOS = "This VM has no macOS privacy settings (they exist in macOS guests, once the guest user has logged in).";

function failure(res: VmExecResult): string {
  if (res.timedOut) return "the VM took too long to answer";
  const last = (text: string) => text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("System Integrity Protection")).at(-1);
  // The reason is on stderr; stdout holds whatever rows were printed before it.
  return (last(res.stderr) ?? last(res.stdout))?.slice(0, 300) || `exit ${res.exitCode}`;
}

function checkSpec(spec: string, what: string): string {
  const s = spec.trim();
  if (!s) throw new PermissionError(`${what} is empty.`);
  // The scripts' answers are lines of tab-separated fields.
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new PermissionError(`${what} has characters that can't be part of an app's name or path.`);
  return s;
}

/** Who the specs mean in the guest, in order. */
export async function resolveClients(exec: GuestExec, specs: string[]): Promise<TccClient[]> {
  const res = await exec(`${RESOLVE}\n${specs.map((s) => `resolve ${shq(s)}`).join("\n")}`, { timeoutMs: 30_000 });
  // Only the script's own lines: the guest's login files (the agent's to edit) may print something first.
  const all = res.stdout.split("\n");
  if (all.includes(NO_TCC)) throw new PermissionError(NOT_MACOS);
  const lines = all.filter((l) => /^(ok|err)\t/.test(l));
  if (res.exitCode !== 0 || lines.length !== specs.length) throw new PermissionError(`Could not look up the app in the VM (${failure(res)}).`);
  return lines.map((line, i) => {
    const fields = line.split("\t");
    if (fields[0] !== "ok" || !fields[2]) throw new PermissionError(fields[1] || "Could not look up the app in the VM.");
    return { client: fields[2], type: fields[1] === "1" ? 1 : 0, label: fields[3] || fields[2], shell: specs[i] === SHELL_CLIENT };
  });
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

const rowsSql = (db: TccRow["db"], where: string) =>
  `SELECT json_object('db', '${db}', 'service', service, 'client', client, 'type', client_type, 'value', auth_value, 'target', indirect_object_identifier) FROM access WHERE ${where}`;

const sameEntry = (service: string, c: TccClient, target: string) =>
  `service = ${q(service)} AND client = ${q(c.client)} AND client_type = ${c.type} AND indirect_object_identifier = ${q(target)}`;

/**
 * Allow `service` for the client (reason 4 = set by the system, no code requirement — like the image's own entries, so
 * the entry also fits an app that is rebuilt or updated). `ifMissing` leaves an entry that already allows it alone.
 */
function allowSql(service: string, c: TccClient, target: string, ifMissing = false): string {
  const values = `${q(service)}, ${q(c.client)}, ${c.type}, ${ALLOWED}, 4, 1, 0, ${q(target)}, 0`;
  const columns = "service, client, client_type, auth_value, auth_reason, auth_version, indirect_object_identifier_type, indirect_object_identifier, flags";
  return `INSERT OR REPLACE INTO access (${columns}) SELECT ${values}${ifMissing ? ` WHERE NOT EXISTS (SELECT 1 FROM access WHERE ${sameEntry(service, c, target)} AND auth_value = ${ALLOWED})` : ""}`;
}

/** Run statements against the guest's two databases; every row a statement returns is one JSON object. */
async function runSql(exec: GuestExec, sql: { system?: string[]; user?: string[] }): Promise<Record<string, unknown>[]> {
  // One transaction per database: all of its changes or none. A batch that only reads takes no write lock.
  const batch = (statements: string[]) =>
    shq((statements.every((s) => s.startsWith("SELECT ")) ? statements : ["BEGIN IMMEDIATE", ...statements, "COMMIT"]).join(";\n") + ";\n");
  // No ~/.sqliterc (it could change how rows are printed); tccd uses the databases too, so wait for its writes
  // instead of failing on a lock.
  const sqlite = "/usr/bin/sqlite3 -init /dev/null -batch -cmd '.timeout 3000'";
  const script = [
    USER_DB,
    SYSTEM_DB,
    `if [ ! -f "$U" ]; then echo ${NO_TCC}; exit 0; fi`,
    "rc=0",
    // The system database first — the one that can be out of reach: then nothing was changed at all.
    ...(sql.system?.length ? [`sudo -n ${sqlite} "$S" ${batch(sql.system)} || rc=1`] : []),
    ...(sql.user?.length ? [`if [ "$rc" = 0 ]; then ${sqlite} "$U" ${batch(sql.user)} || rc=1; fi`] : []),
    'if [ "$rc" != 0 ]; then /usr/bin/csrutil status >&2 2>/dev/null; fi',
    'exit "$rc"',
  ].join("\n");
  const res = await exec(script, { timeoutMs: 30_000 });
  if (res.stdout.split("\n").includes(NO_TCC)) throw new PermissionError(NOT_MACOS);
  if (res.exitCode !== 0) {
    throw new PermissionError(
      /System Integrity Protection status: enabled/.test(res.stderr)
        ? "macOS refused: System Integrity Protection is on in this VM, so only System Settings can show or change privacy permissions there. Use System Settings → Privacy & Security on the VM's screen instead."
        : `macOS refused (${failure(res)}).`,
    );
  }
  const rows: Record<string, unknown>[] = [];
  for (const line of res.stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      rows.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* not a row */
    }
  }
  return rows;
}

const tccRows = (rows: Record<string, unknown>[]) => rows.filter((r) => typeof r.service === "string") as unknown as TccRow[];

/* ------------------------------------------------------------------ */
/* Wording                                                              */
/* ------------------------------------------------------------------ */

function who(c: TccClient): string {
  if (c.shell) return `your shell commands (the Tart guest agent, ${c.client})`;
  return c.label === c.client ? c.client : `${c.label} (${c.client})`;
}

function serviceLabel(service: string): string {
  const name = BY_SERVICE.get(service);
  if (name) return PERMISSIONS[name].label;
  return service === POST_EVENT ? "Accessibility (sending input)" : service.replace(/^kTCCService/, "");
}

function joinNames(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

const STATE: Record<number, string> = { 0: "refused", 1: "not decided", 2: "allowed", 3: "limited" };

/* ------------------------------------------------------------------ */
/* Grant, revoke, list                                                  */
/* ------------------------------------------------------------------ */

export interface PermissionChange {
  app: string;
  permissions: PermissionName[];
  /** Automation: the app that is controlled. */
  target?: string;
}

export interface PermissionOutcome {
  client: TccClient;
  target: TccClient | null;
  /** For the agent. */
  text: string;
}

async function subjects(exec: GuestExec, input: PermissionChange, targetNeeded: boolean): Promise<{ client: TccClient; target: TccClient | null }> {
  const app = checkSpec(input.app, "app");
  const wantsTarget = input.permissions.includes("automation") && !!input.target?.trim();
  if (input.target?.trim() && !input.permissions.includes("automation")) throw new PermissionError('target only goes with the "automation" permission (the app that is controlled).');
  if (targetNeeded && input.permissions.includes("automation") && !wantsTarget) {
    throw new PermissionError('Automation is granted per controlled app: pass target, e.g. target: "System Events" or target: "Finder".');
  }
  const [client, target] = await resolveClients(exec, [app, ...(wantsTarget ? [checkSpec(input.target!, "target")] : [])]);
  if (target && target.type !== 0) throw new PermissionError(`The automation target must be an app; ${target.client} is a bare program.`);
  return { client: client!, target: target ?? null };
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

/** Allow the permissions for an app or program in the guest. */
export async function grantPermissions(exec: GuestExec, input: PermissionChange): Promise<PermissionOutcome> {
  const permissions = unique(input.permissions);
  const { client, target } = await subjects(exec, { ...input, permissions }, true);
  const sql: Record<TccRow["db"], string[]> = { system: [], user: [] };
  const wanted = permissions.map((name) => ({ name, ...PERMISSIONS[name], target: name === "automation" ? target!.client : NO_TARGET }));
  for (const w of wanted) sql[w.db].push(allowSql(w.service, client, w.target));
  for (const db of ["system", "user"] as const) if (sql[db].length) sql[db].push(rowsSql(db, `client = ${q(client.client)} AND client_type = ${client.type}`));
  const rows = tccRows(await runSql(exec, sql));
  const lost = wanted.filter((w) => !rows.some((r) => r.db === w.db && r.service === w.service && r.target === w.target && r.value === ALLOWED));
  if (lost.length) throw new PermissionError(`macOS didn't keep ${joinNames(lost.map((w) => w.label))} for ${who(client)}. Look at the VM's screen.`);
  const names = wanted.map((w) => (w.name === "automation" ? `Automation of ${who(target!)}` : w.label));
  // Not looked up: nothing says an app with this id exists.
  const asGiven = [client, ...(target ? [target] : [])].filter((c) => c.type === 0 && c.label === c.client).map((c) => c.client);
  return {
    client,
    target,
    text:
      `Granted in the VM — ${who(client)}: ${joinNames(names)}.\n` +
      (asGiven.length ? `${joinNames(asGiven)} was used as a bundle id as given, without checking that an app with it is installed; if you meant an app by its name, pass its path.\n` : "") +
      "It applies right away. An app that was already running may only notice after it is quit and reopened (Screen Recording always needs that). " +
      'If a dialog asking for this is still on the VM\'s screen, click "Allow" in it: closing it any other way makes macOS store a refusal (granting again fixes that).',
  };
}

/** Take the permissions away again (macOS asks again when the app next needs them). */
export async function revokePermissions(exec: GuestExec, input: PermissionChange): Promise<PermissionOutcome> {
  const permissions = unique(input.permissions);
  const { client, target } = await subjects(exec, { ...input, permissions }, false);
  const sql: Record<TccRow["db"], string[]> = { system: [], user: [] };
  for (const name of permissions) {
    const { service, db } = PERMISSIONS[name];
    const mine = `client = ${q(client.client)} AND client_type = ${client.type}`;
    const services = name === "accessibility" ? [service, POST_EVENT] : [service];
    const where = `${mine} AND service IN (${services.map(q).join(", ")})${name === "automation" && target ? ` AND indirect_object_identifier = ${q(target.client)}` : ""}`;
    // What was there, then the removal.
    sql[db].push(rowsSql(db, where), `DELETE FROM access WHERE ${where}`);
  }
  // Sending input goes with Accessibility: one name for both entries. Named in the order they were asked for.
  const service = (r: TccRow) => (r.service === POST_EVENT ? PERMISSIONS.accessibility.service : r.service);
  const position = (r: TccRow) => permissions.indexOf(BY_SERVICE.get(service(r))!);
  const rows = tccRows(await runSql(exec, sql)).sort((a, b) => position(a) - position(b) || a.target.localeCompare(b.target));
  const nameOf = (r: TccRow) => (r.service === PERMISSIONS.automation.service ? `Automation of ${r.target}` : serviceLabel(service(r)));
  const had = unique(rows.filter((r) => r.value === ALLOWED).map(nameOf));
  // macOS also keeps an entry for what it refused (an app that asked for Accessibility is listed, switched off).
  const refusals = rows.some((r) => r.value !== ALLOWED);
  return {
    client,
    target,
    text: had.length
      ? `Removed in the VM — ${who(client)}: ${joinNames(had)}. macOS asks again when it is needed.`
      : `${who(client)} wasn't allowed ${joinNames(permissions.map((n) => PERMISSIONS[n].label))} in the VM — nothing to remove.${refusals ? " (A refusal macOS had stored was cleared, so it asks again.)" : ""}`,
  };
}

/** The permissions of one app or program — or, without `app`, of everything that has one. Only the ones named above: macOS keeps internal ones (iCloud, …) in the same table. */
export async function listPermissions(exec: GuestExec, app?: string): Promise<string> {
  const spec = app?.trim() ? checkSpec(app, "app") : null;
  // The guest agent's path, to name it "shell". Without it the list still works.
  const shell = spec === SHELL_CLIENT ? null : await resolveClients(exec, [SHELL_CLIENT]).then(
    (r) => r[0]!,
    (err: unknown) => {
      if (err instanceof PermissionError && err.message === NOT_MACOS) throw err;
      return null;
    },
  );
  const client = spec ? (await resolveClients(exec, [spec]))[0]! : null;
  const known = [...BY_SERVICE.keys(), POST_EVENT].map(q).join(", ");
  const where = `service IN (${known})${client ? ` AND client = ${q(client.client)} AND client_type = ${client.type}` : ""}`;
  const rows = tccRows(await runSql(exec, { system: [rowsSql("system", where)], user: [rowsSql("user", where)] }));
  // Only the database macOS reads a permission from counts (the images write their entries into both).
  const live = rows.filter((r) => homeOf(r.service) === r.db);
  if (!live.length) return client ? `${who(client)} has no privacy permissions in the VM yet.` : "No app in the VM has any of these privacy permissions yet.";
  const byClient = new Map<string, TccRow[]>();
  for (const r of live) byClient.set(r.client, [...(byClient.get(r.client) ?? []), r]);
  const title = (id: string) => {
    if (client?.client === id) return who(client);
    return shell?.client === id ? `${who(shell)} — app: "${SHELL_CLIENT}"` : id;
  };
  const blocks = [...byClient.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, entries]) => {
      const lines = unique(
        entries
          .sort((a, b) => serviceLabel(a.service).localeCompare(serviceLabel(b.service)) || a.target.localeCompare(b.target))
          .map((r) => `- ${serviceLabel(r.service)}${r.target !== NO_TARGET ? ` of ${r.target}` : ""}: ${STATE[r.value] ?? `state ${r.value}`}`),
      );
      return `${title(id)}\n${lines.join("\n")}`;
    });
  return `Privacy permissions in the VM:\n\n${blocks.join("\n\n")}`;
}

/* ------------------------------------------------------------------ */
/* What macOS refused                                                   */
/* ------------------------------------------------------------------ */

const TCC_LOG =
  `if out=$(/usr/bin/log show --last %MINUTES%m --style compact --predicate 'subsystem == "com.apple.TCC" AND process == "tccd" AND ` +
  `(eventMessage BEGINSWITH "AUTHREQ_CTX" OR eventMessage BEGINSWITH "AUTHREQ_SUBJECT" OR eventMessage BEGINSWITH "AUTHREQ_RESULT")' 2>&1); ` +
  `then printf '%s\\n' "$out" | tail -n 9000; else printf '%s\\n' "$out" | tail -n 2 >&2; exit 1; fi`;

export interface DeniedRequest {
  /** Bundle id or path, as macOS names the program it holds responsible. */
  subject: string;
  service: string;
  /** 0 = refused, 1 = not decided (macOS asks, or the program just fails). */
  value: number;
  /** Guest time, "HH:MM:SS". */
  at: string;
}

/**
 * Requests tccd didn't allow, newest first, one per program and permission (its latest answer — a later "allowed"
 * drops it). tccd logs each request as AUTHREQ_CTX (service), AUTHREQ_SUBJECT (who) and AUTHREQ_RESULT (authValue),
 * tied together by a message id.
 */
export function parseDenied(logText: string): DeniedRequest[] {
  const open = new Map<string, { service?: string; subject?: string }>();
  const latest = new Map<string, DeniedRequest>();
  for (const line of logText.split("\n")) {
    const m = /^\S+ (\d\d:\d\d:\d\d)\S*\s.*?\bAUTHREQ_(CTX|SUBJECT|RESULT): msgID=([\w.]+), (.*)$/.exec(line);
    if (!m) continue;
    const [, at, kind, id, rest] = m as unknown as [string, string, string, string, string];
    if (kind === "CTX") {
      open.set(id, { service: /\bservice=(kTCCService\w+)/.exec(rest)?.[1] });
    } else if (kind === "SUBJECT") {
      const req = open.get(id);
      if (req) req.subject = /^subject=(.*?),?\s*$/.exec(rest)?.[1];
    } else {
      const req = open.get(id);
      open.delete(id);
      const value = Number(/\bauthValue=(\d+)/.exec(rest)?.[1]);
      if (!req?.service || !req.subject || !Number.isFinite(value)) continue;
      const key = `${req.subject}\n${req.service}`;
      // Deleted first, so that a repeated request moves to the end. 3 = limited access: allowed too.
      latest.delete(key);
      if (value < ALLOWED) latest.set(key, { subject: req.subject, service: req.service, value, at });
    }
  }
  return [...latest.values()].reverse();
}

/** What macOS refused or left undecided lately, as text for the agent. */
export async function deniedRequests(exec: GuestExec, minutes = 10): Promise<string> {
  const [res, shell] = await Promise.all([
    exec(TCC_LOG.replace("%MINUTES%", String(Math.round(minutes))), { timeoutMs: 90_000 }),
    // The guest agent's path, to name it "shell" (the list works without).
    resolveClients(exec, [SHELL_CLIENT]).then(
      (r) => r[0]!,
      (err: unknown) => {
        if (err instanceof PermissionError && err.message === NOT_MACOS) throw err;
        return null;
      },
    ),
  ]);
  if (res.timedOut) throw new PermissionError("Reading macOS's log in the VM took too long; try fewer minutes.");
  if (res.exitCode !== 0) throw new PermissionError(`macOS's log could not be read in the VM (${failure(res)}).`);
  // Requests for permissions nobody grants by hand (iCloud, …) are noise here; one for Automation is a program asking
  // in general, without the app it wants to control.
  const denied = parseDenied(res.stdout).filter((d) => homeOf(d.service) && d.service !== PERMISSIONS.automation.service);
  const nameOf = (d: DeniedRequest) => BY_SERVICE.get(d.service) ?? "accessibility";
  // macOS's own programs check permissions all the time without needing them.
  const own = denied.filter((d) => /^(com\.apple\.|\/System\/|\/usr\/(libexec|sbin)\/)/.test(d.subject));
  const installed = denied.filter((d) => !own.includes(d)).slice(0, 40);
  const automation = 'Automation requests ("… wants access to control …") aren\'t in this log: the dialog on the VM\'s screen names both apps.';
  const ownBySubject = new Map<string, string[]>();
  for (const d of own) ownBySubject.set(d.subject, unique([...(ownBySubject.get(d.subject) ?? []), nameOf(d)]));
  const ownNames = [...ownBySubject.entries()].slice(0, 6).map(([subject, names]) => `${subject} (${names.join(", ")})`);
  const ownLine = own.length
    ? `\nmacOS's own programs that were not allowed something (usually nothing to fix): ${ownNames.join("; ")}${ownBySubject.size > ownNames.length ? ` and ${ownBySubject.size - ownNames.length} more` : ""}.`
    : "";
  if (!installed.length) return `macOS logged no refused permission request from installed software in the last ${minutes} minutes. ${automation}${ownLine}`;
  const lines = installed.map((d) => {
    const app = shell?.client === d.subject ? `"${SHELL_CLIENT}" (${d.subject})` : d.subject;
    return `- ${d.at}  ${app} — ${nameOf(d)}: ${d.value === 0 ? "refused" : "not decided (macOS asks on screen, or the app just fails)"}`;
  });
  return `Permission requests macOS didn't allow in the last ${minutes} minutes (newest first):\n${lines.join("\n")}\n\nGrant one with {action: "grant", app, permissions}. ${automation}${ownLine}`;
}

/* ------------------------------------------------------------------ */
/* Godmode's own way into the guest                                     */
/* ------------------------------------------------------------------ */

/**
 * Give the Tart guest agent back what Godmode's tools in the guest rely on, when it is missing: the image grants it
 * to one version of the agent's binary (lost when Homebrew upgrades it), and a dialog closed the wrong way stores a
 * refusal. Returns how many entries were written — null when it couldn't be done; never throws (the run goes on
 * without).
 */
export async function ensureAgentAccess(exec: GuestExec, vmId: string): Promise<number | null> {
  try {
    const [agent] = await resolveClients(exec, [SHELL_CLIENT]);
    const sql: Record<TccRow["db"], string[]> = { system: [], user: [] };
    for (const { permission, target } of AGENT_ACCESS) {
      const { service, db } = PERMISSIONS[permission];
      sql[db].push(allowSql(service, agent!, target ?? NO_TARGET, true));
    }
    for (const db of ["system", "user"] as const) sql[db].push("SELECT json_object('fixed', total_changes())");
    const fixed = (await runSql(exec, sql)).reduce((n, r) => n + (typeof r.fixed === "number" ? r.fixed : 0), 0);
    if (fixed) log.info(`restored ${fixed} privacy permission${fixed === 1 ? "" : "s"} of the Tart guest agent in VM ${vmId}`);
    return fixed;
  } catch (err) {
    // No macOS guest, an image with System Integrity Protection, a VM that stopped: nothing to restore, or no way to.
    log.debug(`privacy permissions of the Tart guest agent in VM ${vmId} were not checked: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
