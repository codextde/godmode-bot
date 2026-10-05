import { createServer, type AddressInfo, type Server } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";
import { SYSTEM } from "@/server/audit";
import { lastMailFailure, sendMail, sesHost, testMail } from "@/server/mail";
import { deviceLinkedEmail, escapeHtml, inviteEmail, loginEmail } from "@/server/mail/templates";
import { getSettingsWithSecrets, writeSettings } from "@/server/settings";
import { closeDatabase, resetDatabase, truncateAll } from "../helpers/db";
import { auditRows, seed } from "./fixtures";

beforeAll(resetDatabase);
beforeEach(async () => {
  await truncateAll();
  await seed();
});
afterAll(closeDatabase);

const MESSAGE = { to: "someone@example.com", subject: "Sign in to Godmode Cloud", text: "Link: http://x/auth/verify?token=SECRET", html: "<p>x</p>" };

/** A tiny SMTP server that accepts every message, so the SMTP path runs without the internet. */
function fakeSmtp(): Promise<{ port: number; messages: string[]; server: Server }> {
  const messages: string[] = [];
  const server = createServer((socket) => {
    let data = false;
    let body = "";
    socket.write("220 fake ESMTP\r\n");
    socket.on("data", (chunk) => {
      for (const line of chunk.toString("utf8").split("\r\n")) {
        if (data) {
          if (line === ".") {
            data = false;
            messages.push(body);
            body = "";
            socket.write("250 queued\r\n");
          } else body += `${line}\n`;
          continue;
        }
        if (!line) continue;
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO" || cmd === "HELO") socket.write("250-fake\r\n250 8BITMIME\r\n");
        else if (cmd === "DATA") {
          data = true;
          socket.write("354 go ahead\r\n");
        } else if (cmd === "QUIT") socket.end("221 bye\r\n");
        else socket.write("250 ok\r\n");
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as AddressInfo).port, messages, server })));
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

describe("transports", () => {
  let log: MockInstance<typeof console.log>;
  beforeEach(() => {
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  test("log prints the message, link included", async () => {
    expect(await sendMail(MESSAGE)).toEqual({ ok: true, transport: "log" });
    const printed = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain("To: someone@example.com");
    expect(printed).toContain("Subject: Sign in to Godmode Cloud");
    expect(printed).toContain("/auth/verify?token=SECRET");
  });

  test("a failed delivery is audited without the link and remembered for the system status", async () => {
    const port = await closedPort();
    await writeSettings("email", { transport: "smtp", host: "127.0.0.1", port, security: "none", fromEmail: "cloud@example.com" }, SYSTEM);
    const result = await sendMail({ ...MESSAGE, kind: "login" });
    expect(result.ok).toBe(false);
    const [entry] = await auditRows("mail.failed");
    expect(entry!.meta).toMatchObject({ kind: "login", recipient: "someone@example.com" });
    expect(typeof (entry!.meta as { error: string }).error).toBe("string");
    expect(JSON.stringify(entry)).not.toContain("SECRET");
    expect(lastMailFailure()?.error).toBe((entry!.meta as { error: string }).error);
  });

  test("SMTP delivers, and a success clears the last failure", async () => {
    const smtp = await fakeSmtp();
    try {
      await writeSettings(
        "email",
        { transport: "smtp", host: "127.0.0.1", port: smtp.port, security: "none", fromEmail: "cloud@example.com", fromName: "Acme", replyTo: "help@example.com" },
        SYSTEM,
      );
      expect(await sendMail(MESSAGE)).toEqual({ ok: true, transport: "smtp" });
      expect(smtp.messages).toHaveLength(1);
      expect(smtp.messages[0]).toContain("From: Acme <cloud@example.com>");
      expect(smtp.messages[0]).toContain("Reply-To: help@example.com");
      expect(lastMailFailure()).toBeNull();
    } finally {
      smtp.server.close();
    }
  });

  test("testMail checks unsaved settings and audits failures as kind test", async () => {
    const smtp = await fakeSmtp();
    try {
      const settings = { ...(await getSettingsWithSecrets("email")), transport: "smtp" as const, host: "127.0.0.1", port: smtp.port, security: "none" as const, fromEmail: "cloud@example.com" };
      expect(await testMail(settings, "owner@example.com")).toEqual({ ok: true });
      expect(smtp.messages).toHaveLength(1);
      // Nothing was saved by the test.
      expect((await getSettingsWithSecrets("email")).transport).toBe("log");
    } finally {
      smtp.server.close();
    }
    const port = await closedPort();
    const broken = { ...(await getSettingsWithSecrets("email")), transport: "smtp" as const, host: "127.0.0.1", port, security: "none" as const, fromEmail: "cloud@example.com" };
    const result = await testMail(broken, "owner@example.com");
    expect(result.ok).toBe(false);
    const [entry] = await auditRows("mail.failed");
    expect(entry!.meta).toMatchObject({ kind: "test", recipient: "owner@example.com" });
  });
});

describe("templates", () => {
  test("escape every value", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
    const login = loginEmail({ appName: "<b>Evil</b>", url: "http://localhost:3210/auth/verify?token=a&b=\"c\"", code: "12345678", minutes: 15, ip: "203.0.113.9", device: "Chrome on macOS" });
    expect(login.html).not.toContain("<b>Evil</b>");
    expect(login.html).toContain("&lt;b&gt;Evil&lt;/b&gt;");
    expect(login.html).toContain('href="http://localhost:3210/auth/verify?token=a&amp;b=&quot;c&quot;"');
    expect(login.html).not.toMatch(/<img|https?:\/\/(?!localhost)/);
    const invite = inviteEmail({ appName: "Cloud", url: "http://localhost:3210/invite/t", inviter: "<script>x</script>", role: "Admin", days: 14 });
    expect(invite.html).not.toContain("<script>");
    expect(invite.subject).toBe("<script>x</script> invited you to Cloud");
    const linked = deviceLinkedEmail({ appName: "Cloud", deviceName: "<i>Mac</i>", url: "http://localhost:3210/devices" });
    expect(linked.html).toContain("&lt;i&gt;Mac&lt;/i&gt; was linked to your account. Not you? Remove it.");
  });

  test("the sign-in e-mail shows the code only when there is one", () => {
    const base = { appName: "Cloud", url: "http://localhost:3210/auth/verify?token=t", minutes: 15, ip: "203.0.113.9", device: "Safari on iOS" };
    const withCode = loginEmail({ ...base, code: "12345678" });
    expect(withCode.text).toContain("1234 5678");
    expect(withCode.html).toContain("1234 5678");
    expect(withCode.text).toContain("Requested from Safari on iOS (203.0.113.9)");
    expect(withCode.text).toContain("expires in 15 minutes");
    const noCode = loginEmail({ ...base, code: null });
    expect(noCode.text).not.toContain("enter this code");
    expect(noCode.html).not.toContain("enter this code");
  });

  test("footer links appear when set", () => {
    const footer = { termsUrl: "https://example.com/terms", privacyUrl: "", imprintUrl: "https://example.com/imprint", supportEmail: "help@example.com" };
    const mail = inviteEmail({ appName: "Cloud", url: "http://localhost:3210/invite/t", inviter: null, role: "Member", days: 1, footer });
    expect(mail.text).toContain("Terms: https://example.com/terms");
    expect(mail.text).toContain("Contact help@example.com");
    expect(mail.text).not.toContain("Privacy");
    expect(mail.html).toContain('href="mailto:help@example.com"');
    expect(mail.text).toContain("expires in 1 day.");
  });

  test("SES host", () => {
    expect(sesHost("eu-central-1")).toBe("email-smtp.eu-central-1.amazonaws.com");
  });
});
