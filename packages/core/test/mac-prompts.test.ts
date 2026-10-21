import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, MessageBlock } from "@godmode/shared";
import { RUN_WATCHDOG } from "@godmode/shared";
import { makeAgent, setupEnv, until, type TestEnv } from "./fixtures/runner-harness";
import { bus } from "../src/events/bus";
import { computerName } from "../src/mobile/devices";
import { buildSystemPrompt } from "../src/runner/prompt";
import { waitForRun, watchedRuns } from "../src/runner/runner";
import { __setWatchdogForTests, assess, checkRuns } from "../src/runner/watchdog";
import { startChat } from "../src/services/conversations";
import { macPromptHolding, parseTccLine, pendingMacPrompts, promptAct, setMacPromptDeps, startMacPrompts, stopMacPrompts, type MacPromptDeps } from "../src/services/macPrompts";
import { listNotifications } from "../src/services/notifications";
import { __setPrivacyProbeForTests, fullDiskAccess } from "../src/services/permissions";
import { getSettings } from "../src/services/settings";

// The lines of the Mac where a runner waited six hours for someone to click Allow.
const PROMPTING_COMPACT =
  "2026-10-20 12:16:24.967 Df tccd[465:14ed4c8] [com.apple.TCC:access] AUTHREQ_PROMPTING: msgID=164.8047, service=kTCCServiceSystemPolicyDesktopFolder, subject=Sub:{/Users/m/.local/bin/godmode}Resp:{TCCDProcess: identifier=godmode-core, pid=50968, auid=501, euid=501, responsible_path=/Users/m/.local/bin/godmode, binary_path=/Users/m/.local/bin/godmode},";
const PROMPTING_NDJSON = String.raw`{"timezoneName":"","messageType":"Default","eventType":"logEvent","source":null,"launchPersonaName":"","formatString":"AUTHREQ_PROMPTING: msgID=%{public}@, service=%{public}@, subject=%{public}@, ","userID":501,"activityIdentifier":23644204,"subsystem":"com.apple.TCC","category":"access","personaType":-1,"threadID":21943496,"launchPersonaType":-1,"senderImageUUID":"EC9AD616-30AC-39E5-99F4-C53B62F7E234","launchPersonaID":4294967295,"backtrace":{"frames":[{"imageOffset":84872,"imageUUID":"EC9AD616-30AC-39E5-99F4-C53B62F7E234"}]},"bootUUID":"8E2717C6-082C-4787-8655-458F4759563A","processImagePath":"\/System\/Library\/PrivateFrameworks\/TCC.framework\/Support\/tccd","senderImagePath":"\/System\/Library\/PrivateFrameworks\/TCC.framework\/Support\/tccd","personaID":4294967295,"timestamp":"2026-10-20 12:16:24.967038+0200","machTimestamp":19038440172865,"personaName":"","eventMessage":"AUTHREQ_PROMPTING: msgID=164.8047, service=kTCCServiceSystemPolicyDesktopFolder, subject=Sub:{\/Users\/m\/.local\/bin\/godmode}Resp:{TCCDProcess: identifier=godmode-core, pid=50968, auid=501, euid=501, responsible_path=\/Users\/m\/.local\/bin\/godmode, binary_path=\/Users\/m\/.local\/bin\/godmode},","processImageUUID":"EC9AD616-30AC-39E5-99F4-C53B62F7E234","traceID":3478232053776388,"processID":465,"senderProgramCounter":84872,"parentActivityIdentifier":23644202}`;
const RESULT_COMPACT =
  "2026-10-20 18:39:00.231 Df tccd[465:14ed4c8] [com.apple.TCC:access] AUTHREQ_RESULT: msgID=164.8047, authValue=2, authReason=2, authVersion=1, desired_auth=0, error=(null),";
const EVENT_COMPACT =
  "2026-10-20 18:39:00.232 Df tccd[465:15d26c9] [com.apple.TCC:events] Publishing <TCCDEvent: type=Create, service=kTCCServiceSystemPolicyDesktopFolder, identifier_type=Path, identifier=/Users/m/.local/bin/godmode> to 3 subscribers: {";
