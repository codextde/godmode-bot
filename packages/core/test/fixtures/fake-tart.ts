#!/usr/bin/env bun
/**
 * Fake `tart` CLI for VM tests. Keeps its VMs and cached images in `$TART_HOME/fake-state.json` and mimics the
 * commands Godmode uses: --version, list, pull (with progress), clone, set, run (prints the VNC line, stays up until
 * SIGINT), stop, suspend, delete, ip, exec.
 *
 * `run` serves a fake screen like the guest's macOS Screen Sharing (fixtures/fake-rfb.ts, Apple authentication as
 * admin/admin; its port is the VM's `screenPort` in the state file) and logs the input it receives to
 * `$TART_HOME/vnc-events.jsonl`.
 *
 * `exec` runs the command on the host as a stand-in for the guest, made safe: `/bin/zsh -l -c` becomes `/bin/sh -c`
 * (no login shell resetting PATH), `sudo`, `defaults`, `scutil`, `pmset` and `sw_vers` are no-op shims, the guest home
 * `/Users/admin` is `$TART_HOME/guest-home` and the shared folder mount is the host folder given to `run --dir`.
 *
 * Env: FAKE_TART_PULL_MS — how long a pull takes (default 300); FAKE_TART_BOOT_FAILS — number of `exec` readiness
 * probes that fail before the guest agent "answers" (default 1); FAKE_TART_OS — guest OS of every VM ("darwin"; with
 * "linux", `run --suspendable` fails like the real tart); FAKE_TART_RUN_FAIL — `run` exits with an error right away.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface FakeVm {
  state: "running" | "stopped" | "suspended";
  pid: number | null;
  cpu: number;
  memory: number;
  display: string;
  disk: number;
  source: string;
  shared: string | null;
  generation: number;
  macRandomized: number;
  probes: number;
  screenPort?: number;
}
interface State {
  images: string[];
  vms: Record<string, FakeVm>;
  generation: number;
}

const home = process.env.TART_HOME;
if (!home) {
  process.stderr.write("TART_HOME not set\n");
  process.exit(2);
}
mkdirSync(home, { recursive: true });
const statePath = join(home, "fake-state.json");
const guestHome = join(home, "guest-home");

function load(): State {
  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as State;
  } catch {
    return { images: [], vms: {}, generation: 0 };
  }
}
function save(s: State) {
  const tmp = `${statePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, statePath);
}
/** Load-modify-save under a lock: Godmode runs several tart commands at once (e.g. two clones). */
async function mutate<T>(fn: (s: State) => T): Promise<T> {
  const lock = `${statePath}.lock`;
  for (let i = 0; ; i++) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      // Only a lock left behind by a killed process is broken (every holder keeps it for milliseconds).
      try {
        if (i % 100 === 99 && Date.now() - statSync(lock).mtimeMs > 5000) rmSync(lock, { recursive: true, force: true });
      } catch {
        /* released meanwhile */
      }
      await Bun.sleep(5);
    }
  }
  try {
    const s = load();
    const out = fn(s);
    save(s);
    return out;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
function fail(msg: string, code = 1): never {
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(code);
}
const alive = (pid: number | null) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** A VM whose `run` process died without cleaning up counts as stopped. */
function vmState(vm: FakeVm): FakeVm["state"] {
  return vm.state === "running" && !alive(vm.pid) ? "stopped" : vm.state;
}

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};

