import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import type { PasswordImportPreview, PasswordImportResult } from "@godmode/shared";
import { loadConfig } from "../src/config";
import { closeDb, insert, openDb } from "../src/db";
import { createApp } from "../src/server/app";
import { getAccessToken } from "../src/server/auth";
import { listAudit } from "../src/services/audit";
import { resetSettingsCache } from "../src/services/settings";
import { HttpError } from "../src/util";
import { createCredential, getCredential, listCredentials } from "../src/vault/credentials";
import {
  baseDomain,
  displayName,
  groupLogins,
  importPasswords,
  parse1PuxData,
  parseCsv,
  parsePasswordCsv,
  previewPasswordImport,
  readPasswordExport,
  type ExportedLogin,
} from "../src/vault/passwordImport";
import { createTotp, getTotp, listTotp } from "../src/vault/totp";
import * as vault from "../src/vault/vault";

const PASSPHRASE = "password import test passphrase";
const SECRET = "JBSWY3DPEHPK3PXP";
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "godmode-pw-import-test-"));
  loadConfig({ dataDir: dir, token: "test-token" });
  openDb(join(dir, "test.db"));
  resetSettingsCache();
  vault.lock();
  await vault.setup(PASSPHRASE, false);
  const ts = new Date().toISOString();
  insert("workspaces", { id: "ws_a", name: "A", slug: "a", created_at: ts, updated_at: ts });
  insert("workspaces", { id: "ws_b", name: "B", slug: "b", created_at: ts, updated_at: ts });
}, 60_000);

afterAll(() => {
  vault.lock();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const bytes = (s: string) => new TextEncoder().encode(s);
const entry = (e: Partial<ExportedLogin>): ExportedLogin => ({ name: "", url: "", username: "", password: "", notes: "", otp: "", tags: [], ...e });

function status(fn: () => unknown): number | null {
  try {
    fn();
  } catch (err) {
    return err instanceof HttpError ? err.status : -1;
  }
  return null;
}

describe("CSV parsing", () => {
  test("quotes, escaped quotes, line breaks inside quotes and blank lines", () => {
    const rows = parseCsv('a,b,c\r\n"x, y","he said ""hi""","multi\nline"\n\n1,,3');
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["x, y", 'he said "hi"', "multi\nline"],
      ["1", "", "3"],
    ]);
  });

  test("Chrome export: BOM, passwords kept verbatim", () => {
    const { source, entries } = parsePasswordCsv("﻿name,url,username,password,note\ngithub.com,https://github.com/login,me@x.dev, pw ,hello\n");
    expect(source).toBe("chrome");
    expect(entries).toEqual([{ name: "github.com", url: "https://github.com/login", username: "me@x.dev", password: " pw ", notes: "hello", otp: "", tags: [], skip: undefined }]);
  });

  test("1Password CSV: title, OTP, tags and archived items", () => {
    const csv = [
      "Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes",
      `GitHub,https://github.com,me,pw,otpauth://totp/GitHub:me?secret=${SECRET}&issuer=GitHub,false,false,"work,dev",`,
      "Old,https://old.example.com,me,pw,,false,true,,",
    ].join("\n");
    const { source, entries } = parsePasswordCsv(csv);
    expect(source).toBe("1password");
    expect(entries[0]).toMatchObject({ name: "GitHub", otp: expect.stringContaining("otpauth://"), tags: ["work", "dev"] });
    expect(entries[1]!.skip).toBe("Archived");
  });

  test("other managers are recognized by their columns", () => {
    const sourceOf = (header: string) => parsePasswordCsv(`${header}\n`).source;
    expect(sourceOf("folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp")).toBe("bitwarden");
    expect(sourceOf("Title,URL,Username,Password,Notes,OTPAuth")).toBe("apple");
    expect(sourceOf('"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"')).toBe("firefox");
    expect(sourceOf("url,username,password,totp,extra,name,grouping,fav")).toBe("lastpass");
    expect(sourceOf("username,username2,username3,title,password,note,url,category,otpSecret")).toBe("dashlane");
    expect(sourceOf("type,name,url,email,username,password,note,totp,createTime,modifyTime,vault")).toBe("protonpass");
    expect(sourceOf('"Group","Title","Username","Password","URL","Notes","TOTP","Icon","Last Modified","Created"')).toBe("keepass");
    expect(sourceOf("website,password")).toBe("csv");
  });

  test("Bitwarden columns and semicolon separators", () => {
    const bw = parsePasswordCsv("folder,type,name,login_uri,login_username,login_password,login_totp\nWork,login,Jira,https://x.atlassian.net,me,pw,\n");
    expect(bw.entries[0]).toMatchObject({ name: "Jira", url: "https://x.atlassian.net", username: "me", password: "pw", tags: ["Work"] });
    const semi = parsePasswordCsv("name;url;username;password\nx;https://x.de;u;p\n");
    expect(semi.entries[0]).toMatchObject({ url: "https://x.de", password: "p" });
  });

  test("username falls back to the e-mail column", () => {
    const { entries } = parsePasswordCsv("type,name,url,email,username,password\nlogin,Proton,https://proton.me,me@proton.me,,pw\n");
    expect(entries[0]!.username).toBe("me@proton.me");
  });

  test("a CSV without url and password columns is rejected", () => {
    expect(status(() => parsePasswordCsv("foo,bar\n1,2"))).toBe(400);
    expect(status(() => readPasswordExport(new Uint8Array()))).toBe(400);
  });
});

