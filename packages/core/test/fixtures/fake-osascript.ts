/** Stands in for `osascript -`: reads the script from stdin, checks the password, runs the command with plain sh. */
import { appendFileSync } from "node:fs";

const source = await new Response(Bun.stdin.stream()).text();
appendFileSync(process.env.FAKE_OSASCRIPT_LOG!, `${JSON.stringify({ argv: process.argv.slice(2), source })}\n`);
const str = '"((?:[^"\\\\]|\\\\.)*)"';
const m = new RegExp(`^do shell script ${str} user name ${str} password ${str} with administrator privileges without altering line endings$`, "s").exec(source);
if (!m) {
  console.error("0:1: syntax error (-2740)");
  process.exit(1);
}
const plain = (s: string) => s.replace(/\\(.)/gs, "$1");
if (plain(m[3]!) !== process.env.FAKE_MAC_PASSWORD) {
  console.error("0:179: execution error: The administrator user name or password was incorrect. (-60005)");
  process.exit(1);
}
const child = Bun.spawnSync(["/bin/sh", "-c", plain(m[1]!)]);
if (child.exitCode) {
  console.error(`0:9: execution error: boom (${child.exitCode})`);
  process.exit(1);
}
process.stdout.write(`${child.stdout.toString()}\n`);
