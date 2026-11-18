import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { claudeHistoryReader, codexHistoryReader, grokHistoryReader } from "../compact-readers";

function transcript(name: string, rows: readonly unknown[]): string {
    const dir = mkdtempSync(join(tmpdir(), "gt-analysis-"));
    const path = join(dir, name);
    writeFileSync(path, `${rows.map((row) => SafeJSON.stringify(row)).join("\n")}\n`);
    return path;
}

test("resumes join a workflow revival, time streamed calls, and distinguish waits and cache outcomes", async () => {
    const path = transcript("lead.jsonl", []);
    const agents = join(path, "..", "lead", "subagents");
    const run = join(agents, "workflows", "wf-first");
    mkdirSync(run, { recursive: true });
    const at = (minute: number) => new Date(Date.UTC(2025, 0, 1) + minute * 60_000).toISOString();
    const call = (
        id: string,
        minute: number,
        read: number,
        five: number,
        hour: number,
        stop: string,
        model = "model-a"
    ) => ({
        type: "assistant",
        timestamp: at(minute),
        message: {
            id,
            model,
            stop_reason: stop,
            usage: {
                cache_read_input_tokens: read,
                cache_creation: { ephemeral_5m_input_tokens: five, ephemeral_1h_input_tokens: hour },
            },
        },
    });
    const user = (minute: number, content: unknown) => ({ type: "user", timestamp: at(minute), message: { content } });
    const original = [user(0, "go"), call("one", 1, 0, 100, 0, ""), call("one", 2, 0, 100, 0, "end_turn")];
    const revived = [
        user(8, "again"),
        call("two", 9, 10, 0, 95, "tool_use"),
        user(10, [{ type: "tool_result" }]),
        call("three", 11, 95, 5, 5, "end_turn"),
        { type: "system", subtype: "compact_boundary" },
        user(18, "<task-notification>ready"),
        call("four", 19, 55, 120, 0, "end_turn", "model-b"),
    ];
    writeFileSync(join(run, "agent-a.jsonl"), original.map((r) => SafeJSON.stringify(r)).join("\n"));
    writeFileSync(join(agents, "agent-a.jsonl"), revived.map((r) => SafeJSON.stringify(r)).join("\n"));
    const facts = await claudeHistoryReader.analysis.resumes(path, { main: false });
    if (!facts.supported) {
        throw new Error(facts.reason);
    }
    expect(facts.items).toHaveLength(1);
    const [loop] = facts.items;
    expect(loop.kind).toBe("workflow");
    expect(loop.calls.map((c) => c.writeTtl)).toEqual(["5m", "1h", "mixed", "5m"]);
    expect(loop.calls[0]).toMatchObject({ start: at(0), end: at(2), stop: "end_turn" });
    expect(loop.pauses).toMatchObject([
        {
            resumed: true,
            cause: "message",
            gapMs: 360_000,
            outcome: "miss",
            expected: 100,
            rewrittenTokens: 90,
            writeTtl: "5m",
        },
        { resumed: false, cause: "tool", outcome: "hit", writeTtl: "1h" },
        {
            resumed: true,
            cause: "notification",
            outcome: "partial",
            compacted: true,
            modelChanged: true,
            writeTtl: "mixed",
        },
    ]);
    expect(claudeHistoryReader.analysis.lastContext(revived)).toBe(175);
    expect(
        claudeHistoryReader.analysis.lastContext([
            ...revived,
            { type: "system", subtype: "compact_boundary", compactMetadata: { postTokens: 12 } },
        ])
    ).toBe(12);
    for (const reader of [codexHistoryReader, grokHistoryReader]) {
        expect(await reader.analysis.resumes(path)).toMatchObject({ supported: false, reason: expect.any(String) });
    }
});

