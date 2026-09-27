/**
 * CONTRACT (owner: vault agent). Credentials (website logins) stored in the vault.
 * Passwords/notes are encrypted with vault.seal(value, `credentials.password:<id>` / `credentials.notes:<id>`).
 */
import type { Agent, Credential } from "@godmode/shared";
import type { CredentialInput } from "@godmode/shared";

/** List credentials. workspaceId: undefined/"all" = everything, null = global only, id = that workspace only. Never includes secrets. */
export function listCredentials(_opts: { workspaceId?: string | null | "all"; search?: string } = {}): Credential[] {
  throw new Error("not implemented");
}
/** Get one credential; with reveal=true includes decrypted password + notes (caller must audit). */
export function getCredential(_id: string, _opts: { reveal?: boolean } = {}): Credential {
  throw new Error("not implemented");
}
export function createCredential(_input: CredentialInput): Credential {
  throw new Error("not implemented");
}
export function updateCredential(_id: string, _input: Partial<CredentialInput>): Credential {
  throw new Error("not implemented");
}
export function deleteCredential(_id: string): void {
  throw new Error("not implemented");
}
/** Credentials an agent may use: global + agent's workspace, filtered by agent.permissions.credentialIds. No secrets. */
export function credentialsForAgent(_agent: Agent): Credential[] {
  throw new Error("not implemented");
}
/** Credentials for agent whose domains/url match the given url or domain (subdomains match). */
export function findCredentialsForAgent(_agent: Agent, _urlOrDomain: string): Credential[] {
  throw new Error("not implemented");
}
/** Decrypt username/password for a credential the agent may use. Throws 403 if not in agent scope. */
export function revealForAgent(_agent: Agent, _credentialId: string): { username: string; password: string | null; url: string; totpId: string | null } {
  throw new Error("not implemented");
}
export function markCredentialUsed(_id: string): void {
  throw new Error("not implemented");
}