const EVENT_NDJSON = String.raw`{"timezoneName":"","messageType":"Default","eventType":"logEvent","source":null,"formatString":"Publishing %{public}@ to %lu subscribers: %{public}@","userID":501,"subsystem":"com.apple.TCC","category":"events","processImagePath":"\/System\/Library\/PrivateFrameworks\/TCC.framework\/Support\/tccd","timestamp":"2026-10-20 18:39:00.232667+0200","eventMessage":"Publishing <TCCDEvent: type=Create, service=kTCCServiceSystemPolicyDesktopFolder, identifier_type=Path, identifier=\/Users\/m\/.local\/bin\/godmode> to 3 subscribers: {\n    495 = \"<TCCDEventSubscriber: token=495, state=Initial, csid=(null)>\";\n    478 = \"<TCCDEventSubscriber: token=478, state=Passed, csid=com.apple.chronod>\";\n}","processID":465}`;

/** A line as `log` writes it now (compact style, local time), for a prompt or answer of this program. */
function stamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
const promptingLine = (msgId: string, service = "kTCCServiceSystemPolicyDesktopFolder", path = process.execPath) =>
  `${stamp()} Df tccd[465:1] [com.apple.TCC:access] AUTHREQ_PROMPTING: msgID=${msgId}, service=${service}, subject=Sub:{${path}}Resp:{TCCDProcess: identifier=godmode-core, pid=1, auid=501, euid=501, responsible_path=${path}, binary_path=${path}},`;
const resultLine = (msgId: string) => `${stamp()} Df tccd[465:1] [com.apple.TCC:access] AUTHREQ_RESULT: msgID=${msgId}, authValue=2, authReason=2, authVersion=1, desired_auth=0, error=(null),`;

describe("reading macOS's privacy log", () => {
  test("a prompt, in compact and ndjson style", () => {
    const desktop = { kind: "prompting", msgId: "164.8047", service: "SystemPolicyDesktopFolder", responsiblePath: "/Users/m/.local/bin/godmode", binaryPath: "/Users/m/.local/bin/godmode", identifier: "godmode-core", pid: 50968 };
    expect(parseTccLine(PROMPTING_COMPACT)).toEqual({ ...desktop, at: new Date(2026, 9, 20, 12, 16, 24, 967).getTime() } as never);
    expect(parseTccLine(PROMPTING_NDJSON)).toEqual({ ...desktop, at: Date.parse("2026-10-20T12:16:24.967+02:00") } as never);
    // In the app, macOS holds the app responsible; its path has a space.
    const app = parseTccLine(
      "AUTHREQ_PROMPTING: msgID=88.12, service=kTCCServiceSystemPolicyDocumentsFolder, subject=Sub:{dev.codext.godmode}Resp:{TCCDProcess: identifier=dev.codext.godmode, pid=812, auid=501, euid=501, responsible_path=/Applications/Godmode Bot.app/Contents/MacOS/godmode-bot, binary_path=/Applications/Godmode Bot.app/Contents/MacOS/godmode-bot},",
    );
    expect(app).toMatchObject({ service: "SystemPolicyDocumentsFolder", responsiblePath: "/Applications/Godmode Bot.app/Contents/MacOS/godmode-bot", identifier: "dev.codext.godmode", pid: 812 });
  });

  test("the answer, and what is no prompt", () => {
    expect(parseTccLine(RESULT_COMPACT)).toMatchObject({ kind: "result", msgId: "164.8047", at: new Date(2026, 9, 20, 18, 39, 0, 231).getTime() });
    expect(parseTccLine(EVENT_COMPACT)).toMatchObject({ kind: "event", service: "SystemPolicyDesktopFolder", identifier: "/Users/m/.local/bin/godmode" });
    expect(parseTccLine(EVENT_NDJSON)).toMatchObject({ kind: "event", service: "SystemPolicyDesktopFolder", identifier: "/Users/m/.local/bin/godmode", at: Date.parse("2026-10-20T18:39:00.232+02:00") });
    for (const line of ['Filtering the log data using "subsystem == "com.apple.TCC""', '{"count":3,"finished":1}', "", "{not json", "Timestamp               Ty Process[PID:TID]"]) {
      expect(parseTccLine(line)).toBeNull();
    }
  });

  test("what macOS asks about, in plain words", () => {
    expect(promptAct("kTCCServiceSystemPolicyDesktopFolder")).toBe("open your Desktop folder");
    expect(promptAct("SystemPolicyDownloadsFolder")).toBe("open your Downloads folder");
    expect(promptAct("SystemPolicyRemovableVolumes")).toBe("open a removable drive");
    expect(promptAct("FileProviderPresence")).toBe("open iCloud Drive or another cloud folder");
    expect(promptAct("AppleEvents")).toBe("control another app");
    expect(promptAct("AddressBook")).toBe("open your contacts");
    expect(promptAct("Camera")).toBe("use the camera");
    expect(promptAct("ScreenCapture")).toBe("record the screen");
    expect(promptAct("ListenEvent")).toBe("watch the keyboard");
    expect(promptAct("kTCCServiceBluetoothAlways")).toBe("use something macOS protects");
  });
});

