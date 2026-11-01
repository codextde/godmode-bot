import { rememberSecret } from "../vault/vault";

export interface ForwardedClaudeLogin {
  token: string;
  expiresAt: number | null;
  label: string;
}

const MARGIN_MS = 2 * 60_000;
let current: ForwardedClaudeLogin | null = null;

export function claudeLoginUsable(login: ForwardedClaudeLogin, now = Date.now()): boolean {
  return login.expiresAt === null || login.expiresAt > now + MARGIN_MS;
}

export function setForwardedClaudeLogin(login: ForwardedClaudeLogin | null): void {
  if (login) rememberSecret(login.token);
  current = login;
}

export function forwardedClaudeLogin(now = Date.now()): ForwardedClaudeLogin | null {
  return current && claudeLoginUsable(current, now) ? current : null;
}
