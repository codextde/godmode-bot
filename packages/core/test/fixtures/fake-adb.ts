#!/usr/bin/env bun
/**
 * A stand-in for adb in tests. State comes from $FAKE_ADB_DIR/state.json (devices, props, screen sizes, UI XML), every
 * call is appended to calls.jsonl there.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface Phone {
  serialno: string;
  manufacturer?: string;
  model?: string;
  release?: string;
  sdk?: number;
  avd?: string;
  width: number;
  height: number;
  ui?: string;
}

const dir = process.env.FAKE_ADB_DIR!;
const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { devices: string; phones: Record<string, Phone> };
let args = process.argv.slice(2);
let serial: string | null = null;
if (args[0] === "-s") {
  serial = args[1]!;
  args = args.slice(2);
}
// `adb shell` without a command reads its script from stdin (logged apart from the arguments).
const stdin = args.length === 1 && args[0] === "shell" ? (await Bun.stdin.text()).trim() : undefined;
appendFileSync(join(dir, "calls.jsonl"), `${JSON.stringify({ serial, args, ...(stdin !== undefined ? { stdin } : {}) })}\n`);
if (stdin !== undefined) args = ["shell", stdin];
const phone = serial ? state.phones[serial] : undefined;
const out = (s: string) => process.stdout.write(s);

if (args[0] === "version") {
  out("Android Debug Bridge version 1.0.41\nVersion 37.0.1-fake\n");
} else if (args[0] === "devices") {
  out(`List of devices attached\n${state.devices}`);
} else if (serial && !phone) {
  process.stderr.write(`adb: device '${serial}' not found\n`);
  process.exit(1);
} else if (args[0] === "exec-out" && args[1]?.startsWith("screencap")) {
  const { width, height } = phone!;
  const raw = new Uint8Array(16 + width * height * 4);
  const view = new DataView(raw.buffer);
  view.setUint32(0, width, true);
  view.setUint32(4, height, true);
  view.setUint32(8, 1, true);
  for (let i = 16; i < raw.length; i += 4) raw[i] = 200;
  process.stdout.write(args[1].includes("gzip") ? Bun.gzipSync(raw) : raw);
} else if (args[0] === "shell") {
  const cmd = args.slice(1).join(" ");
  if (cmd.includes('echo "ro.serialno=')) {
    const p = phone!;
    out(
      [
        `ro.serialno=${p.serialno}`,
        `ro.product.manufacturer=${p.manufacturer ?? ""}`,
        `ro.product.model=${p.model ?? ""}`,
        `ro.build.version.release=${p.release ?? ""}`,
        `ro.build.version.sdk=${p.sdk ?? ""}`,
        `ro.boot.qemu.avd_name=${p.avd ?? ""}`,
        `ro.kernel.qemu.avd_name=`,
      ].join("\n") + "\n",
    );
  } else if (cmd.includes("dumpsys window displays")) {
    out(`cur=${phone!.width}x${phone!.height}\nPhysical size: ${phone!.width}x${phone!.height}\n`);
  } else if (cmd.includes("dumpsys power")) {
    out("  mWakefulness=Awake\n  status: 2\n  level: 81\n  USB powered: true\n");
  } else if (cmd.includes("uiautomator dump")) {
    out(phone!.ui ?? "<?xml version='1.0' ?><hierarchy rotation=\"0\"></hierarchy>");
  } else if (cmd.startsWith("if [ -d ")) {
    out(cmd.includes("/DCIM'") ? "dir\n" : cmd.includes("/missing") ? "none\n" : "file\n");
  } else if (cmd.startsWith("cmd package resolve-activity")) {
    out(cmd.endsWith("com.example.shop") ? "priority=0 preferredOrder=0 match=0x108000\ncom.example.shop/.MainActivity$Launcher\n" : "No activity found\n");
  } else if (cmd.startsWith("am start")) {
    out("Starting: Intent { act=android.intent.action.MAIN }\n");
  } else if (cmd.startsWith("monkey")) {
    out("** No activities found to run, monkey aborted.\n");
    process.exit(252);
  } else if (cmd.startsWith("pm list packages")) {
    out("package:com.example.shop\npackage:com.zhiliaoapp.musically\n");
  } else if (cmd.startsWith("echo ")) {
    out(`${cmd.slice(5)}\n`);
  } else if (cmd.startsWith("exit ")) {
    process.exit(Number(cmd.slice(5)));
  }
} else if (args[0] === "pull") {
  Bun.write(args[2]!, `pulled ${args[1]}`);
} else if (args[0] === "connect") {
  out(`connected to ${args[1]}\n`);
}
