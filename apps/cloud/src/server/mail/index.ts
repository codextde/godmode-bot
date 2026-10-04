/**
 * Sending e-mail. Transport "log" prints the message (with its link) to the server log, which is how the first owner
 * signs in before SMTP is set up. Transport "smtp" uses nodemailer (Amazon SES works through its SMTP interface).
 */
import { createTransport } from "nodemailer";
import { audit, SYSTEM } from "../audit";
import { getSettings, getSettingsWithSecrets, type EmailSettings } from "../settings";
import { shared } from "../shared";
import { escapeHtml, type MailFooter } from "./templates";

export type MailKind = "login" | "invite" | "test" | "notice";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** For the audit entry when sending fails. */
  kind?: MailKind;
}

export type MailResult = { ok: true; transport: "log" | "smtp" } | { ok: false; error: string };

interface MailStatus {
  lastFailure: { at: string; error: string } | null;
}

const status = () => shared<MailStatus>("mailStatus", () => ({ lastFailure: null }));

/** The last failed delivery since the server started (cleared by the next successful one), for the system status. */
export function lastMailFailure(): { at: string; error: string } | null {
  return status().lastFailure;
}

/** Amazon SES SMTP endpoint of a region, e.g. "eu-central-1". */
export function sesHost(region: string): string {
  return `email-smtp.${region.trim().toLowerCase()}.amazonaws.com`;
}

/** Regions with an SES SMTP endpoint, for the region select in the e-mail settings. */
export const SES_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "ca-central-1",
  "eu-central-1",
  "eu-central-2",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-north-1",
  "eu-south-1",
  "ap-south-1",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "ap-southeast-1",
  "ap-southeast-2",
  "sa-east-1",
] as const;

/** Terms, privacy, imprint and support address for the bottom of every e-mail. */
export async function mailFooter(): Promise<MailFooter> {
  const general = await getSettings("general");
  return { supportEmail: general.supportEmail, termsUrl: general.termsUrl, privacyUrl: general.privacyUrl, imprintUrl: general.imprintUrl };
}

function printToLog(msg: MailMessage): void {
  const rule = "─".repeat(60);
  console.log(`\n[mail] ${rule}\n[mail] To: ${msg.to}\n[mail] Subject: ${msg.subject}\n\n${msg.text}\n[mail] ${rule}\n`);
}

function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, " ").trim().slice(0, 300) || "Unknown error";
}

function transportFor(settings: EmailSettings) {
  if (!settings.host) throw new Error("No SMTP server is set.");
  if (!settings.fromEmail) throw new Error("No sender address is set.");
  return createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.security === "tls",
    requireTLS: settings.security === "starttls",
    ignoreTLS: settings.security === "none",
    auth: settings.username ? { user: settings.username, pass: settings.password } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

async function deliver(settings: EmailSettings, appName: string, msg: MailMessage, verifyFirst = false): Promise<void> {
  const transport = transportFor(settings);
  try {
    if (verifyFirst) await transport.verify();
    await transport.sendMail({
      from: { name: settings.fromName || appName, address: settings.fromEmail },
      to: msg.to,
      replyTo: settings.replyTo || undefined,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    });
  } finally {
    transport.close();
  }
}

async function recordFailure(msg: MailMessage, error: string): Promise<void> {
  // The link or code is never part of the record: the audit log is readable by admins.
  await audit(SYSTEM, "mail.failed", null, { kind: msg.kind ?? "notice", recipient: msg.to, error });
}

/** Sends with the stored e-mail settings. Never throws; failures are audited (`mail.failed`). */
export async function sendMail(msg: MailMessage): Promise<MailResult> {
  try {
    const settings = await getSettingsWithSecrets("email");
    if (settings.transport === "log") {
      printToLog(msg);
      return { ok: true, transport: "log" };
    }
    const { appName } = await getSettings("general");
    await deliver(settings, appName, msg);
    if (msg.kind !== "test") status().lastFailure = null;
    return { ok: true, transport: "smtp" };
  } catch (err) {
    const error = describeError(err);
    console.error(`[mail] could not send "${msg.subject}" to ${msg.to}: ${error}`);
    if (msg.kind !== "test") status().lastFailure = { at: new Date().toISOString(), error };
    await recordFailure(msg, error);
    return { ok: false, error };
  }
}

/**
 * Checks `settings` (not yet saved) by connecting, then sends a test message to `to`. An empty password means the
 * stored one, as in the settings form.
 */
export async function testMail(settings: EmailSettings, to: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { appName } = await getSettings("general");
  const subject = `Test e-mail from ${appName}`;
  const text = `This is a test e-mail from ${appName}. If you can read it, sending works.`;
  const msg: MailMessage = { to, subject, text, html: `<p style="font-family:sans-serif;">${escapeHtml(text)}</p>`, kind: "test" };
  try {
    if (settings.transport === "log") {
      printToLog(msg);
      return { ok: true };
    }
    const stored = await getSettingsWithSecrets("email");
    await deliver({ ...settings, password: settings.password || stored.password }, appName, msg, true);
    return { ok: true };
  } catch (err) {
    const error = describeError(err);
    await recordFailure(msg, error);
    return { ok: false, error };
  }
}
