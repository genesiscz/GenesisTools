import { expect, test } from "bun:test";
import type { EvaluationResponse, Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { SafeJSON } from "@genesiscz/utils/json";
import { detectCompactFormat, parseCompactDocument } from "./format";
import { compactSession, formatDecisionTable } from "./index";
import { pairRows, pairToolCalls } from "./pairing";
import { nativeEntriesToRows } from "./sources";
import { compactStructural, looksFailed } from "./structural";

const OPTIONS = { keep: 0.5, pin: 2, maxResult: 40, threshold: 0.1 };

function booleans(values: Record<string, number>): EvaluationResponse {
    return {
        model: "fixture",
        answers: Object.fromEntries(
            Object.entries(values).map(([id, probability]) => [id, { type: "boolean" as const, probability }])
        ),
        usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
        warnings: [],
        rounding: undefined,
        providerMetadata: undefined,
    };
}

function fixtureEvaluator(values: Record<string, number>, calls: { count: number }): Evaluator {
    return async () => {
        calls.count += 1;
        return booleans(values);
    };
}

const BIG = "hunk-".repeat(200);

const GENERIC_JSONL = [
    SafeJSON.stringify({ role: "system", content: "You are a helper." }, { jsonl: true }),
    SafeJSON.stringify({ role: "user", content: "list the files" }, { jsonl: true }),
    SafeJSON.stringify(
        { role: "assistant", content: "running ls", toolCalls: [{ id: "c1", name: "bash", input: "ls", result: BIG }] },
        { jsonl: true }
    ),
    SafeJSON.stringify({ role: "assistant", content: "file7 is largest" }, { jsonl: true }),
    SafeJSON.stringify({ role: "user", content: "thanks" }, { jsonl: true }),
].join("\n");

const BLOCKS_JSONL = [
    SafeJSON.stringify({ role: "user", content: [{ type: "text", text: "read the config" }] }, { jsonl: true }),
    SafeJSON.stringify(
        {
            role: "assistant",
            content: [
                { type: "text", text: "reading" },
                { type: "tool_use", id: "t1", name: "read", input: { path: "config.json" } },
            ],
        },
        { jsonl: true }
    ),
    SafeJSON.stringify(
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: BIG }] },
        { jsonl: true }
    ),
    SafeJSON.stringify({ role: "assistant", content: [{ type: "text", text: "done" }] }, { jsonl: true }),
    SafeJSON.stringify({ role: "user", content: [{ type: "text", text: "ok" }] }, { jsonl: true }),
].join("\n");

test("detects all four input shapes", () => {
    expect(detectCompactFormat(GENERIC_JSONL)).toBe("generic-jsonl");
    expect(detectCompactFormat(BLOCKS_JSONL)).toBe("blocks-jsonl");
    expect(detectCompactFormat(`[${GENERIC_JSONL.split("\n").join(",")}]`)).toBe("json-array");
    expect(detectCompactFormat('{"type":"user","message":{"role":"user","content":"hi"}}\n{"type":"assistant"}')).toBe(
        "native"
    );
});

test("a JSON array parses to the same messages as the JSONL it was built from", async () => {
    const array = `[${GENERIC_JSONL.split("\n").join(",")}]`;
    const fromLines = await compactSession({ text: GENERIC_JSONL, ...OPTIONS });
    const fromArray = await compactSession({ text: array, ...OPTIONS });
    expect(fromArray.format).toBe("json-array");
    expect(fromArray.lines).toEqual(fromLines.lines);
});

test("user and assistant text survives compaction verbatim", async () => {
    const result = await compactSession({ text: GENERIC_JSONL, ...OPTIONS });
    const joined = result.lines.join("\n");
    expect(joined).toContain("list the files");
    expect(joined).toContain("file7 is largest");
    expect(joined).toContain("You are a helper.");
    expect(result.stats.reduction).toBeGreaterThan(0.5);
});

test("a truncated result carries the character count that was cut", async () => {
    const result = await compactSession({ text: GENERIC_JSONL, ...OPTIONS });
    expect(result.lines.join("\n")).toContain(`[${BIG.length} chars, truncated]`);
});

test("output parses back as generic JSONL", async () => {
    const result = await compactSession({ text: BLOCKS_JSONL, ...OPTIONS });
    for (const line of result.lines) {
        expect(() => SafeJSON.parse(line, { jsonl: true })).not.toThrow();
    }
});

test("below-threshold reduction returns the input unchanged", async () => {
    const text = [
        SafeJSON.stringify({ role: "user", content: "short" }, { jsonl: true }),
        SafeJSON.stringify({ role: "assistant", content: "also short" }, { jsonl: true }),
    ].join("\n");
    const result = await compactSession({ text, ...OPTIONS, threshold: 0.25 });
    expect(result.stats.unchanged).toBe(true);
    expect(result.reason).toBe("below_threshold");
    expect(result.lines.join("\n")).toContain("short");
});

