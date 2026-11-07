import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePairingLink, type Agent, type ChatFile, type ChatFiles, type MobilePairResult, type MobilePairingOffer, type Task } from "@godmode/shared";
import { loadConfig } from "../src/config";
import { closeDb, openDb } from "../src/db";
import { setLogLevel } from "../src/log";
import { mobileUrls, startMobileAccess, stopMobileAccess } from "../src/mobile/access";
import { cloudRefusal } from "../src/cloud/scope";
import { deviceBodyKeys, deviceMayCall } from "../src/mobile/scope";
import { setTailscaleOverride } from "../src/mobile/tailscale";
import { createApp } from "../src/server/app";
import { checkDashboardPassword, getAccessToken } from "../src/server/auth";
import { websocketHandler } from "../src/server/ws";
import { listAudit } from "../src/services/audit";
import { createConversation } from "../src/services/conversations";
import { resetSettingsCache, updateSettings } from "../src/services/settings";
import { createAgent } from "../src/agents/service";
import { createTask, getTask } from "../src/tasks/service";

/** What a phone gets of the files a chat names, the dashboard password from a phone, and clearing a column of the board. */

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

let dataDir: string;
let outside: string;
let app: ReturnType<typeof createApp>;
let token: string;
let base: string;
let agent: Agent;
let chatId: string;
let full: { token: string; id: string };
let limited: { token: string; id: string };

function desktop(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body) headers.set("content-type", "application/json");
  return app.request(`http://127.0.0.1${path}`, { ...init, headers }, { requestIP: () => ({ address: "127.0.0.1", family: "IPv4", port: 50000 }) });
}

function phone(device: { token: string }, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${device.token}`);
  if (init.body) headers.set("content-type", "application/json");
  return fetch(`${base}${path}`, { ...init, headers });
}

const relayed = (path: string, init: RequestInit = {}) =>
  app.fetch(new Request(`http://cloud.link${path}`, { ...init, headers: { "content-type": "application/json" } }), {
    channel: "cloud",
    cloud: { user: { id: "usr_1", email: "owner@example.com", name: "Owner", role: "owner" }, ip: "203.0.113.9" },
  });

const send = (method: string, body: unknown = {}): RequestInit => ({ method, body: JSON.stringify(body) });
const code = async (res: Response) => ((await res.json()) as { code?: string }).code;