switch (cmd) {
  case "--version":
    console.log("2.40.0");
    break;

  case "list": {
    const s = load();
    const source = flag("--source");
    const rows =
      source === "oci"
        ? s.images.map((name) => ({ Source: "OCI", Name: name, Disk: 50, Size: "24.1 GB", Accessed: "now", Running: false, State: "stopped" }))
        : Object.entries(s.vms).map(([name, vm]) => ({
            Source: "local",
            Name: name,
            Disk: `${vm.disk} GB`,
            Size: 12.5,
            Accessed: "now",
            Running: vmState(vm) === "running",
            State: vmState(vm),
          }));
    console.log(JSON.stringify(rows));
    break;
  }

  case "pull": {
    const image = rest.find((a) => !a.startsWith("--") && !/^\d+$/.test(a))!;
    if (rest.includes("--insecure")) {
      // Godmode's loopback registry: fetch the manifest and every blob (one with a range) and check their digests.
      const { createHash } = await import("node:crypto");
      const [, host, repo, ref] = /^([^/]+)\/([^@]+?)(?:@|:(?=[\w.-]+$))(sha256:[a-f0-9]{64}|[\w.-]+)$/.exec(image) ?? [];
      if (!host) fail(`bad reference ${image}`);
      if (!(await fetch(`http://${host}/v2/`)).ok) fail("registry ping failed");
      const manifestRes = await fetch(`http://${host}/v2/${repo}/manifests/${ref}`);
      if (!manifestRes.ok) fail(`manifest: HTTP ${manifestRes.status}`);
      const manifest = (await manifestRes.json()) as { config: { digest: string; size: number }; layers: { digest: string; size: number }[] };
      for (const [i, blob] of [manifest.config, ...manifest.layers].entries()) {
        const head = await fetch(`http://${host}/v2/${repo}/blobs/${blob.digest}`, { method: "HEAD" });
        if (Number(head.headers.get("content-length")) !== blob.size) fail(`HEAD ${blob.digest}: wrong size`);
        let bytes: Buffer;
        if (i === 1) {
          const first = Buffer.from(await (await fetch(`http://${host}/v2/${repo}/blobs/${blob.digest}`, { headers: { Range: "bytes=0-" } })).arrayBuffer());
          const tail = await fetch(`http://${host}/v2/${repo}/blobs/${blob.digest}`, { headers: { Range: `bytes=${Math.floor(blob.size / 2)}-` } });
          if (tail.status !== 206) fail(`range request answered ${tail.status}`);
          bytes = Buffer.concat([first.subarray(0, Math.floor(blob.size / 2)), Buffer.from(await tail.arrayBuffer())]);
        } else bytes = Buffer.from(await (await fetch(`http://${host}/v2/${repo}/blobs/${blob.digest}`)).arrayBuffer());
        if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== blob.digest) fail(`blob ${blob.digest} is corrupt`);
      }
      process.stdout.write("pulling disk...\n\r50%\r100%\n");
      await mutate((s) => {
        if (!s.images.includes(image)) s.images.push(image);
      });
      break;
    }
    if (image.includes("does-not-exist")) fail(`failed to pull ${image}: 404 not found`);
    const ms = Number(process.env.FAKE_TART_PULL_MS ?? 300);
    process.stdout.write(`pulling ${image}...\npulling disk (24.1 GB compressed)...\n`);
    for (const pct of [0, 25, 50, 75, 100]) {
      process.stdout.write(`\r${pct}%`);
      await Bun.sleep(ms / 5);
    }
    process.stdout.write("\n");
    await mutate((s) => {
      if (!s.images.includes(image)) s.images.push(image);
    });
    break;
  }

  case "clone": {
    const [src, name] = rest;
    if (!src || !name) fail("usage: clone <src> <name>");
    await mutate((s) => {
    if (s.vms[name!]) fail(`VM "${name}" already exists`);
    const from = s.vms[src!];
    if (!from && !s.images.includes(src!)) fail(`source ${src} not found`);
    s.generation++;
    s.vms[name!] = {
      state: "stopped",
      pid: null,
      cpu: from?.cpu ?? 4,
      memory: from?.memory ?? 8192,
      display: from?.display ?? "1024x768",
      disk: from?.disk ?? 50,
      source: src!,
      shared: null,
      generation: s.generation,
      macRandomized: 0,
      probes: 0,
    };
    });
    break;
  }

  case "set": {
    const name = rest[0]!;
    await mutate((s) => {
    const vm = s.vms[name] ?? fail(`VM "${name}" does not exist`);
    if (flag("--cpu")) vm.cpu = Number(flag("--cpu"));
    if (flag("--memory")) vm.memory = Number(flag("--memory"));
    if (flag("--display")) vm.display = flag("--display")!;
    if (flag("--disk-size")) {
      if (vmState(vm) === "running") fail("cannot resize the disk of a running VM");
      vm.disk = Number(flag("--disk-size"));
    }
    if (rest.includes("--random-mac")) vm.macRandomized++;
    });
    break;
  }

  case "get": {
    const s = load();
    const vm = s.vms[rest[0]!] ?? fail(`VM "${rest[0]}" does not exist`);
    console.log(
      JSON.stringify({ OS: process.env.FAKE_TART_OS ?? "darwin", CPU: vm.cpu, Memory: vm.memory, Disk: vm.disk, DiskFormat: "raw", Size: "12.5", Display: vm.display, Running: vmState(vm) === "running", State: vmState(vm) }),
    );
    break;
  }

  case "run": {
    const name = rest[0]!;
    if (process.env.FAKE_TART_RUN_FAIL) fail("VirtualMachine failed to start: the disk image is corrupted", 1);
    if (rest.includes("--suspendable") && process.env.FAKE_TART_OS === "linux") fail("You can only suspend macOS VMs", 64);
    const generation = await mutate((s) => {
      const vm = s.vms[name] ?? fail(`VM "${name}" does not exist`);
      if (vmState(vm) === "running") fail(`VM "${name}" is already running`);
      const running = Object.values(s.vms).filter((v) => vmState(v) === "running").length;
      if (running >= 2) fail("VirtualMachineLimitExceeded: The number of VMs exceeds the system limit");
      const dir = rest.find((a) => a.startsWith("--dir="));
      vm.shared = dir ? dir.slice("--dir=".length).split(":").slice(1).join(":") : null;
      vm.state = "running";
      vm.pid = process.pid;
      vm.probes = 0;
      return vm.generation;
    });
    const { startFakeRfb } = await import("./fake-rfb");
    const rfb = await startFakeRfb({
      username: "admin",
      password: "admin",
      width: 128,
      height: 96,
      onEvent: (e) => appendFileSync(join(home, "vnc-events.jsonl"), JSON.stringify({ vm: name, ...e }) + "\n"),
    });
    await mutate((st) => {
      if (st.vms[name]) st.vms[name]!.screenPort = rfb.port;
    });
    console.log(`fake VM ${name} is running (generation ${generation})`);
    const finish = async (state: FakeVm["state"]) => {
      await mutate((s) => {
        const v = s.vms[name];
        if (v && v.pid === process.pid) {
          v.state = state;
          v.pid = null;
        }
      });
      process.exit(0);
    };
    process.on("SIGINT", () => void finish("stopped"));
    process.on("SIGTERM", () => void finish("stopped"));
    process.on("SIGUSR1", () => void finish("suspended"));
    setInterval(() => {}, 1 << 30);
    break;
  }

  case "stop": {
    const name = rest[0]!;
    const s = load();
    const vm = s.vms[name] ?? fail(`VM "${name}" does not exist`);
    if (vm.state === "suspended") {
      await mutate((st) => {
        st.vms[name]!.state = "stopped";
      });
      break;
    }
    if (vmState(vm) !== "running") fail(`VM "${name}" is not running`);
    process.kill(vm.pid!, "SIGINT");
    for (let i = 0; i < 100 && alive(vm.pid); i++) await Bun.sleep(50);
    if (alive(vm.pid)) process.kill(vm.pid!, "SIGKILL");
    await mutate((st) => {
      if (st.vms[name]) {
        st.vms[name]!.state = "stopped";
        st.vms[name]!.pid = null;
      }
    });
    break;
  }

  case "suspend": {
    const name = rest[0]!;
    const s = load();
    const vm = s.vms[name] ?? fail(`VM "${name}" does not exist`);
    if (vmState(vm) !== "running") fail(`VM "${name}" is not running`);
    process.kill(vm.pid!, "SIGUSR1");
    for (let i = 0; i < 100 && alive(vm.pid); i++) await Bun.sleep(50);
    break;
  }

  case "delete": {
    const name = rest[0]!;
    await mutate((s) => {
      if (s.images.includes(name)) {
        s.images = s.images.filter((i) => i !== name);
        return;
      }
      const vm = s.vms[name] ?? fail(`the specified VM "${name}" does not exist`);
      if (vmState(vm) === "running") fail("cannot delete a running VM");
      delete s.vms[name];
    });
    break;
  }

  case "ip": {
    const s = load();
    const vm = s.vms[rest[0]!];
    if (!vm || vmState(vm) !== "running") fail("no IP address found, is your VM running?");
    console.log(`192.168.64.${10 + vm.generation}`);
    break;
  }

  case "exec": {
    const interactive = rest[0] === "-i";
    const args = interactive ? rest.slice(1) : rest;
    const [name, ...command] = args;
    const s = load();
    const vm = s.vms[name!] ?? fail(`VM "${name}" does not exist`);
    if (vmState(vm) !== "running") fail(`VM "${name}" is not running`);
    // The guest agent needs a moment after the VNC line (like a real boot).
    const failures = Number(process.env.FAKE_TART_BOOT_FAILS ?? 1);
    if (vm.probes < failures) {
      await mutate((st) => {
        st.vms[name!]!.probes++;
      });
      fail("failed to connect to the guest agent", 1);
    }
    // Make the "guest": its home, its shared-folder mount and safe stand-ins for system tools.
    const shims = join(home, "shims");
    mkdirSync(join(guestHome), { recursive: true });
    mkdirSync(shims, { recursive: true });
    for (const tool of ["sudo", "defaults", "scutil", "pmset"]) {
      const p = join(shims, tool);
      if (!existsSync(p)) {
        writeFileSync(p, "#!/bin/sh\nexit 0\n");
        chmodSync(p, 0o755);
      }
    }
    const swVers = join(shims, "sw_vers");
    if (!existsSync(swVers)) {
      writeFileSync(swVers, "#!/bin/sh\necho 26.0\n");
      chmodSync(swVers, 0o755);
    }
    const guestize = (arg: string) => {
      let out = arg.replaceAll("/Volumes/My Shared Files/godmode", vm.shared ?? join(home, "no-share")).replaceAll("/Users/admin", guestHome);
      return out;
    };
    let argv = command.map(guestize);
    if (argv[0] === "/bin/zsh") argv = ["/bin/sh", "-c", argv[argv.length - 1]!];
    const proc = Bun.spawn(argv, {
      cwd: guestHome,
      stdin: interactive ? "inherit" : "ignore",
      stdout: "inherit",
      stderr: "inherit",
      env: { HOME: guestHome, USER: "admin", PATH: `${shims}:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: "C" },
    });
    process.exit(await proc.exited);
  }

  default:
    fail(`unknown command ${cmd}`);
}