test("pins protect the tail from a drop and #pin keeps a result verbatim", async () => {
    const text = [
        SafeJSON.stringify(
            { role: "assistant", content: "#pin keep this", toolCalls: [{ id: "p1", name: "read", result: BIG }] },
            { jsonl: true }
        ),
        SafeJSON.stringify(
            { role: "assistant", content: "scratch", toolCalls: [{ id: "p2", name: "read", result: BIG }] },
            { jsonl: true }
        ),
        SafeJSON.stringify({ role: "user", content: "tail" }, { jsonl: true }),
    ].join("\n");
    const result = await compactSession({ text, ...OPTIONS, pin: 1 });
    const pinned = result.decisions.find((decision) => decision.callId === "p1");
    expect(pinned?.verdict).toBe("keep");
    expect(pinned?.reason).toBe("pinned_verbatim");
    expect(result.lines.join("\n")).toContain(BIG);
});

test("dropping a call whose result lives in another message records paired_drop", async () => {
    const result = await compactSession({ text: BLOCKS_JSONL, keep: 0.05, pin: 1, maxResult: 40, threshold: 0.1 });
    const call = result.decisions.find((decision) => decision.callId === "t1" && decision.reason !== "paired_drop");
    const paired = result.decisions.find((decision) => decision.reason === "paired_drop");
    expect(call?.verdict).toBe("drop");
    expect(paired).toBeDefined();
    expect(paired?.messageIndex).toBe(2);
    expect(result.lines.join("\n")).not.toContain("hunk-hunk");
    expect(result.messages.some((message) => message.index === 2)).toBe(false);
});

test("pairs a tool result that arrives before its tool_use", () => {
    const messages = pairRows([
        { role: "tool", content: "result text", toolCallId: "c1" },
        { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "github" }] },
        { role: "user", content: "tail" },
    ]);
    const pairs = pairToolCalls(messages);
    expect(pairs.get("c1")).toEqual({ call: 1, result: 0 });
    expect(messages[1]?.toolCalls[0]?.result).toBe("result text");
});

test("keep-tokens tightens the keep ratio", async () => {
    const loose = await compactSession({ text: GENERIC_JSONL, ...OPTIONS, keep: 0.99, threshold: 0.01 });
    const tight = await compactSession({ text: GENERIC_JSONL, ...OPTIONS, keep: 0.99, threshold: 0.01, keepTokens: 8 });
    expect(tight.stats.outBytes).toBeLessThanOrEqual(loose.stats.outBytes);
});

test("native transcript entries become paired tool calls", () => {
    const messages = pairRows(
        nativeEntriesToRows([
            { line: 1, role: "user", text: "please review", paths: [], commits: [] },
            { line: 2, role: "tool", toolEvent: "call", tool: "Read", text: "Read(a.ts)", paths: [], commits: [] },
            { line: 3, role: "tool", toolEvent: "result", tool: "Read", text: BIG, paths: [], commits: [] },
            { line: 4, role: "assistant", text: "read it", paths: [], commits: [] },
        ])
    );
    const pairs = pairToolCalls(messages);
    expect(pairs.get("n1")).toEqual({ call: 1, result: 2 });
    expect(messages[1]?.toolCalls[0]?.result).toBe(BIG);
});

test("layer 2 applies Jev's drop to the output messages, not only to the report", async () => {
    const calls = { count: 0 };
    const result = await compactSession({
        text: GENERIC_JSONL,
        ...OPTIONS,
        llm: true,
        evaluate: fixtureEvaluator({ keep_call_0: 0.02, keep_result_0: 0.02, summarizable_0: 0.02 }, calls),
    });
    const decision = result.decisions.find((item) => item.callId === "c1");
    expect(decision?.verdict).toBe("drop");
    expect(decision?.reason).toBe("jev");
    expect(decision?.layer).toBe(2);
    expect(result.lines.join("\n")).not.toContain("hunk-");
    expect(result.lines.join("\n")).toContain("list the files");
    expect(result.layer2).toMatchObject({ used: true, jevRequests: 1 });
    expect(calls.count).toBe(1);
});

test("layer 2 keeps a full result when Jev says the result is needed verbatim", async () => {
    const calls = { count: 0 };
    const result = await compactSession({
        text: GENERIC_JSONL,
        ...OPTIONS,
        threshold: 0,
        llm: true,
        evaluate: fixtureEvaluator({ keep_call_0: 0.99, keep_result_0: 0.99, summarizable_0: 0.02 }, calls),
    });
    expect(result.decisions.find((item) => item.callId === "c1")?.verdict).toBe("keep");
    expect(result.lines.join("\n")).toContain(BIG);
});

test("an uncertain Jev answer leaves the layer-1 verdict in place", async () => {
    const calls = { count: 0 };
    const result = await compactSession({
        text: GENERIC_JSONL,
        ...OPTIONS,
        llm: true,
        evaluate: fixtureEvaluator({ keep_call_0: 0.5, keep_result_0: 0.5, summarizable_0: 0.5 }, calls),
    });
    const decision = result.decisions.find((item) => item.callId === "c1");
    expect(decision?.verdict).toBe("truncate");
    expect(decision?.layer).toBe(1);
});

