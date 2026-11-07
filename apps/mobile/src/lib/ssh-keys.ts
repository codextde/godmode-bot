/** Key file names in ~/.ssh, checked like the desktop does before the computer is asked. */
export const SSH_KEY_NAME = /^[A-Za-z0-9_@+][A-Za-z0-9._@+-]*$/;

/** `base`, or `base_2`, `base_3`… when that name is taken. */
export function freeKeyName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base}_${n}`)) return `${base}_${n}`;
}

/** Why a name can't be used (a vault string key), or null. */
export function keyNameProblem(name: string, taken: string[]): "sshKeys.nameTaken" | "sshKeys.nameInvalid" | null {
  const clean = name.trim();
  if (!clean) return null;
  if (taken.includes(clean)) return "sshKeys.nameTaken";
  if (!SSH_KEY_NAME.test(clean) || /\.pub$/i.test(clean)) return "sshKeys.nameInvalid";
  return null;
}