async function pair(name: string): Promise<{ token: string; id: string }> {
  const offer = (await (await desktop("/api/mobile/pairing", { method: "POST" })).json()) as MobilePairingOffer;
  base = mobileUrls()[1]!;
  const payload = parsePairingLink(offer.link)!;
  const res = await fetch(`${base}/api/mobile/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: payload.code, name, platform: "ios" }) });
  const result = (await res.json()) as MobilePairResult;
  return { token: result.token, id: result.device.id };
}

const askFiles = async (device: { token: string }, refs: string[]) => {
  const res = await phone(device, `/api/conversations/${chatId}/files`, send("POST", { messages: [refs] }));
  expect(res.status).toBe(200);
  return (await res.json()) as ChatFiles;
};
const byRef = (files: ChatFile[]) => Object.fromEntries(files.map((f) => [f.ref, f]));

beforeAll(async () => {
  setLogLevel("error");
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "godmode-mobile-files-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "godmode-mobile-files-out-")));
  loadConfig({ dataDir, token: "mobile-files-token" });
  openDb(join(dataDir, "test.db"));
  resetSettingsCache();
  updateSettings({ memory: { autoCommit: false }, browser: { enabled: false } });
  app = createApp();
  token = getAccessToken();
  setTailscaleOverride({ installed: true, running: true, ip: "127.0.0.1", dnsName: "localhost", tailnet: "me@example.com", detail: null });
  updateSettings({ mobile: { enabled: false, port: 0 }, cloud: { enabled: true } });
  startMobileAccess({ app, websocket: websocketHandler });
  full = await pair("Full iPhone");
  limited = await pair("Limited iPhone");
  await desktop(`/api/mobile/devices/${full.id}`, send("PATCH", { fullAccess: true }));

  agent = await createAgent({ name: "File Bot" } as never);
  chatId = createConversation({ agentId: agent.id } as never).id;
  const shots = join(agent.repoPath, "workspace", "shots");
  mkdirSync(shots, { recursive: true });
  writeFileSync(join(shots, "01.png"), PNG);
  writeFileSync(join(agent.repoPath, "workspace", "report.pdf"), "%PDF-1.4 report");
  writeFileSync(join(agent.repoPath, "workspace", "notes.txt"), "notes");
  writeFileSync(join(agent.repoPath, "workspace", ".env"), "KEY=1");
  writeFileSync(join(agent.repoPath, "workspace", "server.pem"), "key");
  mkdirSync(join(agent.repoPath, "runs"), { recursive: true });
  writeFileSync(join(agent.repoPath, "runs", "log.txt"), "raw log");
  writeFileSync(join(outside, "elsewhere.png"), PNG);
  writeFileSync(join(outside, "elsewhere.pdf"), "%PDF-1.4 elsewhere");
  writeFileSync(join(outside, "fake.pdf"), "not a pdf");
  symlinkSync(join(outside, "elsewhere.png"), join(agent.repoPath, "workspace", "link.png"));
});

afterAll(() => {
  stopMobileAccess();
  setTailscaleOverride(null);
  closeDb();
  resetSettingsCache();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("the files a chat names, on a phone", () => {
  test("the route opens narrowly for limited phones", () => {
    expect(deviceMayCall("POST", "/api/conversations/cnv_1/files")).toBe(true);
    expect(deviceBodyKeys("POST", "/api/conversations/cnv_1/files")).toEqual(["messages"]);
    expect(deviceMayCall("GET", "/api/conversations/cnv_1/files")).toBe(false);
    expect(deviceMayCall("POST", "/api/conversations/cnv_1/files/x")).toBe(false);
    for (const path of ["/api/files/image", "/api/files/markdown", "/api/files/text", "/api/files/pdf"]) expect(deviceMayCall("GET", path)).toBe(false);
    expect(deviceMayCall("POST", "/api/files/reveal")).toBe(false);
  });

  test("a limited phone learns only of what it may open in the agent's folder", async () => {
    const refs = [
      "workspace/shots/01.png",
      "workspace/report.pdf",
      "workspace/notes.txt",
      "workspace/shots/",
      "workspace/.env",
      "workspace/server.pem",
      "runs/log.txt",
      "workspace/link.png",
      join(outside, "elsewhere.png"),
      "/etc/hosts",
      "../../etc/hosts",
    ];
    const answer = await askFiles(limited, refs);
    expect(answer.local).toBe(false);
    expect(answer.agentId).toBe(agent.id);
    const files = byRef(answer.files[0]!);
    expect(Object.keys(files)).toEqual(["workspace/shots/01.png", "workspace/report.pdf", "workspace/notes.txt", "workspace/shots/"]);
    const picture = files["workspace/shots/01.png"]!;
    expect(picture.path).toBe("workspace/shots/01.png");
    expect(picture.agentPath).toBe("workspace/shots/01.png");
    expect(picture.image).toStartWith(`/api/agents/${agent.id}/files/raw?path=workspace%2Fshots%2F01.png&v=`);
    expect(files["workspace/report.pdf"]).toMatchObject({ agentPath: "workspace/report.pdf", image: null, markdown: null });
    expect(files["workspace/report.pdf"]!.pdf).toBeUndefined();
    expect(files["workspace/shots/"]).toMatchObject({ kind: "folder", agentPath: "workspace/shots" });
    // The address it was given opens; what it wasn't given stays refused.
    expect((await phone(limited, picture.image!)).status).toBe(200);
    for (const path of [`/api/files/image?path=${encodeURIComponent(join(outside, "elsewhere.png"))}`, `/api/files/pdf?path=${encodeURIComponent(join(outside, "elsewhere.pdf"))}`]) {
      const res = await phone(limited, path);
      expect([path, res.status]).toEqual([path, 403]);
    }
  });

  test("a limited phone can't tell what exists outside the agent's folder", async () => {
    const elsewhere = join(outside, "probe");
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, "secret-name.txt"), "x");
    mkdirSync(join(agent.repoPath, "memory"), { recursive: true });
    writeFileSync(join(agent.repoPath, "memory", "secret-name.txt"), "x");
    const asked = async (dir: string) => Object.keys(byRef((await askFiles(limited, ["memory/", `${dir}/`, "secret-name.txt"])).files[0]!));
    expect(await asked(elsewhere)).toEqual(await asked(join(outside, "not-there")));
  });

  test("the PDF route is for the owner on the cloud channel", async () => {
    expect(await cloudRefusal("GET", "/api/files/pdf", "viewer", async () => ({}))).toBeTruthy();
    expect(await cloudRefusal("GET", "/api/files/pdf", "owner", async () => ({}))).toBeNull();
  });

  test("a limited phone can't send more than the references", async () => {
    const res = await phone(limited, `/api/conversations/${chatId}/files`, send("POST", { messages: [], agentId: "x" }));
    expect(res.status).toBe(403);
    expect(await code(res)).toBe("device_forbidden");
  });

  test("a phone with full access gets the computer's addresses, and where a file lies in the agent's folder", async () => {
    const answer = await askFiles(full, ["workspace/report.pdf", "workspace/shots/01.png", join(outside, "elsewhere.png"), join(outside, "elsewhere.pdf"), join(outside, "fake.pdf"), "workspace/.env"]);
    expect(answer.agentId).toBe(agent.id);
    const files = byRef(answer.files[0]!);
    expect(files["workspace/report.pdf"]!.agentPath).toBe("workspace/report.pdf");
    expect(files["workspace/report.pdf"]!.pdf).toStartWith("/api/files/pdf?path=");
    expect(files["workspace/shots/01.png"]!.image).toStartWith("/api/files/image?path=");
    expect(files[join(outside, "elsewhere.png")]!.agentPath).toBeUndefined();
    expect(files[join(outside, "fake.pdf")]!.pdf).toBeUndefined();
    const pdf = await phone(full, files[join(outside, "elsewhere.pdf")]!.pdf!);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(await pdf.text()).toBe("%PDF-1.4 elsewhere");
  });

  test("the PDF route reads PDFs and nothing else", async () => {
    for (const path of [join(outside, "fake.pdf"), join(outside, "elsewhere.png"), "/etc/hosts"]) {
      const res = await desktop(`/api/files/pdf?path=${encodeURIComponent(path)}`);
      expect([path, res.status]).toEqual([path, 404]);
    }
  });

  test("the computer's own answer stays as it was", async () => {
    const res = await desktop(`/api/conversations/${chatId}/files`, send("POST", { messages: [["workspace/notes.txt"]] }));
    const answer = (await res.json()) as ChatFiles;
    expect(answer.agentId).toBeUndefined();
    expect(answer.files[0]![0]!.agentPath).toBeUndefined();
  });
});

describe("the dashboard password from a phone", () => {
  const route = "/api/settings/dashboard-password";

  test("is refused to limited phones and the cloud", async () => {
    const res = await phone(limited, route, send("PUT", { password: "long enough 1" }));
    expect(res.status).toBe(403);
    expect(await code(res)).toBe("device_forbidden");
    expect(deviceMayCall("PUT", route)).toBe(false);
    const cloud = await relayed(route, send("PUT", { password: "long enough 2" }));
    expect(cloud.status).toBe(403);
    expect(await code(cloud)).toBe("cloud_forbidden");
    const through = await app.fetch(new Request(`http://cloud.link${route}`, { method: "PUT", body: JSON.stringify({ password: "long enough 3" }), headers: { "content-type": "application/json", authorization: `Bearer ${full.token}` } }), {
      channel: "mobile",
      cloud: { user: null, ip: "203.0.113.7" },
    });
    expect(through.status).toBe(403);
    expect(await code(through)).toBe("cloud_forbidden");
    expect(checkDashboardPassword("long enough 1") || checkDashboardPassword("long enough 2") || checkDashboardPassword("long enough 3")).toBe(false);
  });

  test("another computer can't set it by calling itself a phone with full access", async () => {
    for (const header of ["1", "full"]) {
      const res = await app.fetch(new Request(`http://link${route}`, { method: "PUT", body: JSON.stringify({ password: "long enough 4" }), headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-godmode-phone": header } }), { channel: "runner-link" });
      expect([header, res.status]).toEqual([header, 403]);
    }
    expect(checkDashboardPassword("long enough 4")).toBe(false);
  });

  test("validates like the auth route", async () => {
    for (const password of ["short", "x".repeat(513), 12345678]) {
      const res = await phone(full, route, send("PUT", { password }));
      expect([password, res.status]).toEqual([password, 400]);
    }
  });

  test("a phone with full access and the computer set it, and it is audited", async () => {
    expect((await phone(full, route, send("PUT", { password: "from the phone 1" }))).status).toBe(200);
    expect(checkDashboardPassword("from the phone 1")).toBe(true);
    const entry = listAudit(20, "auth.password_changed")[0]!;
    expect(JSON.stringify(entry)).toContain("Full iPhone");
    expect((await desktop(route, send("PUT", { password: "from the computer 1" }))).status).toBe(200);
    expect(checkDashboardPassword("from the computer 1")).toBe(true);
    const settings = (await (await phone(full, "/api/settings")).json()) as { server: { hasDashboardPassword: boolean } };
    expect(settings.server.hasDashboardPassword).toBe(true);
  });
});

describe("archiving a column of the board", () => {
  test("a limited phone archives tasks and sends nothing else", async () => {
    const task = (await createTask({ title: "Done one", workspaceId: null } as never)) as Task;
    expect(deviceMayCall("POST", "/api/tasks/archive")).toBe(true);
    expect(deviceMayCall("GET", "/api/tasks/archive/x")).toBe(false);
    expect(deviceBodyKeys("POST", "/api/tasks/archive")).toEqual(["ids", "archived"]);
    const refused = await phone(limited, "/api/tasks/archive", send("POST", { ids: [task.id], force: true }));
    expect(refused.status).toBe(403);
    const res = await phone(limited, "/api/tasks/archive", send("POST", { ids: [task.id] }));
    expect(res.status).toBe(200);
    expect(getTask(task.id).archivedAt).toBeTruthy();
  });
});