test("an accepted summary replaces the truncated head and is marked", async () => {
    const calls = { count: 0 };
    const evaluate: Evaluator = async (options) => {
        calls.count += 1;
        const input = options.input as { questions: Record<string, unknown> };
        const faithful = Object.keys(input.questions).some((id) => id.startsWith("faithful_"));
        return booleans(
            faithful ? { faithful_0: 0.97 } : { keep_call_0: 0.99, keep_result_0: 0.02, summarizable_0: 0.99 }
        );
    };
    const result = await compactSession({
        text: GENERIC_JSONL,
        ...OPTIONS,
        llm: true,
        summaries: true,
        evaluate,
        summarize: async () => "the directory holds eight files, file7 is the largest",
    });
    expect(result.layer2).toMatchObject({ used: true, summaries: 1, replaced: 1, discarded: 0, jevRequests: 2 });
    expect(result.lines.join("\n")).toContain("[summary] the directory holds eight files");
    expect(result.lines.join("\n")).not.toContain("chars, truncated");
});

test("a summary that fails the faithfulness gate is discarded and the head is kept", async () => {
    const evaluate: Evaluator = async (options) => {
        const input = options.input as { questions: Record<string, unknown> };
        const faithful = Object.keys(input.questions).some((id) => id.startsWith("faithful_"));
        return booleans(
            faithful ? { faithful_0: 0.1 } : { keep_call_0: 0.99, keep_result_0: 0.02, summarizable_0: 0.99 }
        );
    };
    const result = await compactSession({
        text: GENERIC_JSONL,
        ...OPTIONS,
        llm: true,
        summaries: true,
        evaluate,
        summarize: async () => "an invented summary",
    });
    expect(result.layer2).toMatchObject({ summaries: 1, replaced: 0, discarded: 1 });
    expect(result.lines.join("\n")).not.toContain("an invented summary");
    expect(result.lines.join("\n")).toContain("chars, truncated");
});

test("the summarizer is never reached without --summaries", async () => {
    const calls = { count: 0 };
    const summarize = async () => {
        throw new Error("the summarizer must not run without --summaries");
    };
    const result = await compactSession({
        text: GENERIC_JSONL,
        ...OPTIONS,
        llm: true,
        summarize,
        evaluate: fixtureEvaluator({ keep_call_0: 0.99, keep_result_0: 0.02, summarizable_0: 0.99 }, calls),
    });
    expect(result.layer2).toMatchObject({ summaries: 0, replaced: 0 });
});

test("--llm without an evaluator fails before any work", async () => {
    await expect(compactSession({ text: GENERIC_JSONL, ...OPTIONS, llm: true })).rejects.toThrow(/needs a Jev/);
});

test("a line that is not JSON survives verbatim and is never decided on", () => {
    const messages = parseCompactDocument(`not-json\n${GENERIC_JSONL}`, "generic-jsonl");
    expect(messages[0]?.raw).toBe("not-json");
    const result = compactStructural(messages, { ...OPTIONS, threshold: 0 });
    expect(result.lines[0]).toBe("not-json");
    expect(result.decisions.some((decision) => decision.messageIndex === 0)).toBe(false);
});

test("the decision table names every call once per decision row", async () => {
    const result = await compactSession({ text: GENERIC_JSONL, ...OPTIONS });
    const table = formatDecisionTable(result);
    expect(table).toHaveLength(result.decisions.length);
    expect(table.join("\n")).toContain("bash");
});

test("a native source with no file path names the reason", async () => {
    await expect(compactSession({ text: GENERIC_JSONL, source: "claude", ...OPTIONS })).rejects.toThrow(
        /needs a file path/
    );
});

test("a clean report is not mistaken for a failure", () => {
    expect(looksFailed("src/a.ts: 0 errors, 0 warnings")).toBe(false);
    expect(looksFailed("checked 140 modules, no errors")).toBe(false);
    expect(looksFailed("TypeError: undefined is not a function")).toBe(true);
    expect(looksFailed("tests failed")).toBe(true);
    expect(looksFailed("process exited with exit code 2")).toBe(true);
});

test("the last failing tool call is hard-pinned and keeps its result verbatim", async () => {
    const text = [
        SafeJSON.stringify(
            { role: "assistant", content: "build", toolCalls: [{ id: "f1", name: "build", result: `${BIG} failed` }] },
            { jsonl: true }
        ),
        SafeJSON.stringify(
            { role: "assistant", content: "read", toolCalls: [{ id: "f2", name: "read", result: BIG }] },
            { jsonl: true }
        ),
        SafeJSON.stringify({ role: "user", content: "tail" }, { jsonl: true }),
    ].join("\n");
    const result = await compactSession({ text, ...OPTIONS, pin: 1 });
    expect(result.decisions.find((decision) => decision.callId === "f1")?.reason).toBe("pinned_verbatim");
    expect(result.decisions.find((decision) => decision.callId === "f2")?.verdict).not.toBe("keep");
});
