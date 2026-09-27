/**
 * CONTRACT (owner: vault agent). TOTP (Google Authenticator compatible) 2FA entries.
 * Secrets encrypted with vault.seal(secret, `totp.secret:<id>`).
 */
import type { Agent, TotpCode, TotpEntry, TotpAlgorithm } from "@godmode/shared";
import type { TotpImportInput, TotpImportResult, TotpInput } from "@godmode/shared";

/** RFC 6238 TOTP code for a base32 secret. */
export function generateTotp(_secretBase32: string, _opts: { algorithm?: TotpAlgorithm; digits?: number; period?: number; time?: number } = {}): string {
  throw new Error("not implemented");
}
export function listTotp(_opts: { workspaceId?: string | null | "all"; search?: string } = {}): TotpEntry[] {
  throw new Error("not implemented");
}
export function getTotp(_id: string): TotpEntry {
  throw new Error("not implemented");
}
export function createTotp(_input: TotpInput): TotpEntry {
  throw new Error("not implemented");
}
export function updateTotp(_id: string, _patch: Partial<TotpInput>): TotpEntry {
  throw new Error("not implemented");
}
export function deleteTotp(_id: string): void {
  throw new Error("not implemented");
}
/** Current codes for the given ids (or all). */
export function currentCodes(_ids?: string[]): TotpCode[] {
  throw new Error("not implemented");
}
/** Parse otpauth:// and otpauth-migration:// (Google Authenticator export) URIs and store them. */
export function importTotpUris(_input: TotpImportInput): TotpImportResult {
  throw new Error("not implemented");
}
/** TOTP entries an agent may use (global + its workspace, filtered by permissions.totpIds). */
export function totpForAgent(_agent: Agent): TotpEntry[] {
  throw new Error("not implemented");
}
/** Current code for an entry the agent may use (throws 403 otherwise). Caller audits. */
export function codeForAgent(_agent: Agent, _totpId: string): TotpCode {
  throw new Error("not implemented");
}
