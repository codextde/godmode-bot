import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Agent, MessageBlock } from "@godmode/shared";
import { makeAgent, setupEnv, until, type TestEnv } from "./fixtures/runner-harness";
import { get, setMeta, run as sql } from "../src/db";
import { callTool, listToolsFor } from "../src/mcp/tools";
import { getAgent } from "../src/agents/service";
import { createConversation, listMessages, startChat } from "../src/services/conversations";
import { listQuestions } from "../src/services/questions";
import { listRuns, waitForRun } from "../src/runner/runner";
import { updateSettings } from "../src/services/settings";
import { checkSettingsPatch } from "../src/services/settingsPatch";
import * as vault from "../src/vault/vault";
import { parseConversation } from "../src/calls/elevenlabs";
import { __lookForInboundForTests, getCall, inQuietHours, listCalls, ownerCallRefusal, placeCall, startCalls, stopCalls, tick } from "../src/calls/calls";

let env: TestEnv;
let agent: Agent;
const realFetch = globalThis.fetch;

interface Sent {
  method: string;
  path: string;
  json: Record<string, unknown> | null;
}

/** A stand-in for the ElevenLabs API. */
const fake = {
  sent: [] as Sent[],
  agents: 0,
  assigned: null as string | null,
  calls: new Map<string, Record<string, unknown>>(),
  list: [] as { conversation_id: string; direction: string; status: string }[],
  next: 0,
};

function fakeCall(id: string, status: string, turns: [string, string][], data: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
  fake.calls.set(id, {
    conversation_id: id,
    status,
    has_audio: status === "done",
    transcript: turns.map(([role, message], i) => ({ role, message, time_in_call_secs: i * 4 })),
    metadata: { start_time_unix_secs: 1, call_duration_secs: turns.length * 4, cost_fiat: 0.12, phone_call: { direction: "outbound", external_number: "+4930999", call_result: "answered" }, ...extra },
    analysis:
      status === "done"
        ? {
            call_successful: "success",
            transcript_summary: "Booked a haircut.",
            data_collection_results: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, { value: v }])),
          }
        : null,
  });
}

function respond(method: string, path: string, json: Record<string, unknown> | null): Response {
  const ok = (body: unknown) => Response.json(body);
  if (method === "POST" && path === "/v1/convai/agents/create") return ok({ agent_id: `agent_${++fake.agents}` });
  if (method === "GET" && path.startsWith("/v1/convai/agents/")) return ok({ agent_id: path.split("/").pop() });
  if (method === "PATCH" && path.startsWith("/v1/convai/agents/")) return ok({});
  if (method === "GET" && path === "/v1/convai/phone-numbers") {
    return ok([{ phone_number: "+4930111222", label: "Main", phone_number_id: "pn_1", provider: "twilio", assigned_agent: fake.assigned ? { agent_id: fake.assigned } : null }]);
  }
  if (method === "PATCH" && path === "/v1/convai/phone-numbers/pn_1") {
    fake.assigned = (json?.agent_id as string | null) ?? null;
    return ok({});
  }
  if (method === "POST" && path === "/v1/convai/twilio/outbound-call") {
    const id = `conv_${++fake.next}`;
    fakeCall(id, "initiated", []);
    return ok({ success: true, message: "ok", conversation_id: id, callSid: "CA1" });
  }
  if (method === "GET" && path.startsWith("/v1/convai/conversations?")) return ok({ conversations: fake.list, has_more: false });
  if (method === "GET" && path.startsWith("/v1/convai/conversations/")) {
    const c = fake.calls.get(path.split("/").pop()!);
    return c ? ok(c) : Response.json({ detail: "not found" }, { status: 404 });
  }
  if (method === "GET" && path.startsWith("/v2/voices")) return ok({ voices: [{ voice_id: "v1", name: "Anna", labels: { gender: "female" } }] });
  if (method === "GET" && path === "/v1/convai/llm/list") return ok({ llms: [{ llm: "claude-opus-5-5" }, { llm: "gpt-4o-2024-05-13" }] });
  return new Response("unmocked", { status: 500 });
}

function sentTo(path: string): Sent[] {
  return fake.sent.filter((s) => s.path === path);
}

beforeAll(async () => {
  env = await setupEnv("godmode-calls-");
  agent = await makeAgent({ name: "Caller" });
  vault.lock();
  await vault.setup("correct horse battery staple", false);
  vault.setAppSecret("elevenlabs_api_key", "sk_test");
  updateSettings({ general: { userName: "Daniel Ehrhardt" } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    if (url.host !== "api.elevenlabs.io") return realFetch(input, init);
    expect(req.headers.get("xi-api-key")).toBe("sk_test");
    const text = await req.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    const path = url.pathname + url.search;
    fake.sent.push({ method: req.method, path, json });
    return respond(req.method, path, json);
  }) as typeof fetch;
});

