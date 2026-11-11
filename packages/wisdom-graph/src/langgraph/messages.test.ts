/**
 * The converters are checked against hand-built stand-ins for LangChain's
 * classes — the fields a `HumanMessage`, `AIMessage`, `ToolMessage` and
 * `SystemMessage` actually carry, and nothing the adapter should not need —
 * plus the plain `{ role, content }` objects a reducer may hold. The rules
 * that matter to recall are pinned one by one: the first discriminator
 * decides, unknown kinds vanish rather than becoming user turns, content
 * parts flatten to text, tool calls keep name and args only, and the list
 * helpers count converted messages.
 */
import { describe, expect, it } from "vitest";
import type { NeutralMessage } from "../core/types";
import { lastUserText, toNeutralMessage, toNeutralMessages, type MessageLike } from "./messages";

type Content = MessageLike["content"];
type ToolCall = { name: string; args: unknown; id?: string; type?: string };

/** What a live `HumanMessage` looks like to a structural reader. */
function human(content: Content, extra: Partial<MessageLike> = {}): MessageLike {
  return { _getType: () => "human", content, ...extra };
}
/** An `AIMessage`, tool calls included: LangChain's carry `id` and `type` the adapter must not copy. */
function ai(content: Content, tool_calls: ToolCall[] = []): MessageLike {
  return { _getType: () => "ai", content, tool_calls };
}
function tool(content: Content, name: string): MessageLike {
  return { _getType: () => "tool", content, name };
}
function system(content: Content): MessageLike {
  return { _getType: () => "system", content };
}

describe("toNeutralMessage — roles (§8.1)", () => {
  const cases: { label: string; message: MessageLike; role: NeutralMessage["role"] | null }[] = [
    { label: "HumanMessage (_getType human)", message: human("hi"), role: "user" },
    { label: "AIMessage (_getType ai)", message: ai("hello"), role: "assistant" },
    { label: "ToolMessage (_getType tool)", message: tool("42", "calculator"), role: "tool" },
    { label: "SystemMessage (_getType system)", message: system("be brief"), role: "system" },
    { label: "plain role user", message: { role: "user", content: "hi" }, role: "user" },
    { label: "plain role assistant", message: { role: "assistant", content: "hi" }, role: "assistant" },
    { label: "plain role tool", message: { role: "tool", content: "hi" }, role: "tool" },
    { label: "plain role system", message: { role: "system", content: "hi" }, role: "system" },
    { label: "serialised message (type human)", message: { type: "human", content: "hi" }, role: "user" },
    { label: "serialised message (type ai)", message: { type: "ai", content: "hi" }, role: "assistant" },
    { label: "plain role human", message: { role: "human", content: "hi" }, role: "user" },
    { label: "FunctionMessage (_getType function)", message: { _getType: () => "function", content: "x" }, role: null },
    { label: "ChatMessage (_getType generic): the first discriminator decides", message: { _getType: () => "generic", role: "user", content: "x" }, role: null },
    { label: "unknown plain role", message: { role: "narrator", content: "x" }, role: null },
    { label: "no discriminator at all", message: { content: "x" }, role: null },
    { label: "a prototype key is not a role", message: { role: "constructor", content: "x" }, role: null },
  ];

  it.each(cases)("$label → $role", ({ message, role }) => {
    const out = toNeutralMessage(message);
    if (role === null) expect(out).toBeNull();
    else expect(out?.role).toBe(role);
  });

  it("prefers _getType() over type over role, and falls through when the earlier one is absent", () => {
    expect(toNeutralMessage({ _getType: () => "ai", type: "human", role: "system", content: "x" })?.role).toBe("assistant");
    expect(toNeutralMessage({ type: "human", role: "system", content: "x" })?.role).toBe("user");
    expect(toNeutralMessage({ role: "system", content: "x" })?.role).toBe("system");
  });

  it("returns null for a hole or a non-object instead of throwing", () => {
    // Malformed on purpose: a consumer's messages array is untyped at runtime.
    expect(toNeutralMessage(undefined as unknown as MessageLike)).toBeNull();
    expect(toNeutralMessage(null as unknown as MessageLike)).toBeNull();
    expect(toNeutralMessage("hi" as unknown as MessageLike)).toBeNull();
  });
});

describe("toNeutralMessage — content", () => {
  it("keeps string content verbatim, including an empty string", () => {
    expect(toNeutralMessage(human("  keep   spacing \n and lines "))?.content).toBe("  keep   spacing \n and lines ");
    expect(toNeutralMessage(human(""))?.content).toBe("");
  });

  it("flattens a content-part array to its text parts joined by newlines and drops the rest", () => {
    const parts: Content = [
      { type: "text", text: "What is the MER on this fund?" },
      { type: "image_url", text: undefined },
      { type: "text", text: "Also compare to the index." },
    ];
    expect(toNeutralMessage(human(parts))?.content).toBe("What is the MER on this fund?\nAlso compare to the index.");
  });

  it("drops a text part without a string text, and renders an array with no text as empty", () => {
    expect(toNeutralMessage(human([{ type: "text" }, { type: "text", text: "kept" }]))?.content).toBe("kept");
    expect(toNeutralMessage(human([{ type: "image_url" }]))?.content).toBe("");
    expect(toNeutralMessage(human([]))?.content).toBe("");
  });

  it("does not read text from a part whose type is not text", () => {
    expect(toNeutralMessage(human([{ type: "reasoning", text: "hidden" }]))?.content).toBe("");
  });

  it("renders content that is neither a string nor an array as empty", () => {
    // Malformed on purpose.
    expect(toNeutralMessage({ role: "user", content: 42 as unknown as string })?.content).toBe("");
    expect(toNeutralMessage({ role: "user", content: undefined as unknown as string })?.content).toBe("");
  });
});