describe("1Password .1pux", () => {
  const exportData = {
    accounts: [
      {
        vaults: [
          {
            items: [
              {
                categoryUuid: "001",
                state: "active",
                overview: { title: "Linear", url: "https://linear.app/login?next=/", tags: ["work"] },
                details: {
                  loginFields: [
                    { value: "me@x.dev", designation: "username", fieldType: "E" },
                    { value: "s3cret", designation: "password", fieldType: "P" },
                  ],
                  notesPlain: "SSO off",
                  sections: [{ fields: [{ value: { totp: `otpauth://totp/Linear:me?secret=${SECRET}` } }] }],
                },
              },
              { categoryUuid: "002", state: "active", overview: { title: "Visa" }, details: {} },
              { categoryUuid: "001", state: "archived", overview: { title: "Old", url: "https://old.dev" }, details: {} },
              { categoryUuid: "001", trashed: true, overview: { title: "Gone" }, details: {} },
            ],
          },
        ],
      },
    ],
  };

  test("reads logins, 2FA and tags from export.data", () => {
    const { source, entries } = parse1PuxData(JSON.stringify(exportData));
    expect(source).toBe("1password");
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ name: "Linear", url: "https://linear.app/login?next=/", username: "me@x.dev", password: "s3cret", notes: "SSO off", tags: ["work"] });
    expect(entries[0]!.otp).toStartWith("otpauth://");
    expect(entries[1]!.skip).toBe("Not a login");
    expect(entries[2]!.skip).toBe("Archived");
  });

  test("unzips the archive and only needs export.data", () => {
    const zip = zipSync({ "export.attributes": strToU8("{}"), "export.data": strToU8(JSON.stringify(exportData)), "files/a.bin": new Uint8Array(64) });
    expect(readPasswordExport(zip).entries[0]!.name).toBe("Linear");
    expect(status(() => readPasswordExport(zipSync({ "other.txt": strToU8("x") })))).toBe(400);
  });

  test("an export.data that unpacks to more than 64 MB is refused before it is inflated", () => {
    const bomb = zipSync({ "export.data": new Uint8Array(65 * 1024 ** 2) });
    expect(bomb.length).toBeLessThan(1024 ** 2);
    expect(status(() => readPasswordExport(bomb))).toBe(413);
  });

  test("damaged export.data is a 400, odd shapes are ignored", () => {
    expect(status(() => parse1PuxData("{"))).toBe(400);
    expect(parse1PuxData("null").entries).toEqual([]);
    expect(parse1PuxData(JSON.stringify({ accounts: 5 })).entries).toEqual([]);
    const odd = parse1PuxData(JSON.stringify({ accounts: [{ vaults: [{ items: [null, { overview: { title: 1, tags: "x", urls: "y" }, details: { loginFields: {}, sections: [null] } }] }] }] }));
    expect(odd.entries).toEqual([{ name: "", url: "", username: "", password: "", notes: "", otp: "", tags: [], skip: undefined }]);
  });

  test("all URLs of an item become domains", () => {
    const item = { categoryUuid: "001", overview: { title: "Atlassian", url: "https://team.atlassian.net", urls: [{ url: "https://team.atlassian.net" }, { url: "https://id.atlassian.com" }] }, details: { loginFields: [{ value: "p", designation: "password" }] } };
    const { entries } = parse1PuxData(JSON.stringify({ accounts: [{ vaults: [{ items: [item] }] }] }));
    expect(groupLogins(entries).logins[0]!.hosts).toEqual(["team.atlassian.net", "id.atlassian.com"]);
  });

  test("Dashlane's zip of CSVs", () => {
    const zip = zipSync({ "credentials.csv": strToU8("username,username2,username3,title,password,note,url,category,otpSecret\nme,,,Jira,pw,,https://x.atlassian.net,,\n") });
    expect(readPasswordExport(zip)).toMatchObject({ source: "dashlane", entries: [{ name: "Jira", password: "pw" }] });
  });

  test("Windows-1252 CSVs keep their accents", () => {
    const latin = new Uint8Array([...bytes("name,url,username,password\nx,https://x.de,me,caf"), 0xe9, 0x0a]);
    expect(readPasswordExport(latin).entries[0]!.password).toBe("café");
  });
});

