/**
 * Keeps one run's cleanup from ending everything else on this computer. On macOS pkill and pgrep stop reading options at
 * the pattern, so in `pkill -f "next-server" -n` the `-n` is a second pattern: it matches every process with "-n" anywhere
 * in its command line, and that is Chrome, other apps and other runs. Claude Code's PreToolUse hook asks here.
 */
import { AT_COMMAND } from "../browser/cdpGuard";

const MATCHER = new RegExp(`${AT_COMMAND}(?:(?:then|do|else|\\{|exec|command|nohup|sudo)\\s+)*(?:pkill|pgrep)(?=[ \\t])`, "gm");
const WORD = /(?:[ \t]|\\\n)*((?:"(?:\\.|[^"\\])*"|'[^']*'|\\.|[^\s;|&()\x60"'\\])+)/y;
const WITH_VALUE = "FGJMNPUdgstu";
const LONG_WITH_VALUE = /^--(?:signal|euid|uid|group|pgroup|session|terminal|parent|pidfile|delimiter)$/;
const SIGNAL = /^-(?:\d+|[A-Z]{2,}\d*)$/;

function takesValue(option: string): boolean {
  if (option.startsWith("--")) return LONG_WITH_VALUE.test(option);
  if (SIGNAL.test(option)) return false;
  const first = [...option.slice(1)].findIndex((ch) => WITH_VALUE.includes(ch));
  return first === option.length - 2;
}

/** The first option written after the pattern of the command that starts at `from`, or null. */
function optionAfterPattern(text: string, from: number): string | null {
  let pattern = false;
  let skip = false;
  WORD.lastIndex = from;
  for (let m = WORD.exec(text); m; m = WORD.exec(text)) {
    const word = m[1]!.replace(/^["']|["']$/g, "");
    if (skip) skip = false;
    else if (word === "--" || word.startsWith("#")) return null;
    else if (!word.startsWith("-") || word === "-") pattern = true;
    else if (pattern) return word;
    else skip = takesValue(word);
  }
  return null;
}

/** Why the shell command would match nearly every process, or null when it wouldn't. */
export function sweepingKill(command: unknown): string | null {
  if (typeof command !== "string") return null;
  for (const m of command.matchAll(MATCHER)) {
    const option = optionAfterPattern(command, m.index + m[0].length);
    if (option) {
      return `Blocked: on macOS pkill and pgrep stop reading options at the pattern, so \`${option}\` here is one more pattern that matches nearly every process on this computer, including other runs and the browser. Put the options first (\`pkill -n -f "pattern"\`).`;
    }
  }
  return null;
}