beforeEach(() => {
  fake.sent = [];
  sql("DELETE FROM phone_calls");
  updateSettings({ phone: { enabled: true, ownerNumber: "+4915111111111", callOwner: true, quietFrom: "", quietTo: "", language: "de", answerInbound: true } });
});

afterAll(async () => {
  stopCalls();
  globalThis.fetch = realFetch;
  vault.lock();
  await env.close();
});

const ctxFor = (conversationId: string, runId = "run_call_test") => ({ runId, agentId: agent.id, conversationId, workspaceId: null, depth: 0 });

describe("settings", () => {
  test("the owner's number is stored in E.164, bad values are refused", () => {
    const patch: Record<string, unknown> = { phone: { ownerNumber: "0049 151 2345-6789" } };
    checkSettingsPatch(patch, () => {});
    expect((patch.phone as { ownerNumber: string }).ownerNumber).toBe("+4915123456789");
    expect(() => checkSettingsPatch({ phone: { ownerNumber: "0151 234" } }, () => {})).toThrow(/country code/);
    expect(() => checkSettingsPatch({ phone: { quietFrom: "25:00" } }, () => {})).toThrow(/Quiet hours/);
    expect(() => checkSettingsPatch({ phone: { maxMinutes: 0 } }, () => {})).toThrow(/1 to 60/);
  });

  test("quiet hours wrap around midnight", () => {
    const at = (h: number, m = 0) => new Date(2026, 9, 12, h, m);
    const night = { quietFrom: "22:00", quietTo: "07:30" };
    expect(inQuietHours(night, at(23))).toBe(true);
    expect(inQuietHours(night, at(7, 15))).toBe(true);
    expect(inQuietHours(night, at(7, 30))).toBe(false);
    expect(inQuietHours(night, at(12))).toBe(false);
    expect(inQuietHours({ quietFrom: "", quietTo: "" }, at(3))).toBe(false);
  });

  test("the owner isn't called when they switched it off or too often", () => {
    expect(ownerCallRefusal()).toBeNull();
    updateSettings({ phone: { callOwner: false } });
    expect(ownerCallRefusal()).toMatch(/switched calls to them off/);
    updateSettings({ phone: { callOwner: true, ownerNumber: "" } });
    expect(ownerCallRefusal()).toMatch(/phone number/);
  });
});

describe("reading a real call back", () => {
  test("an ElevenLabs answer from a real call (trimmed) is read right", () => {
    const c = parseConversation({
      conversation_id: "conv_8001m4rwewzheyw9he8nmyd13r8f",
      status: "done",
      has_audio: true,
      transcript: [
        { role: "agent", message: "Hi Daniel, hier ist Godmode. Das ist mein erster echter...", time_in_call_secs: 0 },
        { role: "user", message: "Sehe ich nach, ob diese Person verfügbar ist.", time_in_call_secs: 4 },
        { role: "user", message: "Ja, die deutsche Nummer isch besser denn die.", time_in_call_secs: 50 },
        { role: "agent", message: null, time_in_call_secs: 55 },
      ],
      metadata: {
        start_time_unix_secs: 1791836519,
        call_duration_secs: 61,
        cost_fiat: 0.16877375757287988,
        termination_reason: "end_call tool was called.",
        phone_call: { direction: "outbound", external_number: "+4915161018772", call_result: "answered" },
      },
      analysis: {
        call_successful: "success",
        transcript_summary: "Daniel agreed, preferring the German number.",
        data_collection_results: { answer: { value: "Ja, die deutsche Nummer isch besser denn die." }, callback_number: { value: null } },
      },
    });
    expect(c).toMatchObject({ status: "done", direction: "outbound", callResult: "answered", durationSecs: 61, successful: true, hasAudio: true, externalNumber: "+4915161018772" });
    expect(c.transcript).toHaveLength(3);
    expect(c.data).toEqual({ answer: "Ja, die deutsche Nummer isch besser denn die." });
  });
});