describe("merging rows", () => {
  test("names, base domains and login URLs", () => {
    expect(baseDomain("accounts.google.com")).toBe("google.com");
    expect(baseDomain("shop.foo.co.uk")).toBe("foo.co.uk");
    expect(baseDomain("login.gmx.de")).toBe("gmx.de");
    expect(displayName("accounts.hetzner.com", "accounts.hetzner.com")).toBe("Hetzner");
    expect(displayName("Amazon Business", "amazon.de")).toBe("Amazon Business");
    expect(displayName("Amazon.de Business", "amazon.de")).toBe("Amazon.de Business");
    expect(displayName("Work: Jira", "x.atlassian.net")).toBe("Work: Jira");
    expect(displayName("https://github.com/login", "github.com")).toBe("Github");
    const { logins } = groupLogins([entry({ url: "https://user:pw@shop.example.com/login;jsessionid=ABC?token=x#y", password: "p" })]);
    expect(logins[0]!.url).toBe("https://shop.example.com/login");
  });

  test("same site + user + password merges, other passwords of the same login conflict, junk is skipped", () => {
    const { logins, skipped } = groupLogins([
      entry({ url: "https://www.bahn.de/login", username: "me@x.de", password: "pw1", notes: "a" }),
      entry({ url: "https://int.bahn.de/", username: "ME@x.de", password: "pw1", notes: "b" }),
      entry({ url: "https://bahn.de/", username: "me@x.de", password: "old" }),
      entry({ url: "https://github.com", username: "me", password: "gh" }),
      entry({ url: "android://abc@com.example.app/", username: "x", password: "y" }),
      entry({ url: "https://nopass.de", username: "x" }),
      entry({ url: "", username: "x", password: "y" }),
      entry({ url: "http://192.168.178.1/", username: "admin", password: "router" }),
      entry({ url: "http://fritz.box/", username: "admin", password: "router" }),
      entry({ url: "http://sn", password: "note" }),
    ]);
    expect(logins).toHaveLength(3);
    const bahn = logins.find((l) => l.password === "pw1")!;
    expect(bahn).toMatchObject({ name: "Bahn", hosts: ["bahn.de", "int.bahn.de"], rows: 2, notes: "a\n\nb" });
    expect(bahn.conflictKey).not.toBeNull();
    expect(logins.find((l) => l.password === "old")!.conflictKey).toBe(bahn.conflictKey);
    expect(logins.find((l) => l.password === "gh")!.conflictKey).toBeNull();
    expect(skipped.map((s) => s.reason)).toEqual([
      "Android app",
      "No password",
      "No website address",
      "Local network address",
      "Local network address",
      "No website address",
    ]);
  });

  test("other subdomains are other accounts; several URLs in one field are split", () => {
    const { logins } = groupLogins([
      entry({ url: "https://acme.okta.com", username: "me@x.de", password: "acme" }),
      entry({ url: "https://globex.okta.com", username: "me@x.de", password: "globex" }),
      entry({ url: "https://a.example.com,https://b.example.org", username: "me", password: "multi" }),
    ]);
    expect(logins.map((l) => l.conflictKey)).toEqual([null, null, null]);
    expect(logins.find((l) => l.password === "multi")!.hosts).toEqual(["a.example.com", "b.example.org"]);
  });

  test("a 2FA-only entry completes the password entry of the same account", () => {
    const { logins } = groupLogins([
      entry({ url: "https://svc.dev", username: "u", password: "pw" }),
      entry({ url: "https://app.svc.dev", username: "u", otp: SECRET }),
    ]);
    expect(logins).toHaveLength(1);
    expect(logins[0]).toMatchObject({ password: "pw", hosts: ["svc.dev", "app.svc.dev"], conflictKey: null, rows: 2 });
    expect(logins[0]!.totp?.secret).toBe(SECRET);
  });

  test("2FA from an otpauth URI or a bare secret; unreadable secrets are flagged", () => {
    const { logins } = groupLogins([
      entry({ name: "GitHub", url: "https://github.com", username: "me", password: "p", otp: `otpauth://totp/?secret=${SECRET}` }),
      entry({ name: "GitLab", url: "https://gitlab.com", username: "me", password: "p", otp: SECRET.toLowerCase() }),
      entry({ name: "Steam", url: "https://steampowered.com", username: "me", password: "p", otp: "steam://ABC" }),
      entry({ name: "Only2FA", url: "https://only.dev", username: "me", otp: SECRET }),
    ]);
    const by = (name: string) => logins.find((l) => l.name === name)!;
    expect(by("GitHub").totp).toMatchObject({ issuer: "GitHub", accountName: "me", secret: SECRET });
    expect(by("GitLab").totp).toMatchObject({ issuer: "GitLab", secret: SECRET });
    expect(by("Steam")).toMatchObject({ totp: null, totpUnreadable: true });
    expect(by("Only2FA").totp).not.toBeNull();
  });
});

