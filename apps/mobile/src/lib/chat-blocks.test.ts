import { describe, expect, test } from "bun:test";
import type { MessageBlock } from "@godmode/shared";
import { agentAnswerOf, appHref, cardKindOf, delegationOf, formatIban, handoffChatOf, parsePayment, quoteOf, tableCsv, tableMarkdown } from "./chat-blocks";

type ToolUse = Extract<MessageBlock, { type: "tool_use" }>;
const tool = (name: string, result?: string, isError?: boolean): ToolUse => ({ type: "tool_use", id: "t1", name, input: {}, result, isError });

describe("chat blocks", () => {
  test("cards for their tools only", () => {
    expect(cardKindOf("mcp__godmode__agent_delegate")).toBe("delegate");
    expect(cardKindOf("mcp__godmode__chat_handoff")).toBe("handoff");
    expect(cardKindOf("mcp__godmode__artifact_update")).toBe("artifact");
    expect(cardKindOf("mcp__godmode__report_missing_login")).toBe("missing-login");
    expect(cardKindOf("Workflow")).toBe("workflow");
    expect(cardKindOf("mcp__other__Workflow")).toBeNull();
    expect(cardKindOf("Bash")).toBeNull();
    expect(cardKindOf("Task")).toBeNull();
  });

  test("the chat a handoff opened, never on an error", () => {
    expect(handoffChatOf(tool("chat_handoff", 'The work goes on in the new chat "X" (cnv_abc123), which started.'))).toBe("cnv_abc123");
    expect(handoffChatOf(tool("chat_handoff", "(cnv_abc123)", true))).toBeNull();
    expect(handoffChatOf(tool("chat_handoff"))).toBeNull();
  });

  test("the run a delegation started, and the answer inside Godmode's note", () => {
    expect(delegationOf("Delegated to Scout (run run_x8e, conversation cnv_9ms). Check it later.")).toEqual({ runId: "run_x8e", conversationId: "cnv_9ms" });
    expect(delegationOf("Agent agt_1 is not one of your peers")).toBeNull();
    const result = 'Scout finished the task (run run_1, conversation cnv_1). Its answer is in the tags.\n\n<agent-answer id="n1">\nThree **products**.\n</agent-answer id="n1">';
    expect(agentAnswerOf(result)).toBe("Three **products**.");
    expect(agentAnswerOf("plain")).toBe("plain");
  });

  test("links to Godmode's pages open the phone's screens", () => {
    expect(appHref("/chat/cnv_1")).toEqual({ pathname: "/chat/[id]", params: { id: "cnv_1" } });
    expect(appHref("/tasks?task=tsk_1")).toEqual({ pathname: "/task/[id]", params: { id: "tsk_1" } });
    expect(appHref("/tasks")).toBe("/tasks");
    expect(appHref("/agents/agt_1/memory")).toEqual({ pathname: "/agent/[id]", params: { id: "agt_1" } });
    expect(appHref("/agents/new")).toBe("/agents");
    expect(appHref("/artifacts/art_1")).toEqual({ pathname: "/artifact/[id]", params: { id: "art_1" } });
    expect(appHref("/my-tasks?task=ht_1")).toEqual({ pathname: "/human-task/[id]", params: { id: "ht_1" } });
    expect(appHref("/calls?call=call_1")).toEqual({ pathname: "/call/[id]", params: { id: "call_1" } });
    expect(appHref("/inbox")).toBe("/inbox");
    expect(appHref("/routines")).toBe("/automations");
    expect(appHref("/chat/cnv%201")).toEqual({ pathname: "/chat/[id]", params: { id: "cnv 1" } });
    expect(appHref("/vault/logins")).toBeNull();
    expect(appHref("/settings")).toBeNull();
    expect(appHref("//evil.example/chat/1")).toBeNull();
    expect(appHref("https://example.com/chat/1")).toBeNull();
  });

  test("a quote of every line", () => {
    expect(quoteOf("One\n\nTwo  \n")).toBe("> One\n>\n> Two\n\n");
  });

  test("tables as Markdown and CSV", () => {
    const rows = [["Name", "Price"], ["Pipe | fitting", "1,50 €"], ['Say "hi"', "2"]];
    expect(tableMarkdown(rows, [null, "right"])).toBe("| Name | Price |\n| --- | ---: |\n| Pipe \\| fitting | 1,50 € |\n| Say \"hi\" | 2 |");
    expect(tableCsv(rows)).toBe('Name,Price\nPipe | fitting,"1,50 €"\n"Say ""hi""",2');
  });

  test("payments are checked like the desktop's", () => {
    const ok = parsePayment("Empfänger: Bäckerei Maier\nIBAN: DE89 3704 0044 0532 0130 00\nBetrag: 1.234,50\nVerwendungszweck: Invoice 42");
    expect(ok).toEqual({ ok: true, payment: { name: "Bäckerei Maier", iban: "DE89370400440532013000", bic: "", amount: 1234.5, purpose: "Invoice 42", reference: "" } });
    expect(parsePayment("Name: X\nIBAN: DE00 0000")).toEqual({ ok: false, error: "iban" });
    expect(parsePayment("IBAN: DE89370400440532013000")).toEqual({ ok: false, error: "name" });
    expect(parsePayment("Name: X\nIBAN: DE89370400440532013000\nAmount: abc")).toEqual({ ok: false, error: "amount" });
    expect(formatIban("de89370400440532013000")).toBe("DE89 3704 0044 0532 0130 00");
  });
});