describe("the watchdog and a macOS dialog", () => {
  const tool = (id: string, name: string, input: unknown): MessageBlock => ({ type: "tool_use", id, name, input });
  const limits = { stallMs: 20 * 60_000, loopRepeats: 4 };
  const t0 = Date.parse("2026-10-20T10:16:00Z");
  const run = { blocks: [tool("b", "Bash", { command: "ls -l ~/Desktop/fuerstenberger*" })], lastOutputAt: t0, startedAt: t0, waiting: false };
  const hold = { pending: true, act: "open your Desktop folder", computer: "Mac mini" };
  // The step's label reads the settings (secrets are masked in it): this needs a database of its own.
  let env: TestEnv;
  beforeAll(async () => {
    env = await setupEnv("godmode-mac-watchdog-");
  });
  afterAll(async () => {
    await env.close();
  });

  test("a run waiting for the answer is left alone; one stopped anyway says what it waited for", () => {
    expect(assess(run, t0 + 6 * 3_600_000, limits, hold)).toBeNull();
    const v = assess(run, t0 + 6 * 3_600_000, limits, { ...hold, pending: false })!;
    expect(v.kind).toBe("stalled");
    expect(v.report).toContain("while this step ran");
    expect(v.report).toContain("— macOS was waiting on Mac mini for someone to allow Godmode to open your Desktop folder.");
    expect(assess(run, t0 + 6 * 3_600_000, limits)!.report).not.toContain("macOS");
    expect(macPromptHolding({ ...run, runId: "run_x" })).toBeNull();
  });
});