describe("import into the vault", () => {
  const chrome = (...rows: string[]) => bytes(["name,url,username,password,note", ...rows].join("\n"));

  test("new logins, then the same file again changes nothing", () => {
    const file = chrome("github.com,https://github.com/login,octo,gh-pw,", "accounts.google.com,https://accounts.google.com/,me@gmail.com,g-pw,personal");
    const preview = previewPasswordImport(file, null);
    expect(preview.source).toBe("chrome");
    expect(preview.rows.map((r) => [r.name, r.action])).toEqual([
      ["Github", "new"],
      ["Google", "new"],
    ]);
    expect(JSON.stringify(preview)).not.toContain("gh-pw");

    expect(importPasswords(file, null, [0, 1])).toMatchObject({ created: 2, updated: 0, totp: 0 });
    const google = listCredentials({ workspaceId: null }).find((c) => c.name === "Google")!;
    expect(getCredential(google.id, { reveal: true })).toMatchObject({ username: "me@gmail.com", password: "g-pw", notes: "personal", domains: ["accounts.google.com"] });

    const again = previewPasswordImport(file, null);
    expect(again.rows.every((r) => r.action === "unchanged")).toBe(true);
    expect(importPasswords(file, null, [0, 1])).toMatchObject({ created: 0, updated: 0 });
  });

  test("a changed password, a new domain and 2FA update the saved login", () => {
    const file = chrome(`github.com,https://gist.github.com/,octo,gh-new,`);
    const [row] = previewPasswordImport(file, null).rows;
    expect(row).toMatchObject({ action: "update", existingName: "Github", changes: ["password"], replacesPassword: true });
    importPasswords(file, null, [0]);
    const gh = listCredentials({ workspaceId: null }).find((c) => c.name === "Github")!;
    expect(getCredential(gh.id, { reveal: true }).password).toBe("gh-new");

    const jira = createCredential({ name: "Jira", url: "https://team.atlassian.net", username: "me", password: "j-pw" });
    const withTotp = bytes(
      [
        "Title,URL,Username,Password,Notes,OTPAuth",
        `Jira,https://team.atlassian.net,me,j-pw,,otpauth://totp/Atlassian:me?secret=${SECRET}`,
        "Jira,https://admin.atlassian.net,me,j-pw,,",
      ].join("\n"),
    );
    const [update] = previewPasswordImport(withTotp, null).rows;
    expect(update).toMatchObject({ existingId: jira.id, changes: ["website", "2FA"], rows: 2 });
    expect(importPasswords(withTotp, null, [0])).toMatchObject({ updated: 1, totp: 1 });
    const linked = getCredential(jira.id);
    expect(linked.domains).toEqual(["team.atlassian.net", "admin.atlassian.net"]);
    expect(getTotp(linked.totpId!)).toMatchObject({ issuer: "Atlassian", accountName: "me", credentialId: jira.id });
  });

  test("a saved login for a subdomain is never overwritten by the parent domain's password", () => {
    const forum = createCredential({ name: "Forum", url: "https://community.example.com", username: "me@x.de", password: "forum-pw", notes: "keep" });
    const file = chrome("example.com,https://example.com/login,me@x.de,main-pw,new notes");
    const [row] = previewPasswordImport(file, null).rows;
    expect(row).toMatchObject({ action: "new", existingId: null });
    importPasswords(file, null, [0]);
    expect(getCredential(forum.id, { reveal: true })).toMatchObject({ password: "forum-pw", notes: "keep", domains: ["community.example.com"] });

    const sub = chrome("community.example.com,https://community.example.com/,me@x.de,forum-new,other notes");
    const [update] = previewPasswordImport(sub, null).rows;
    expect(update).toMatchObject({ action: "update", existingId: forum.id, changes: ["password"] });
    importPasswords(sub, null, [0]);
    expect(getCredential(forum.id, { reveal: true })).toMatchObject({ password: "forum-new", notes: "keep", username: "me@x.de" });
  });

  test("a login without username is completed; an unlinked 2FA entry with the same secret is reused", () => {
    const saved = createCredential({ name: "Hetzner", url: "https://accounts.hetzner.com", username: "" });
    const scanned = createTotp({ issuer: "Hetzner", accountName: "billing", secret: "KRSXG5CTMVRXEZLU" });
    const csv = bytes(`name,url,username,password,otp\nhetzner,https://accounts.hetzner.com/login,billing@x.de,h-pw,KRSXG5CTMVRXEZLU\n`);
    const [row] = previewPasswordImport(csv, null).rows;
    expect(row).toMatchObject({ action: "update", existingId: saved.id, changes: ["password", "username", "2FA"], replacesPassword: false });
    const before = listTotp({ workspaceId: null }).length;
    importPasswords(csv, null, [0]);
    expect(listTotp({ workspaceId: null })).toHaveLength(before);
    expect(getCredential(saved.id)).toMatchObject({ username: "billing@x.de", totpId: scanned.id });
  });

  test("a workspace import reuses an unlinked global 2FA entry, but only with the same parameters", () => {
    const global = createTotp({ issuer: "Zoho", accountName: "me", secret: "MFRGGZDFMZTWQ2LK" });
    const eightDigits = createTotp({ issuer: "Wise", accountName: "me", secret: "ONSWG4TFOQ", digits: 8 });
    const csv = bytes(
      [
        "name,url,username,password,otp",
        "zoho,https://accounts.zoho.eu,me,z-pw,MFRGGZDFMZTWQ2LK",
        "wise,https://wise.com,me,w-pw,ONSWG4TFOQ",
      ].join("\n"),
    );
    expect(importPasswords(csv, "ws_b", [0, 1])).toMatchObject({ created: 2, totp: 2 });
    const [wise, zoho] = listCredentials({ workspaceId: "ws_b" });
    expect(zoho).toMatchObject({ name: "zoho", totpId: global.id });
    expect(wise!.totpId).not.toBe(eightDigits.id);
    expect(getTotp(wise!.totpId!)).toMatchObject({ workspaceId: "ws_b", digits: 6 });
  });

  test("conflicting passwords: only one may be imported", () => {
    const file = chrome("shop.dev,https://shop.dev,me,one,", "shop.dev,https://www.shop.dev,me,two,");
    const { rows } = previewPasswordImport(file, "ws_a");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.conflictKey).toBe(rows[1]!.conflictKey);
    expect(rows.map((r) => r.passwordHint)).toEqual(["••••••", "••••••"]);
    const long = previewPasswordImport(chrome("a.dev,https://a.dev,me,amz-old-2024,", "a.dev,https://a.dev,me,amz-current,"), "ws_a").rows;
    expect(long.map((r) => r.passwordHint).sort()).toEqual(["a••••••4", "a••••••t"]);
    expect(previewPasswordImport(chrome("b.dev,https://b.dev,me,pw,"), "ws_a").rows[0]!.passwordHint).toBeUndefined();
    expect(status(() => importPasswords(file, "ws_a", [0, 1]))).toBe(400);
    expect(importPasswords(file, "ws_a", [1])).toMatchObject({ created: 1 });
    expect(listCredentials({ workspaceId: "ws_a" })).toHaveLength(1);
    expect(listCredentials({ workspaceId: null }).some((c) => c.name === "Shop")).toBe(false);
    const after = previewPasswordImport(file, "ws_a").rows;
    expect(after.map((r) => r.action).sort()).toEqual(["unchanged", "update"]);
  });

  test("needs an unlocked vault and an existing workspace", async () => {
    const file = chrome("x.dev,https://x.dev,me,pw,");
    expect(status(() => previewPasswordImport(file, "ws_missing"))).toBe(404);
    vault.lock();
    const lockedStatus = status(() => previewPasswordImport(file, null));
    await vault.unlock(PASSPHRASE);
    expect(lockedStatus).toBe(423);
  }, 60_000);
});