describe("the analysis members of the three readers", () => {
    test("context items keep physical lines, exclude hook receipts, and stop carrying at compaction", async () => {
        const at = "2025-01-01T00:00:00Z";
        const assistant = (id: string, read: number, content: unknown[]) => ({
            type: "assistant",
            timestamp: at,
            message: {
                id,
                model: "model",
                usage: { cache_read_input_tokens: read },
                content,
            },
        });
        const area =
            "Contents of /repo/first.md (area rules):\n" +
            "a".repeat(40) +
            "\nContents of /repo/second.md (area rules):\n" +
            "b".repeat(60);
        const path = transcript("lead.jsonl", []);
        const rows = [
            {
                type: "attachment",
                attachment: { type: "instructions", files: [{ path: "/repo/rules.md", content: "a".repeat(400) }] },
            },
            { type: "user", message: { content: "a\u2028bc" } },
            assistant("one", 1000, [{ type: "tool_use", id: "t", name: "Bash", input: { command: "ls" } }]),
            assistant("one", 1000, [{ type: "text", text: "done" }]),
            {
                type: "user",
                message: {
                    content: [
                        {
                            type: "tool_result",
                            tool_use_id: "t",
                            content: [{ type: "text", text: "r".repeat(40) }, { type: "image" }],
                        },
                    ],
                },
            },
            { type: "attachment", attachment: { type: "hook_success", stdout: area } },
            {
                type: "attachment",
                attachment: { type: "hook_additional_context", hookEvent: "PostToolUse", content: [area] },
            },
            assistant("two", 2000, []),
            { type: "system", subtype: "compact_boundary", uuid: "boundary" },
            { type: "system", subtype: "compact_boundary", uuid: "boundary" },
            { type: "user", isCompactSummary: true, message: { content: "summary!" } },
            assistant("three", 50, []),
        ];
        writeFileSync(path, "\n" + rows.map((row) => SafeJSON.stringify(row)).join("\n"));
        const agents = join(path, "..", "lead", "subagents");
        mkdirSync(agents, { recursive: true });
        writeFileSync(
            join(agents, "agent-mate.meta.json"),
            SafeJSON.stringify({ teamName: "blue", agentType: "reviewer" })
        );
        writeFileSync(join(agents, "agent-mate.jsonl"), SafeJSON.stringify(assistant("mate", 222, [])));
        const facts = await claudeHistoryReader.analysis.contextItems(path);
        if (!facts.supported) {
            throw new Error(facts.reason);
        }
        const [main, mate] = facts.items;
        expect(main).toMatchObject({
            calls: 3,
            firstCallContext: 1000,
            peakContext: 2000,
            cacheRead: 3050,
            toolCalls: { Bash: 1 },
            compactions: 1,
        });
        expect(mate).toMatchObject({
            kind: "teammate",
            teamName: "blue",
            agentType: "reviewer",
            calls: 1,
            firstCallContext: 222,
        });
        expect(main.items[0]).toMatchObject({ source: "system-prompt+tools", line: 0, tokens: 899, carryCalls: 2 });
        expect(main.items.filter((i) => i.source === "tool_result")).toMatchObject([
            { line: 6, path, key: "Bash", tokens: 10, carryCalls: 1 },
            { line: 6, key: "Bash (images)", tokens: 2000, carryCalls: 1 },
        ]);
        expect(main.items.filter((i) => i.source === "hook").map((i) => i.key)).toEqual([
            "area-rules:first.md (PostToolUse)",
            "area-rules:second.md (PostToolUse)",
        ]);
        expect(main.items.some((i) => i.source === "hook_success")).toBe(false);
        expect(main.items.find((i) => i.source === "compact-summary")).toMatchObject({
            line: 12,
            carryCalls: 1,
            tokens: 2,
        });
        for (const reader of [codexHistoryReader, grokHistoryReader]) {
            expect(await reader.analysis.contextItems(path)).toMatchObject({
                supported: false,
                reason: expect.any(String),
            });
        }
    });
    test("Claude: one call per message id, synthetic notices skipped, a compact boundary, no quota readings", async () => {
        const usage = {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 900,
            cache_creation_input_tokens: 0,
        };
        const path = transcript("s1.jsonl", [
            { type: "user", timestamp: "2026-11-01T10:00:00Z", message: { content: "hi" } },
            { type: "assistant", timestamp: "2026-11-01T10:00:05Z", message: { id: "m1", model: "m-a", usage } },
            { type: "assistant", timestamp: "2026-11-01T10:00:06Z", message: { id: "m1", model: "m-a", usage } },
            { type: "assistant", timestamp: "2026-11-01T10:00:07Z", message: { id: "x", model: "<synthetic>", usage } },
            {
                type: "system",
                subtype: "compact_boundary",
                timestamp: "2026-11-01T10:30:00Z",
                compactMetadata: { trigger: "auto", preTokens: 160_000 },
            },
            {
                type: "assistant",
                isSidechain: true,
                timestamp: "2026-11-01T10:31:00Z",
                message: { id: "m2", model: "m-a", usage: { ...usage, cache_creation_input_tokens: 40_000 } },
            },
        ]);

        const calls = await claudeHistoryReader.analysis.callTrace(path);
        const compactions = await claudeHistoryReader.analysis.compactions(path);
        const quota = await claudeHistoryReader.analysis.quotaReadings(path);

        expect(calls.supported && calls.items.map((call) => [call.id, call.cacheWrite, call.sidechain])).toEqual([
            ["m1", 0, false],
            ["m2", 40_000, true],
        ]);
        expect(compactions).toEqual({
            supported: true,
            items: [{ t: "2026-11-01T10:30:00.000Z", trigger: "auto", preTokens: 160_000 }],
        });
        expect(quota.supported).toBe(false);
    });

    test("Codex: token_count calls, a compacted item and each change of a rate_limits reading", async () => {
        const limits = (used: number) => ({
            primary: { used_percent: used, window_minutes: 10_080, resets_at: 1_793_802_282 },
            secondary: null,
        });
        const count = (t: string, total: number, used: number) => ({
            timestamp: t,
            type: "event_msg",
            payload: {
                type: "token_count",
                info: {
                    total_token_usage: { input_tokens: total, cached_input_tokens: total / 2, output_tokens: 10 },
                    last_token_usage: { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 10 },
                },
                rate_limits: limits(used),
            },
        });
        const path = transcript("rollout-2026-11-01T10-00-00-thread.jsonl", [
            { timestamp: "2026-11-01T10:00:00Z", type: "turn_context", payload: { model: "m-codex" } },
            count("2026-11-01T10:00:10Z", 1000, 18),
            count("2026-11-01T10:00:20Z", 2000, 18),
            { timestamp: "2026-11-01T10:05:00Z", type: "compacted", payload: { message: "" } },
            count("2026-11-01T10:06:00Z", 3000, 19),
        ]);

        const calls = await codexHistoryReader.analysis.callTrace(path);
        const compactions = await codexHistoryReader.analysis.compactions(path);
        const quota = await codexHistoryReader.analysis.quotaReadings(path);

        expect(calls.supported && calls.items.map((call) => [call.model, call.input, call.cacheRead])).toEqual([
            ["m-codex", 500, 500],
            ["m-codex", 500, 500],
            ["m-codex", 500, 500],
        ]);
        expect(compactions.supported && compactions.items.map((item) => item.t)).toEqual(["2026-11-01T10:05:00.000Z"]);
        expect(quota.supported && quota.items.map((item) => [item.slot, item.usedPercent, item.windowMinutes])).toEqual(
            [
                ["primary", 18, 10_080],
                ["primary", 19, 10_080],
            ]
        );
    });

    test("Codex: with both slots filled, a repeated reading is kept once per slot", async () => {
        const count = (t: string, primary: number, secondary: number) => ({
            timestamp: t,
            type: "event_msg",
            payload: {
                type: "token_count",
                rate_limits: {
                    primary: { used_percent: primary, window_minutes: 300, resets_at: 1_793_802_282 },
                    secondary: { used_percent: secondary, window_minutes: 10_080, resets_at: 1_794_000_000 },
                },
            },
        });
        const path = transcript("rollout-2026-11-01T11-00-00-both.jsonl", [
            count("2026-11-01T11:00:10Z", 5, 40),
            count("2026-11-01T11:00:20Z", 5, 40),
            count("2026-11-01T11:00:30Z", 6, 40),
        ]);

        const quota = await codexHistoryReader.analysis.quotaReadings(path);

        expect(quota.supported && quota.items.map((item) => [item.slot, item.usedPercent])).toEqual([
            ["primary", 5],
            ["secondary", 40],
            ["primary", 6],
        ]);
    });

    test("Claude: a row with an unreadable timestamp is skipped, the rest of the trace stays", async () => {
        const usage = {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
        };
        const path = transcript("bad-time.jsonl", [
            { type: "assistant", timestamp: "not a time", message: { id: "m0", model: "m-a", usage } },
            { type: "assistant", timestamp: "2026-11-01T10:00:05Z", message: { id: "m1", model: "m-a", usage } },
        ]);

        const calls = await claudeHistoryReader.analysis.callTrace(path);

        expect(calls.supported && calls.items.map((call) => call.id)).toEqual(["m1"]);
    });

    test("a transcript that cannot be read is unsupported with the reason, never an empty list", async () => {
        const missing = join(mkdtempSync(join(tmpdir(), "gt-analysis-")), "gone.jsonl");

        for (const reader of [claudeHistoryReader, codexHistoryReader, grokHistoryReader]) {
            const calls = await reader.analysis.callTrace(missing);

            expect(calls.supported).toBe(false);
            expect(calls.supported ? "" : calls.reason).toContain("could not be read");
        }

        for (const reader of [claudeHistoryReader, codexHistoryReader]) {
            expect((await reader.analysis.compactions(missing)).supported).toBe(false);
        }

        expect((await codexHistoryReader.analysis.quotaReadings(missing)).supported).toBe(false);
    });

    test("Grok: turn usage from updates.jsonl beside the chat history; no compaction times and no quota", async () => {
        const chat = transcript("chat_history.jsonl", [{ role: "user", content: "hi" }]);
        writeFileSync(
            join(chat, "..", "updates.jsonl"),
            `${SafeJSON.stringify({
                timestamp: 1_787_418_712,
                params: {
                    sessionId: "g1",
                    update: { sessionUpdate: "turn_completed", usage: { inputTokens: 10, outputTokens: 1 } },
                    _meta: { eventId: "e1", agentTimestampMs: 1_787_418_712_439 },
                },
            })}\n`
        );
        writeFileSync(join(chat, "..", "summary.json"), SafeJSON.stringify({ current_model_id: "m-grok" }));

        const calls = await grokHistoryReader.analysis.callTrace(chat);

        expect(calls.supported && calls.items.map((call) => [call.model, call.output])).toEqual([["m-grok", 1]]);
        expect((await grokHistoryReader.analysis.compactions(chat)).supported).toBe(false);
        expect((await grokHistoryReader.analysis.quotaReadings(chat)).supported).toBe(false);
    });
});