describe("toNeutralMessage — name and tool calls", () => {
  it("maps tool_calls to toolCalls with name and args only", () => {
    const message = ai("", [{ name: "search_kyp", args: { fund: "XYZ" }, id: "call_1", type: "tool_call" }]);
    const out = toNeutralMessage(message);
    expect(out).toEqual({ role: "assistant", content: "", toolCalls: [{ name: "search_kyp", args: { fund: "XYZ" } }] });
    expect(Object.keys(out?.toolCalls?.[0] ?? {})).toEqual(["name", "args"]);
  });

  it("omits toolCalls when there are none, and drops entries without a name", () => {
    expect("toolCalls" in (toNeutralMessage(ai("plain answer")) ?? {})).toBe(false);
    // Malformed on purpose.
    const mixed = ai("", [{ args: {} } as unknown as ToolCall, "junk" as unknown as ToolCall, { name: "ok", args: 1 }]);
    expect(toNeutralMessage(mixed)?.toolCalls).toEqual([{ name: "ok", args: 1 }]);
    expect("toolCalls" in (toNeutralMessage(ai("", [{ args: {} } as unknown as ToolCall])) ?? {})).toBe(false);
  });

  it("carries name only when it is a string", () => {
    expect(toNeutralMessage(tool("42", "calculator"))).toEqual({ role: "tool", content: "42", name: "calculator" });
    expect("name" in (toNeutralMessage(human("hi")) ?? {})).toBe(false);
    // Malformed on purpose.
    expect("name" in (toNeutralMessage({ role: "user", content: "hi", name: 7 as unknown as string }) ?? {})).toBe(false);
  });

  it("produces a plain, JSON-round-trippable value with only the neutral fields", () => {
    const out = toNeutralMessage({ _getType: () => "ai", content: "x", name: "assistant_1", tool_calls: [{ name: "t", args: null }], type: "ai", role: "assistant" });
    expect(out).toEqual({ role: "assistant", content: "x", name: "assistant_1", toolCalls: [{ name: "t", args: null }] });
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });
});

describe("toNeutralMessages (§8.1)", () => {
  const thread: MessageLike[] = [
    system("You are the assistant."),
    human("Hello"),
    { _getType: () => "function", content: "legacy" },
    ai("Hi, how can I help?"),
    human("What is the MER on fund XYZ?"),
    ai("", [{ name: "search_kyp", args: { fund: "XYZ" } }]),
    tool("MER 1.2%", "search_kyp"),
    ai("The MER is 1.2%."),
  ];

  it("converts every known message in order and skips unknown kinds", () => {
    const out = toNeutralMessages(thread);
    expect(out.map((m) => m.role)).toEqual(["system", "user", "assistant", "user", "assistant", "tool", "assistant"]);
    expect(out[3]).toEqual({ role: "user", content: "What is the MER on fund XYZ?" });
  });

  it("last: N keeps the last N converted messages", () => {
    expect(toNeutralMessages(thread, { last: 2 }).map((m) => m.content)).toEqual(["MER 1.2%", "The MER is 1.2%."]);
    expect(toNeutralMessages(thread, { last: 6 })).toHaveLength(6);
  });

  it("last counts converted messages, so an unknown kind in the window costs no turn", () => {
    const out = toNeutralMessages([human("a"), { _getType: () => "function", content: "x" }, human("b")], { last: 2 });
    expect(out.map((m) => m.content)).toEqual(["a", "b"]);
  });

  it("last beyond the length keeps everything; zero or less keeps nothing; a non-finite limit is no limit", () => {
    expect(toNeutralMessages(thread, { last: 100 })).toHaveLength(7);
    expect(toNeutralMessages(thread, { last: 0 })).toEqual([]);
    expect(toNeutralMessages(thread, { last: -3 })).toEqual([]);
    expect(toNeutralMessages(thread, { last: Number.POSITIVE_INFINITY })).toHaveLength(7);
    expect(toNeutralMessages(thread, { last: Number.NaN })).toHaveLength(7);
  });

  it("returns [] for an empty list, a list of unknowns, or a non-array", () => {
    expect(toNeutralMessages([])).toEqual([]);
    expect(toNeutralMessages([{ content: "x" }])).toEqual([]);
    // Malformed on purpose.
    expect(toNeutralMessages(undefined as unknown as MessageLike[])).toEqual([]);
  });
});

describe("lastUserText (§8.1)", () => {
  it("returns the content of the last user message, past later assistant and tool messages", () => {
    const ms = [human("first"), ai("reply"), human("second"), ai("", [{ name: "t", args: {} }]), tool("r", "t"), ai("done")];
    expect(lastUserText(ms)).toBe("second");
  });

  it("accepts plain role objects and flattens content parts", () => {
    expect(lastUserText([{ role: "user", content: "plain" }])).toBe("plain");
    expect(lastUserText([human([{ type: "text", text: "a" }, { type: "text", text: "b" }])])).toBe("a\nb");
  });

  it("returns an empty string when there is no user message, the list is empty, or it is not a list", () => {
    expect(lastUserText([system("s"), ai("a"), { _getType: () => "function", content: "x" }])).toBe("");
    expect(lastUserText([])).toBe("");
    // Malformed on purpose.
    expect(lastUserText(null as unknown as MessageLike[])).toBe("");
  });

  it("does not treat an unknown kind that carries role user as a user turn", () => {
    expect(lastUserText([{ _getType: () => "generic", role: "user", content: "x" }])).toBe("");
  });
});
