/**
 * E-mail bodies. Single column, inline CSS, no remote images, one clear button with the link spelled out below it.
 * Every interpolated value is HTML-escaped: addresses, names and device descriptions can come from other people.
 */

export interface MailContent {
  subject: string;
  text: string;
  html: string;
}

/** Links shown at the bottom of every e-mail when the operator filled them in (Settings → General). */
export interface MailFooter {
  supportEmail?: string;
  termsUrl?: string;
  privacyUrl?: string;
  imprintUrl?: string;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const INK = "#1c1c1c";
const PAPER = "#faf9f5";
const ACCENT = "#0eca7b";
const MUTED = "#6b6a66";
const LINE = "#e7e5df";
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

function footerParts(footer: MailFooter | undefined): { text: string; html: string } {
  const links: { label: string; href: string }[] = [];
  if (footer?.termsUrl) links.push({ label: "Terms", href: footer.termsUrl });
  if (footer?.privacyUrl) links.push({ label: "Privacy", href: footer.privacyUrl });
  if (footer?.imprintUrl) links.push({ label: "Imprint", href: footer.imprintUrl });
  if (footer?.supportEmail) links.push({ label: `Contact ${footer.supportEmail}`, href: `mailto:${footer.supportEmail}` });
  if (!links.length) return { text: "", html: "" };
  return {
    text: `\n\n--\n${links.map((l) => (l.href.startsWith("mailto:") ? l.label : `${l.label}: ${l.href}`)).join("\n")}`,
    html: `<p style="margin:24px 0 0;font-size:12px;line-height:18px;color:${MUTED};">${links
      .map((l) => `<a href="${escapeHtml(l.href)}" style="color:${MUTED};text-decoration:underline;">${escapeHtml(l.label)}</a>`)
      .join(" &middot; ")}</p>`,
  };
}

/** Paragraphs are already-escaped HTML fragments. */
function layout(p: { appName: string; heading: string; paragraphs: string[]; button: { label: string; url: string }; after?: string[]; footer?: MailFooter }): string {
  const url = escapeHtml(p.button.url);
  const para = (html: string) => `<p style="margin:0 0 16px;font-size:15px;line-height:22px;color:${INK};">${html}</p>`;
  const small = (html: string) => `<p style="margin:0 0 12px;font-size:13px;line-height:19px;color:${MUTED};">${html}</p>`;
  const footer = footerParts(p.footer).html;
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(p.heading)}</title></head>
<body style="margin:0;padding:0;background:${PAPER};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;font-family:${FONT};">
<tr><td style="padding:0 0 20px;font-size:14px;font-weight:600;color:${INK};"><span style="display:inline-block;width:8px;height:8px;border-radius:4px;background:${ACCENT};margin-right:8px;vertical-align:middle;"></span>${escapeHtml(p.appName)}</td></tr>
<tr><td style="background:#ffffff;border:1px solid ${LINE};border-radius:12px;padding:28px 24px;">
<h1 style="margin:0 0 16px;font-size:20px;line-height:28px;font-weight:600;color:${INK};">${escapeHtml(p.heading)}</h1>
${p.paragraphs.map(para).join("\n")}
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px;"><tr><td style="border-radius:8px;background:${INK};">
<a href="${url}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(p.button.label)}</a>
</td></tr></table>
${small(`Or open this address: <a href="${url}" style="color:${INK};word-break:break-all;">${url}</a>`)}
${(p.after ?? []).map(small).join("\n")}
</td></tr>
<tr><td style="padding:0 4px;">${footer}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** "12345678" → "1234 5678", easier to read; the code field ignores the space. */
function spacedCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code;
}

export function loginEmail(p: {
  appName: string;
  url: string;
  code: string | null;
  minutes: number;
  ip: string;
  device: string;
  footer?: MailFooter;
}): MailContent {
  const subject = `Sign in to ${p.appName}`;
  const expiry = `The link works once and expires in ${p.minutes} minutes.`;
  const origin = `Requested from ${p.device} (${p.ip}). If this wasn't you, ignore this e-mail; nobody can sign in without it.`;
  const textLines = [`Use this link to sign in to ${p.appName}:`, "", p.url, "", expiry];
  if (p.code) textLines.push("", `Or enter this code in the browser where you asked for it: ${spacedCode(p.code)}`);
  textLines.push("", origin);
  const after: string[] = [];
  if (p.code) {
    after.push(
      `Or enter this code in the browser where you asked for it:<br><span style="display:inline-block;margin-top:6px;font-family:${MONO};font-size:22px;letter-spacing:3px;color:${INK};">${escapeHtml(spacedCode(p.code))}</span>`,
    );
  }
  after.push(escapeHtml(origin));
  const html = layout({
    appName: p.appName,
    heading: subject,
    paragraphs: [`Use the button below to sign in to ${escapeHtml(p.appName)}. ${escapeHtml(expiry)}`],
    button: { label: "Sign in", url: p.url },
    after,
    footer: p.footer,
  });
  return { subject, text: textLines.join("\n") + footerParts(p.footer).text, html };
}

export function inviteEmail(p: {
  appName: string;
  url: string;
  inviter: string | null;
  role: string;
  days: number;
  footer?: MailFooter;
}): MailContent {
  const subject = p.inviter ? `${p.inviter} invited you to ${p.appName}` : `You're invited to ${p.appName}`;
  const lead = p.inviter
    ? `${p.inviter} invited you to join ${p.appName} as ${p.role}.`
    : `You were invited to join ${p.appName} as ${p.role}.`;
  const expiry = `The invitation expires in ${p.days} ${p.days === 1 ? "day" : "days"}.`;
  const text = [lead, "", "Accept the invitation here:", "", p.url, "", expiry, "", "If you didn't expect this, you can ignore this e-mail."].join("\n");
  const html = layout({
    appName: p.appName,
    heading: `You're invited to ${p.appName}`,
    paragraphs: [escapeHtml(lead), escapeHtml(expiry)],
    button: { label: "Accept invitation", url: p.url },
    after: ["If you didn't expect this, you can ignore this e-mail."],
    footer: p.footer,
  });
  return { subject, text: text + footerParts(p.footer).text, html };
}

export function deviceLinkedEmail(p: { appName: string; deviceName: string; url: string; footer?: MailFooter }): MailContent {
  const subject = `${p.deviceName} was linked to your ${p.appName} account`;
  const lead = `${p.deviceName} was linked to your account. Not you? Remove it.`;
  const text = [lead, "", "Your computers:", "", p.url].join("\n");
  const html = layout({
    appName: p.appName,
    heading: "A computer was linked",
    paragraphs: [escapeHtml(lead)],
    button: { label: "Review your computers", url: p.url },
    footer: p.footer,
  });
  return { subject, text: text + footerParts(p.footer).text, html };
}