describe("routes", () => {
  let app: ReturnType<typeof createApp>;
  let auth: Record<string, string>;

  beforeAll(async () => {
    if (!vault.isUnlocked()) await vault.unlock(PASSPHRASE);
    app = createApp();
    auth = { authorization: `Bearer ${getAccessToken()}`, host: "127.0.0.1" };
  });

  const upload = async <T>(path: string, fields: Record<string, string | Blob>, headers: Record<string, string> = {}) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    const res = await app.request(path, { method: "POST", headers: { ...auth, ...headers }, body: form });
    return { status: res.status, data: (await res.json()) as T };
  };

  const grant = async () => {
    const res = await app.request("/api/vault/grant", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ passphrase: PASSPHRASE }),
    });
    return { "x-godmode-grant": ((await res.json()) as { grant: string }).grant };
  };

  test("preview and import need a passphrase grant", async () => {
    const file = new Blob(["name,url,username,password\nroutes.dev,https://routes.dev,me,pw\n"]);
    expect((await upload<{ code: string }>("/api/credentials/import/preview", { file })).data.code).toBe("grant_required");
    expect((await upload<{ code: string }>("/api/credentials/import", { file, ids: "[0]" })).data.code).toBe("grant_required");

    const headers = await grant();
    const preview = await upload<PasswordImportPreview>("/api/credentials/import/preview", { file, workspaceId: "" }, headers);
    expect(preview.status).toBe(200);
    expect(preview.data.rows[0]).toMatchObject({ name: "Routes", action: "new" });

    expect((await upload("/api/credentials/import", { file, ids: "nope" }, headers)).status).toBe(400);
    const done = await upload<PasswordImportResult>("/api/credentials/import", { file, ids: "[0]" }, headers);
    expect(done).toEqual({ status: 200, data: { created: 1, updated: 0, totp: 0 } });
    expect(listAudit(5, "credential.import")[0]?.details).toMatchObject({ created: 1, source: "chrome" });
  });

  test("rejects JSON bodies", async () => {
    const res = await app.request("/api/credentials/import/preview", {
      method: "POST",
      headers: { ...auth, ...(await grant()), "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
  });
});