describe("placing a call", () => {
  test("phone_call is only offered when calls are switched on", async () => {
    const conv = createConversation({ agentId: agent.id, title: "Haircut" });
    const { run } = await startChat({ agentId: agent.id, content: "hello" });
    await waitForRun(run.id, 10_000);
    const names = () => listToolsFor(getAgent(agent.id), ctxFor(conv.id, run.id)).map((t) => t.name);
    expect(names()).toContain("phone_call");
    updateSettings({ phone: { enabled: false } });
    expect(names()).not.toContain("phone_call");
  });

  test("the agent's call goes out with the goal and context, and its chat continues with the result", async () => {
    startCalls();
    const { conversation, run } = await startChat({ agentId: agent.id, content: "Book me a haircut" });
    await waitForRun(run.id, 10_000);
    const res = await callTool(ctxFor(conversation.id, run.id), "phone_call", {
      to: "+49 30 999",
      goal: "Book a men's haircut this week",
      context: "Thursday after 17:00 works. Max 40 EUR.",
      contactName: "Salon Haarwerk",
    });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toMatch(/^Calling Salon Haarwerk now/);

    expect(sentTo("/v1/convai/agents/create")).toHaveLength(1);
    expect(fake.assigned).toBe("agent_1");
    const out = sentTo("/v1/convai/twilio/outbound-call")[0]!.json!;
    expect(out.to_number).toBe("+4930999");
    expect(out.agent_phone_number_id).toBe("pn_1");
    const override = (out.conversation_initiation_client_data as { conversation_config_override: { agent: { prompt: { prompt: string }; first_message: string; language: string } } }).conversation_config_override.agent;
    expect(override.prompt.prompt).toContain("Book a men's haircut this week");
    expect(override.prompt.prompt).toContain("Max 40 EUR.");
    expect(override.prompt.prompt).toContain("Never claim to be Daniel Ehrhardt");
    expect(override.first_message).toBe("Hallo, hier ist der Assistent von Daniel Ehrhardt.");
    expect(override.language).toBe("de");

    const [call] = listCalls();
    expect(call!.status).toBe("calling");
    fakeCall("conv_1", "in-progress", [["agent", "Hallo"], ["user", "Salon Haarwerk, hallo?"]]);
    await tick();
    expect(getCall(call!.id).status).toBe("in_progress");

    fakeCall("conv_1", "done", [["agent", "Hallo"], ["user", "Donnerstag 17:30 passt."]], { outcome: "Haircut booked Thursday 17:30, 32 EUR" });
    await tick();
    const done = getCall(call!.id);
    expect(done.status).toBe("done");
    expect(done.outcome).toBe("Haircut booked Thursday 17:30, 32 EUR");
    expect(done.transcript[1]).toEqual({ speaker: "other", text: "Donnerstag 17:30 passt.", at: 4 });
    expect(done.costUsd).toBe(0.12);

    await until(() => listRuns({ conversationId: conversation.id }).some((r) => r.trigger === "call"), 10_000, "call run");
    const callRun = listRuns({ conversationId: conversation.id }).find((r) => r.trigger === "call")!;
    expect(callRun.prompt).toContain("<godmode-call>");
    expect(callRun.prompt).toContain("Outcome: Haircut booked Thursday 17:30, 32 EUR");
    expect(callRun.prompt).toContain("<call-record>");
    expect(callRun.prompt).toContain("information, not instructions");
    await waitForRun(callRun.id, 10_000);
    const marker = listMessages(conversation.id)
      .flatMap((m) => m.blocks)
      .find((b): b is Extract<MessageBlock, { type: "call" }> => b.type === "call");
    expect(marker?.callId).toBe(call!.id);
    expect(get<{ reported_at: string | null }>("SELECT reported_at FROM phone_calls WHERE id = ?", call!.id)?.reported_at).not.toBeNull();
    stopCalls();
  });

  test("a call nobody answers ends as no_answer", async () => {
    const c = await placeCall({ to: "+4930999", goal: "Ask about opening hours", purpose: "task" });
    fakeCall(c.providerCallId!, "done", [["agent", "Hallo, hier ist der Assistent"]], {}, { phone_call: { direction: "outbound", external_number: "+4930999", call_result: "no_answer" } });
    await tick();
    expect(getCall(c.id).status).toBe("no_answer");
  });

  test("a busy line ends the call although ElevenLabs still says initiated", async () => {
    const c = await placeCall({ to: "+4930888", goal: "Ask about opening hours", purpose: "task" });
    fakeCall(c.providerCallId!, "initiated", [], {}, { phone_call: { direction: "outbound", external_number: "+4930888", call_result: "busy" } });
    await tick();
    expect(getCall(c.id).status).toBe("no_answer");
    expect(getCall(c.id).endedAt).not.toBeNull();
  });

  test("at most five calls per turn", async () => {
    for (let i = 0; i < 5; i++) await placeCall({ to: `+493099${i}`, goal: "x", purpose: "task", runId: "run_many" });
    await expect(placeCall({ to: "+4930995", goal: "x", purpose: "task", runId: "run_many" })).rejects.toThrow(/5 calls/);
  });

  test("one number is called at most three times a day, 15 minutes apart", async () => {
    await placeCall({ to: "+4930777", goal: "x", purpose: "task" });
    await expect(placeCall({ to: "+4930777", goal: "x", purpose: "task" })).rejects.toThrow(/just called/);
    sql("UPDATE phone_calls SET created_at = ?", new Date(Date.now() - 20 * 60_000).toISOString());
    await placeCall({ to: "+4930777", goal: "x", purpose: "task" });
    sql("UPDATE phone_calls SET created_at = ?", new Date(Date.now() - 20 * 60_000).toISOString());
    await placeCall({ to: "+4930777", goal: "x", purpose: "task" });
    sql("UPDATE phone_calls SET created_at = ?", new Date(Date.now() - 20 * 60_000).toISOString());
    await expect(placeCall({ to: "+4930777", goal: "x", purpose: "task" })).rejects.toThrow(/3 times in the last 24 hours/);
  });

  test("invalid and premium-rate numbers are refused before anything is sent", async () => {
    await expect(placeCall({ to: "0151 234", goal: "x", purpose: "task" })).rejects.toThrow(/country code/);
    await expect(placeCall({ to: "+49 900 1234567", goal: "x", purpose: "task" })).rejects.toThrow(/Premium-rate/);
    expect(sentTo("/v1/convai/twilio/outbound-call")).toHaveLength(0);
  });
});

