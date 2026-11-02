/**
 * oh-my-claudecode starts its unattended modes on everyday words ("end to end", "build me"), and its git guardrail
 * then blocks that session's pushes. Only the human's own words may do that: a hand-over, routine or ticket text
 * can't. A mode's slash command on its own line is a real request from anyone and keeps the detector, so that the
 * run gets its mode state and with it the guardrail.
 */
const DETECTOR = "keyword-detector";
const MODE_COMMAND = /^\s*\/(?:oh-my-claudecode:|omc:)?(?:autopilot|ralph|ralplan|team|ultragoal)(?=\s|$)/im;

/** Only the detector writes autopilot's state: started any other way, the skill would run without the guardrail. */
export const SKILLS_NEEDING_DETECTOR = ["Skill(oh-my-claudecode:autopilot)"];

export function modeKeywordsOff(humanTyped: boolean, prompt: string): boolean {
  return !humanTyped && !MODE_COMMAND.test(prompt);
}

export function skipKeywordDetector(env: Record<string, string | undefined>): void {
  const skipped = (env.OMC_SKIP_HOOKS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  env.OMC_SKIP_HOOKS = [...new Set([...skipped, DETECTOR])].join(",");
}
