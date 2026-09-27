/**
 * CONTRACT (owner: browser agent). Managed Chromium instances (one per browser profile), CDP access,
 * secure secret filling, cookie/session import from the user's Chrome and live view.
 */
import type { Agent, BrowserProfile, ChromeImportInput, ChromeImportResult, LocalChromeProfile } from "@godmode/shared";
import type { McpServerJson } from "../types";

export function listProfiles(): BrowserProfile[] {
  throw new Error("not implemented");
}
/** Ensure a global default profile exists (called at startup). */
export function ensureDefaultProfile(): BrowserProfile {
  throw new Error("not implemented");
}
export function getProfile(_id: string): BrowserProfile {
  throw new Error("not implemented");
}
export function createProfile(_input: { name: string; workspaceId: string | null }): BrowserProfile {
  throw new Error("not implemented");
}
export function updateProfile(_id: string, _patch: { name?: string; isDefault?: boolean }): BrowserProfile {
  throw new Error("not implemented");
}
export async function deleteProfile(_id: string): Promise<void> {
  throw new Error("not implemented");
}
/** Profile an agent should use: agent.browser.profileId ?? workspace default ?? global default. */
export function resolveProfileForAgent(_agent: Agent): BrowserProfile {
  throw new Error("not implemented");
}
/** Start (or reuse) Chromium for the profile with remote debugging on a free loopback port. */
export async function launchBrowser(_profileId: string, _opts: { headless?: boolean } = {}): Promise<{ cdpUrl: string; port: number }> {
  throw new Error("not implemented");
}
export async function stopBrowser(_profileId: string): Promise<void> {
  throw new Error("not implemented");
}
/**
 * MCP server entry giving the agent browser tools (browser-use MCP connected to the profile's Chromium via CDP).
 * Returns null when browser is disabled for the agent or globally.
 */
export async function browserMcpServer(_agent: Agent): Promise<McpServerJson | null> {
  throw new Error("not implemented");
}
/**
 * Type text into the focused (or selector-matched) element of the active page WITHOUT the model seeing it.
 * Used for passwords and TOTP codes.
 */
export async function fillIntoPage(
  _profileId: string,
  _opts: { text: string; selector?: string; urlContains?: string; submit?: boolean },
): Promise<{ ok: boolean; url: string; detail: string }> {
  throw new Error("not implemented");
}
/** URL + title of the most recently active page of the profile browser. */
export async function currentPage(_profileId: string): Promise<{ url: string; title: string } | null> {
  throw new Error("not implemented");
}
export async function listLocalChromeProfiles(): Promise<LocalChromeProfile[]> {
  throw new Error("not implemented");
}
/** Import cookies/sessions from the user's Chrome (profile-use technique) or a cookie JSON into a Godmode profile. */
export async function importChromeSession(_profileId: string, _input: ChromeImportInput): Promise<ChromeImportResult> {
  throw new Error("not implemented");
}
export async function shutdownBrowsers(): Promise<void> {
  /* no-op until implemented */
}