describe("watching while runs work", () => {
  let env: TestEnv;
  let agent: Agent;
  const spawned: { argv: string[]; push: (line: string) => void; killed: boolean }[] = [];
  const shown: string[][] = [];
  let showOutput = () => "";

  function fakeStream(argv: string[]) {
    let out!: ReadableStreamDefaultController<Uint8Array>;
    let exit!: (code: number) => void;
    const stdout = new ReadableStream<Uint8Array>({ start: (c) => void (out = c) });
    const exited = new Promise<number>((resolve) => (exit = resolve));
    const proc = { argv, killed: false, push: (line: string) => out.enqueue(new TextEncoder().encode(`${line}\n`)) };
    spawned.push(proc);
    return {
      stdout,
      exited,
      kill: () => {
        proc.killed = true;
        out.close();
        exit(0);
      },
    };
  }

  const useDeps = (over: Partial<MacPromptDeps> = {}) =>
    setMacPromptDeps({
      platform: "darwin",
      spawn: fakeStream,
      show: async (argv) => {
        shown.push(argv);
        return showOutput();
      },
      lingerMs: 100,
      tickMs: 50,
      silentMs: 0,
      slackMs: 100,
      ...over,
    });
  const isNote = (label: string) => label.startsWith(`Waiting for you on ${computerName()}`);
  const warnings = () => listNotifications().filter((n) => n.title === `macOS is waiting on ${computerName()}`);
  const inStep = (runId: string) => watchedRuns().some((r) => r.runId === runId && r.blocks.some((b) => b.type === "tool_use" && b.result === undefined));
  /** The run has been silent a while: what macOS asks from now on holds it. */
  const quiet = (runId: string) => until(() => watchedRuns().some((r) => r.runId === runId && performance.now() - r.lastOutputAt > 300), 10_000, "the run to be quiet");

  beforeAll(async () => {
    env = await setupEnv("godmode-mac-prompts-");
    // No real Full Disk Access probe from these runs.
    __setPrivacyProbeForTests(async () => null);
    agent = await makeAgent({ name: "Downloader" });
    useDeps();
    startMacPrompts();
  });

  afterAll(async () => {
    stopMacPrompts();
    setMacPromptDeps(null);
    __setPrivacyProbeForTests(undefined);
    __setWatchdogForTests({ stallMs: null });
    await env.close();
  });

  test("follows the log only while runs work; a prompt shows on the run, tells the human once and holds off the watchdog", async () => {
    expect(spawned.length).toBe(0);
    const { run, conversation } = await startChat({ agentId: agent.id, content: "LONG_STEP fetch the files" });
    await until(() => spawned.length === 1, 10_000, "the log stream");
    const stream = spawned[0]!;
    expect(stream.argv.slice(0, 4)).toEqual(["/usr/bin/log", "stream", "--style", "ndjson"]);
    expect(stream.argv[5]).toContain("AUTHREQ_PROMPTING");
    await until(() => inStep(run.id), 10_000, "the step");
    await quiet(run.id);
    const labels: string[] = [];
    const off = bus.on((e) => {
      if (e.type === "run.activity" && e.runId === run.id) labels.push(e.label);
    });
    __setWatchdogForTests({ stallMs: 300 });
    try {
      // Another program's prompt is none of Godmode's business.
      stream.push(promptingLine("900.1", "kTCCServiceSystemPolicyDesktopFolder", "/Applications/Other.app/Contents/MacOS/Other"));
      stream.push(promptingLine("900.2"));
      await until(() => labels.some(isNote), 5_000, "the run to show the prompt");
      expect(pendingMacPrompts()).toEqual([{ service: "SystemPolicyDesktopFolder", act: "open your Desktop folder" }]);
      expect(labels.find(isNote)).toBe(`Waiting for you on ${computerName()}: macOS asks whether Godmode may open your Desktop folder`.slice(0, 120));
      // A second command waiting for the same dialog: still one notification.
      stream.push(promptingLine("900.3"));
      await new Promise((r) => setTimeout(r, 200));
      const told = warnings();
      expect(told.length).toBe(1);
      expect(told[0]).toMatchObject({ kind: "warning", link: `/chat/${conversation.id}` });
      expect(told[0]!.body).toContain("Downloader wants to open your Desktop folder. Click Allow in the macOS dialog on");
      expect(told[0]!.body).toContain("Full Disk Access (System Settings → Privacy & Security → Full Disk Access)");

      const later = performance.now() + 2 * 3_600_000 - 60_000;
      expect(checkRuns(later)).toBe(0);
      // Someone clicked Allow: the run has its own label back, and silence counts again.
      stream.push(resultLine("900.2"));
      await until(() => pendingMacPrompts().length === 0, 5_000, "the prompt to be over");
      expect(isNote(labels.at(-1)!)).toBe(false);
      expect(checkRuns(later)).toBe(1);
      const done = await waitForRun(run.id, 10_000);
      expect(done.error!.startsWith(RUN_WATCHDOG)).toBe(true);
      expect(done.error).not.toContain("macOS");
    } finally {
      off();
      __setWatchdogForTests({ stallMs: null });
    }
    // The last run ended: the stream stops a little later.
    await until(() => stream.killed, 5_000, "the stream to stop");
  });

  test("a prompt nobody answers is given up, and the watchdog names it when it stops the run", async () => {
    useDeps({ giveUpMs: 1_500 });
    const before = spawned.length;
    const { run } = await startChat({ agentId: agent.id, content: "LONG_STEP fetch the files" });
    await until(() => spawned.length === before + 1 && inStep(run.id), 10_000, "the step");
    await quiet(run.id);
    const labels: string[] = [];
    const off = bus.on((e) => {
      if (e.type === "run.activity" && e.runId === run.id) labels.push(e.label);
    });
    __setWatchdogForTests({ stallMs: 300 });
    try {
      spawned.at(-1)!.push(promptingLine("902.1"));
      await until(() => labels.some(isNote), 5_000, "the run to show the prompt");
      await until(() => pendingMacPrompts().length === 0, 5_000, "the prompt to be given up");
      expect(isNote(labels.at(-1)!)).toBe(false);
      expect(checkRuns(performance.now() + 10 * 60_000)).toBe(1);
      const done = await waitForRun(run.id, 10_000);
      expect(done.error).toContain(`— macOS was waiting on ${computerName()} for someone to allow Godmode to open your Desktop folder.`);
    } finally {
      off();
      __setWatchdogForTests({ stallMs: null });
      useDeps();
    }
    await until(() => spawned.at(-1)!.killed, 5_000, "the stream to stop");
  });

  test("without the stream, a silent step reads the log, and the prompt is over once the run goes on", async () => {
    const before = spawned.length;
    useDeps({
      // A user who may not stream the log: `log stream` ends at once.
      spawn: (argv) => {
        const proc = fakeStream(argv);
        proc.kill();
        return proc;
      },
      silentMs: 300,
      // The watch outlasts the run: only the run going on can end the prompt here.
      lingerMs: 30_000,
    });
    showOutput = () => ['Filtering the log data using "subsystem == "com.apple.TCC""', promptingLine("901.1", "kTCCServiceSystemPolicyDownloadsFolder"), '{"count":1,"finished":1}'].join("\n");
    const stepDone = join(env.stateDir, "step-done");
    try {
      const { run } = await startChat({ agentId: agent.id, content: "LONG_STEP fetch the files" });
      const labels: string[] = [];
      const off = bus.on((e) => {
        if (e.type === "run.activity" && e.runId === run.id) labels.push(e.label);
      });
      await until(() => shown.length > 0, 10_000, "the log to be read");
      expect(spawned.length).toBe(before + 1);
      expect(shown[0]!.slice(0, 6)).toEqual(["/usr/bin/log", "show", "--last", "90s", "--style", "ndjson"]);
      await until(() => labels.some(isNote), 5_000, "the run to show the prompt");
      expect(labels.find(isNote)).toContain("open your Downloads folder");
      expect(macPromptHolding(watchedRuns().find((r) => r.runId === run.id)!)).toMatchObject({ pending: true, act: "open your Downloads folder" });
      writeFileSync(stepDone, "");
      const done = await waitForRun(run.id, 15_000);
      off();
      expect(done.status).toBe("succeeded");
      await until(() => pendingMacPrompts().length === 0, 5_000, "the prompt to be over");
    } finally {
      rmSync(stepDone, { force: true });
      stopMacPrompts();
    }
  });

  test("Full Disk Access is answered from what was found, asked again in the background", async () => {
    __setPrivacyProbeForTests(async () => ({ accessibility: null, screenRecording: null, fullDiskAccess: false, fullDiskAccessHere: false }));
    try {
      fullDiskAccess();
      await until(() => fullDiskAccess() === false, 2_000, "the answer");
      const prompt = buildSystemPrompt({ agent, settings: getSettings(), peers: [agent], browserAvailable: false, macFolderPrompts: true });
      expect(prompt).toContain("macOS asks the person at this computer before a command may open Desktop, Documents, Downloads, iCloud Drive or a removable drive");
      expect(buildSystemPrompt({ agent, settings: getSettings(), peers: [agent], browserAvailable: false })).not.toContain("macOS asks");
    } finally {
      __setPrivacyProbeForTests(async () => null);
    }
  });
});