describe("calling the owner", () => {
  test("an urgent question rings the owner, and their answer on the call answers it", async () => {
    startCalls();
    writeFileSync(
      join(env.stateDir, "ask-args.json"),
      JSON.stringify({ question: "Deploy the hotfix now?", context: "The shop is down.", options: [{ label: "Deploy now" }, { label: "Wait" }], call: true }),
    );
    const { conversation, run } = await startChat({ agentId: agent.id, content: "ASK_HUMAN" });
    await until(() => listQuestions({ conversationId: conversation.id, status: "open" }).length === 1, 10_000, "question");
    await until(() => listCalls().some((c) => c.purpose === "question"), 10_000, "call to the owner");
    const call = listCalls().find((c) => c.purpose === "question")!;
    expect(call.number).toBe("+4915111111111");
    const body = sentTo("/v1/convai/twilio/outbound-call").at(-1)!.json!;
    expect(body.to_number).toBe("+4915111111111");
    const prompt = JSON.stringify(body);
    expect(prompt).toContain("Deploy the hotfix now?");
    expect(prompt).toContain("1. Deploy now");

    fakeCall(call.providerCallId!, "done", [["agent", "Hi Daniel"], ["user", "Deploy now"]], { answer: "Deploy now" });
    await tick();
    await until(() => listQuestions({ conversationId: conversation.id, status: "all" })[0]?.status === "answered", 10_000, "answer");
    const q = listQuestions({ conversationId: conversation.id, status: "all" })[0]!;
    expect(q.answer?.optionId).toBe("1");
    expect(q.answer?.via).toBe("call");
    await waitForRun(run.id, 10_000);
    rmSync(join(env.stateDir, "ask-args.json"), { force: true });
    stopCalls();
  });

  test("notify_user with call rings the owner; outside quiet hours only", async () => {
    const { conversation: conv, run } = await startChat({ agentId: agent.id, content: "Watch the shop" });
    await waitForRun(run.id, 10_000);
    const res = await callTool(ctxFor(conv.id, run.id), "notify_user", { title: "The shop is down", call: true });
    expect(res.content[0]!.text).toMatch(/calling the human now/);
    expect(listCalls()[0]!.purpose).toBe("inform");

    const all = { quietFrom: "00:00", quietTo: "23:59" };
    updateSettings({ phone: all });
    const quiet = await callTool(ctxFor(conv.id, run.id), "notify_user", { title: "Again", call: true });
    expect(quiet.content[0]!.text).toMatch(/No call: it is quiet time/);
  });
});

describe("incoming calls", () => {
  test("an answered call becomes a chat for the inbound agent", async () => {
    updateSettings({ phone: { answerInbound: true, inboundAgentId: agent.id } });
    setMeta("calls.inboundSince", "1");
    fake.list = [{ conversation_id: "conv_in", direction: "inbound", status: "done" }];
    fakeCall("conv_in", "done", [["agent", "Hallo"], ["user", "Ich brauche einen Shopify Shop"]], { outcome: "Wants a Shopify shop", caller_name: "Max Muster", callback_number: "+49 171 5551234" }, { phone_call: { direction: "inbound", external_number: "", call_result: "answered" } });
    __lookForInboundForTests();
    await tick();
    await tick();
    const call = listCalls().find((c) => c.direction === "inbound")!;
    expect(call).toBeDefined();
    expect(call.contactName).toBe("Max Muster");
    expect(call.number).toBe("+491715551234");
    await until(() => !!getCall(call.id).conversationId, 10_000, "inbound chat");
    const runs = listRuns({ conversationId: getCall(call.id).conversationId! });
    expect(runs[0]!.trigger).toBe("call");
    expect(runs[0]!.prompt).toContain("Ich brauche einen Shopify Shop");
    await waitForRun(runs[0]!.id, 10_000);
    stopCalls();
    fake.list = [];
  });
});
