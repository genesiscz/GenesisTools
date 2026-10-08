import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { transcriptAround } from "./around";
import { transcriptEnvelope } from "./load";
import type { ResolvedTranscript } from "./resolve";
import { searchTranscript } from "./search";
import { indexedClaudeEnvelope, turnIndexFor } from "./turn-index";

let serial = 0;
const USER_LINE = '{"type":"user","uuid":"u';

/** The same file with one prompt line turned into a non-turn line of the same length. */
function breakPrompt(text: string, at: number): string {
    return `${text.slice(0, at)}{"type":"xser"${text.slice(at + '{"type":"user"'.length)}`;
}

/** Whole seconds, so a pinned mtime reads back exactly; a coarse clock could give two quick writes one mtime. */
const PINNED_MTIME = 1_700_000_000;

/** Rewrites `file` in place with the prompt of round `round` broken, and sets its mtime to `mtime` seconds. */
function rewriteRound(file: string, round: number, mtime: number): void {
    const text = readFileSync(file, "utf8");
    writeFileSync(file, breakPrompt(text, text.lastIndexOf(USER_LINE, text.indexOf(`prompt ${round} `))));
    utimesSync(file, mtime, mtime);
}
const at = () => new Date(1_700_000_000_000 + serial * 1000).toISOString();
const line = (value: unknown) => `${SafeJSON.stringify(value, { strict: true })}\n`;

function user(text: string): string {
    serial += 1;
    return line({ type: "user", uuid: `u${serial}`, timestamp: at(), message: { role: "user", content: text } });
}

function assistant(text: string, toolId?: string): string {
    serial += 1;
    const content: unknown[] = [{ type: "text", text }];
    if (toolId) {
        content.push({ type: "tool_use", id: toolId, name: "Bash", input: { command: `echo ${toolId}` } });
    }
    return line({ type: "assistant", uuid: `a${serial}`, timestamp: at(), message: { role: "assistant", content } });
}

function toolResult(toolId: string, output: string): string {
    serial += 1;
    return line({
        type: "user",
        uuid: `r${serial}`,
        timestamp: at(),
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: output }] },
    });
}

function meta(text: string): string {
    serial += 1;
    return line({
        type: "user",
        uuid: `m${serial}`,
        isMeta: true,
        timestamp: at(),
        message: { role: "user", content: text },
    });
}

/** A conversation of `rounds` exchanges: prompt, answer with a tool, its result, and a meta line. */
function conversation(rounds: number, prefix = ""): string {
    let text = "";
    for (let i = 0; i < rounds; i++) {
        const tool = `${prefix}t${i}`;
        text += user(`${prefix}prompt ${i} — žluťoučký kůň 🐴`);
        text += assistant(`${prefix}answer ${i}`, tool);
        text += toolResult(tool, `${prefix}out ${i} ✓`);
        text += meta(`${prefix}caveat ${i}`);
    }
    return text;
}

function setup(content: string): { resolved: ResolvedTranscript; dir: string; file: string } {
    const root = mkdtempSync(join(tmpdir(), "gt-turn-index-"));
    const file = join(root, "session.jsonl");
    writeFileSync(file, content);
    return {
        resolved: { provider: "claude", source: "native", sessionId: "session", filePath: file },
        dir: join(root, "index"),
        file,
    };
}

const slices = [{}, { limit: 3 }, { offset: 0, limit: 2 }, { offset: 5, limit: 4 }, { offset: 999, limit: 5 }];

async function expectSameAsFullParse(resolved: ResolvedTranscript, dir: string): Promise<void> {
    for (const slice of slices) {
        const indexed = indexedClaudeEnvelope(resolved, slice, { minBytes: 0, dir });
        const full = await transcriptEnvelope(resolved, slice);
        expect(indexed).not.toBeNull();
        expect(indexed).toEqual(full);
    }
}

describe("indexedClaudeEnvelope", () => {
    test("returns the same envelope as the full parse for every slice", async () => {
        const { resolved, dir } = setup(conversation(6));
        await expectSameAsFullParse(resolved, dir);
    });

    test("a page before the tail reads its turns and their result reach, not the rest of the file", async () => {
        // 80 turns: `{ offset: 0, limit: 2 }` and `{ offset: 5, limit: 4 }` stop well before the end.
        const { resolved, dir, file } = setup(conversation(40));
        utimesSync(file, PINNED_MTIME, PINNED_MTIME);
        await expectSameAsFullParse(resolved, dir);
        const first = indexedClaudeEnvelope(resolved, { offset: 0, limit: 2 }, { minBytes: 0, dir });

        // Break the prompt of turn 40 in place with the old mtime restored: same size, same inode,
        // same head and tail, so nothing tells the index, and only a read that reaches the line notices.
        rewriteRound(file, 20, PINNED_MTIME);

        expect(indexedClaudeEnvelope(resolved, { offset: 0, limit: 2 }, { minBytes: 0, dir })).toEqual(first);
        // Negative control: the tail page reads the broken line, and the turn count check refuses it.
        expect(indexedClaudeEnvelope(resolved, {}, { minBytes: 0, dir })).toBeNull();
    });

    test("a response split over several rows counts its usage once, as the full parse does", async () => {
        const row = (content: unknown[], output: number) => {
            serial += 1;
            return line({
                type: "assistant",
                uuid: `a${serial}`,
                timestamp: at(),
                message: {
                    id: "msg_split",
                    role: "assistant",
                    content,
                    usage: { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: output },
                },
            });
        };
        const { resolved, dir, file } = setup(user("split it") + row([{ type: "text", text: "part one" }], 5));
        appendFileSync(
            file,
            row([{ type: "tool_use", id: "split-tool", name: "Bash", input: { command: "echo" } }], 9)
        );

        const indexed = indexedClaudeEnvelope(resolved, {}, { minBytes: 0, dir });
        expect(indexed?.totals).toEqual((await transcriptEnvelope(resolved, {})).totals);
        expect(indexed?.totals?.modelCalls).toBe(1);
    });

    test("extends the index for appended lines instead of rebuilding it", async () => {
        const { resolved, dir, file } = setup(conversation(4));
        const first = turnIndexFor(file, { minBytes: 0, dir });
        const offsets = [...(first?.turnOffsets ?? [])];

        appendFileSync(file, conversation(3, "late "));
        const grown = turnIndexFor(file, { minBytes: 0, dir });
        expect(grown?.turnOffsets.slice(0, offsets.length)).toEqual(offsets);
        expect(grown?.turnOffsets.length).toBe(offsets.length + 6);
        await expectSameAsFullParse(resolved, dir);
    });

    test("rebuilds when the file was rewritten under the same name", async () => {
        const { resolved, dir, file } = setup(conversation(5));
        turnIndexFor(file, { minBytes: 0, dir });
        writeFileSync(file, conversation(2, "other "));
        await expectSameAsFullParse(resolved, dir);
    });

    test("rebuilds after a rewrite in place that keeps the head and the size", async () => {
        const { resolved, dir, file } = setup(conversation(15));
        const turns = turnIndexFor(file, { minBytes: 0, dir })?.turnOffsets.length;

        // The last prompt stops being a turn: one turn fewer, same size, same first 4 KiB.
        const text = readFileSync(file, "utf8");
        writeFileSync(file, breakPrompt(text, text.lastIndexOf(USER_LINE)));

        expect(turnIndexFor(file, { minBytes: 0, dir })?.turnOffsets.length).toBe((turns ?? 0) - 1);
        await expectSameAsFullParse(resolved, dir);
    });

    test("rebuilds after a same-size rewrite between the head and the tail it checks", async () => {
        const { resolved, dir, file } = setup(conversation(40));
        utimesSync(file, PINNED_MTIME, PINNED_MTIME);
        const turns = turnIndexFor(file, { minBytes: 0, dir })?.turnOffsets.length;

        // Turn 40 of 80 sits far from both hashed windows: only the later mtime says the file was rewritten.
        rewriteRound(file, 20, PINNED_MTIME + 1);

        expect(turnIndexFor(file, { minBytes: 0, dir })?.turnOffsets.length).toBe((turns ?? 0) - 1);
        await expectSameAsFullParse(resolved, dir);
    });

    test("rebuilds after a rewrite inside a hashed window that keeps size, mtime and inode", async () => {
        // Round 0 is in the first 4 KiB, round 14 in the last 4 KiB before the indexed end.
        for (const round of [0, 14]) {
            const { resolved, dir, file } = setup(conversation(15));
            utimesSync(file, PINNED_MTIME, PINNED_MTIME);
            const turns = turnIndexFor(file, { minBytes: 0, dir })?.turnOffsets.length;

            // The old mtime restored: the stamp says nothing changed, only the hashes can tell.
            rewriteRound(file, round, PINNED_MTIME);

            expect({ round, turns: turnIndexFor(file, { minBytes: 0, dir })?.turnOffsets.length }).toEqual({
                round,
                turns: (turns ?? 0) - 1,
            });
            await expectSameAsFullParse(resolved, dir);
        }
    });

    test("skips a half-written last line until it is complete", async () => {
        const { resolved, dir, file } = setup(conversation(3));
        const whole = assistant("finished later", "tz");
        appendFileSync(file, whole.slice(0, 25));
        await expectSameAsFullParse(resolved, dir);
        const before = turnIndexFor(file, { minBytes: 0, dir })?.turnOffsets.length;

        writeFileSync(file, readFileSync(file, "utf8") + whole.slice(25));
        expect(turnIndexFor(file, { minBytes: 0, dir })?.turnOffsets.length).toBe((before ?? 0) + 1);
        await expectSameAsFullParse(resolved, dir);
    });

    test("leaves small files, other providers and worker files to the full parse", () => {
        const { resolved, dir } = setup(conversation(2));
        expect(indexedClaudeEnvelope(resolved, {}, { dir })).toBeNull();
        expect(indexedClaudeEnvelope({ ...resolved, provider: "codex" }, {}, { minBytes: 0, dir })).toBeNull();
        expect(indexedClaudeEnvelope({ ...resolved, source: "worker" }, {}, { minBytes: 0, dir })).toBeNull();
    });
});

describe("searchTranscript", () => {
    const content = () =>
        conversation(3) +
        user("the Timestamp of the deploy") +
        assistant("done", "tq") +
        toolResult("tq", "MARKER line");

    async function bothPaths(resolved: ResolvedTranscript, dir: string, query: string) {
        const indexed = await searchTranscript(resolved, { query }, { minBytes: 0, dir });
        const full = await searchTranscript(resolved, { query }, { minBytes: Number.POSITIVE_INFINITY, dir });
        expect(indexed).toEqual(full);
        return indexed;
    }

    test("matches text, tool input and tool result, case-insensitively, on the right turn", async () => {
        const { resolved, dir } = setup(content());
        // Turns: prompt 0, answer 0, prompt 1, answer 1, prompt 2, answer 2, the Timestamp prompt, done.
        expect((await bothPaths(resolved, dir, "ANSWER 1")).turns).toEqual([3]);
        expect((await bothPaths(resolved, dir, "echo t2")).turns).toEqual([5]);
        expect((await bothPaths(resolved, dir, "out 0 ✓")).turns).toEqual([1]);
        expect((await bothPaths(resolved, dir, "marker")).turns).toEqual([7]);
        expect((await bothPaths(resolved, dir, "ŽLUŤOUČKÝ")).turns).toEqual([0, 2, 4]);
    });

    test("ignores a hit on a JSON key but finds the same word in visible text", async () => {
        const { resolved, dir } = setup(content());
        expect(await bothPaths(resolved, dir, "tool_use_id")).toEqual({
            sessionId: "session",
            total: 0,
            turns: [],
            truncated: false,
        });
        expect((await bothPaths(resolved, dir, "timestamp")).turns).toEqual([6]);
    });

    test("caps the returned turns at limit and still counts every match", async () => {
        const { resolved, dir } = setup(content());
        const result = await searchTranscript(resolved, { query: "prompt", limit: 2 }, { minBytes: 0, dir });
        expect(result).toEqual({ sessionId: "session", total: 3, turns: [0, 2], truncated: true });
    });

    test("finds a tool result that lands after a later prompt", async () => {
        const late =
            user("start") + assistant("working", "tl") + user("are you done?") + toolResult("tl", "late RESULT");
        const { resolved, dir } = setup(late);
        expect((await bothPaths(resolved, dir, "late result")).turns).toEqual([1]);
        const sparse = indexedClaudeEnvelope(resolved, { turns: [1] }, { minBytes: 0, dir });
        const full = await transcriptEnvelope(resolved, { turns: [1] });
        expect(sparse).toEqual(full);
        expect(sparse?.turns[0]?.tools[0]?.result).toBe("late RESULT");
    });
});

describe("sparse envelopes", () => {
    test("returns exactly the requested turns with their global index, on both paths", async () => {
        const { resolved, dir } = setup(conversation(6));
        const turns = [9, 2, 2, 400, -1, 7];
        const indexed = indexedClaudeEnvelope(resolved, { turns }, { minBytes: 0, dir });
        const full = await transcriptEnvelope(resolved, { turns });
        expect(indexed).toEqual(full);
        expect(full.turns.map((turn) => turn.index)).toEqual([2, 7, 9]);
        expect(full.turns.map((turn) => turn.text)).toEqual(["prompt 1 — žluťoučký kůň 🐴", "answer 3", "answer 4"]);
        expect(full.nextOffset).toBe(10);
        expect(full.truncated).toBe(true);
    });

    test("a window from an offset carries the transcript's turn count on both paths", async () => {
        const { resolved, dir } = setup(conversation(6));
        const indexed = indexedClaudeEnvelope(resolved, { offset: 2, limit: 3 }, { minBytes: 0, dir });
        const full = await transcriptEnvelope(resolved, { offset: 2, limit: 3 });
        const everything = await transcriptEnvelope(resolved, { offset: 0, limit: 1000 });

        expect(indexed).toEqual(full);
        expect(full.nextOffset).toBe(5);
        expect(full.turnCount).toBe(everything.turns.length);
        expect(full.nextOffset).toBeLessThan(full.turnCount ?? 0);
        // truncated alone cannot say whether a window reaches the end: an offset above 0 sets it.
        expect(everything.truncated).toBe(false);
        expect(full.truncated).toBe(true);
    });

    test("a default slice carries no index", async () => {
        const { resolved, dir } = setup(conversation(2));
        const indexed = indexedClaudeEnvelope(resolved, {}, { minBytes: 0, dir });
        const full = await transcriptEnvelope(resolved, {});
        expect(full.turns.some((turn) => "index" in turn)).toBe(false);
        expect(indexed?.turns.some((turn) => "index" in turn)).toBe(false);
    });
});

describe("bounded receipt transcript context", () => {
    test("matches native Claude IDs with surrounding messages and attached tool results", () => {
        const fixture = setup(
            user("before") + assistant("at receipt", "native-tool") + toolResult("native-tool", "done") + user("after")
        );
        const result = transcriptAround({
            resolved: fixture.resolved,
            anchor: {
                kind: "native",
                provider: "claude",
                sessionId: "session",
                receivedAt: 1_700_000_000_000,
                toolCallId: "native-tool",
            },
        });
        expect(result.status).toBe("native");
        expect(result.before[0]?.text).toBe("before");
        expect(result.around[0]?.text).toBe("at receipt");
        expect(result.around[0]?.tools[0]?.result).toBe("done");
        expect(result.after[0]?.text).toBe("after");
    });

    test("receipt time and missing native anchors are explicit fallbacks", () => {
        const fixture = setup(user("first") + user("nearest"));
        const receivedAt = 1_700_000_000_000 + serial * 1000;
        const anchor = { kind: "receipt-time" as const, provider: "claude" as const, sessionId: "session", receivedAt };
        const timed = transcriptAround({ resolved: fixture.resolved, anchor });
        expect(timed.status).toBe("receipt-time");
        expect(timed.around[0]?.text).toBe("nearest");
        const missing = transcriptAround({
            resolved: fixture.resolved,
            anchor: { ...anchor, kind: "native", messageId: "absent" },
        });
        expect(missing.status).toBe("native-not-found");
        expect(missing.around[0]?.text).toBe("nearest");
    });

    test("unanchored and mismatched identities do not read the file", () => {
        const resolved: ResolvedTranscript = {
            provider: "codex",
            source: "native",
            sessionId: "session",
            filePath: "/fixture/missing.jsonl",
        };
        expect(transcriptAround({ resolved, anchor: { kind: "unanchored", receivedAt: 1 } }).bytesRead).toBe(0);
        expect(() =>
            transcriptAround({
                resolved,
                anchor: { kind: "receipt-time", provider: "claude", sessionId: "session", receivedAt: 1 },
            })
        ).toThrow("different provider/session");
        expect(() =>
            transcriptAround({
                resolved,
                anchor: { kind: "receipt-time", provider: "codex", sessionId: "other", receivedAt: 1 },
            })
        ).toThrow("different provider/session");
    });

    test("caps reads and skips oversized, malformed and torn records without matching an ID in text", () => {
        const content =
            user("padding".repeat(30_000)) +
            "invalid\n" +
            assistant("mention fake-id") +
            user("after") +
            '{"type":"user"';
        const fixture = setup(content);
        const result = transcriptAround({
            resolved: fixture.resolved,
            maxBytes: 100_000,
            anchor: {
                kind: "native",
                provider: "claude",
                sessionId: "session",
                receivedAt: 1_700_000_000_000,
                messageId: "fake-id",
            },
        });
        expect(result.bytesRead).toBe(100_000);
        expect(result.fileSize).toBe(Buffer.byteLength(content));
        expect(result.status).toBe("native-not-found");
        expect(result.truncated).toBe(true);
        expect(result.skippedLines).toBeGreaterThanOrEqual(2);
        expect(
            [...result.before, ...result.around, ...result.after].some((turn) => turn.text === "mention fake-id")
        ).toBe(true);
        const oversized = transcriptAround({
            resolved: fixture.resolved,
            anchor: { kind: "receipt-time", provider: "claude", sessionId: "session", receivedAt: 1_700_000_000_000 },
        });
        expect(oversized.skippedLines).toBeGreaterThanOrEqual(3);
    });

    test("Codex uses call_id and never accepts a normalized ordinal as native ID", () => {
        const fixture = setup(
            [
                {
                    type: "event_msg",
                    timestamp: "2026-01-01T10:00:00Z",
                    payload: { type: "user_message", message: "before" },
                },
                {
                    type: "response_item",
                    timestamp: "2026-01-01T10:00:01Z",
                    payload: { type: "function_call", call_id: "native-call", name: "shell", arguments: "{}" },
                },
                {
                    type: "response_item",
                    timestamp: "2026-01-01T10:00:02Z",
                    payload: { type: "function_call_output", call_id: "native-call", output: "result" },
                },
            ]
                .map(line)
                .join("")
        );
        const resolved: ResolvedTranscript = { ...fixture.resolved, provider: "codex" };
        const anchor = {
            kind: "native" as const,
            provider: "codex" as const,
            sessionId: "session",
            receivedAt: Date.parse("2026-01-01T10:00:01Z"),
        };
        const result = transcriptAround({ resolved, anchor: { ...anchor, toolCallId: "native-call" } });
        expect(result.status).toBe("native");
        expect(result.around[0]?.tools[0]?.result).toBe("result");
        expect(transcriptAround({ resolved, anchor: { ...anchor, messageId: "codex-2" } }).status).toBe(
            "native-not-found"
        );
    });

    test("a specific Codex call wins over its distant turn marker and contradictory IDs remain unresolved", () => {
        const opening = line({
            type: "event_msg",
            timestamp: "2026-01-01T10:00:00Z",
            payload: { type: "task_started", turn_id: "native-turn" },
        });
        const middle = Array.from({ length: 50 }, (_, index) =>
            line({
                type: "event_msg",
                timestamp: "2026-01-01T10:00:01Z",
                payload: { type: "agent_message", message: `Intervening ${index} ${"x".repeat(6000)}` },
            })
        ).join("");
        const invocation = line({
            type: "response_item",
            timestamp: "2026-01-01T10:00:02Z",
            payload: { type: "function_call", call_id: "specific-call", name: "shell", arguments: "{}" },
        });
        const output = line({
            type: "response_item",
            timestamp: "2026-01-01T10:00:03Z",
            payload: { type: "function_call_output", call_id: "specific-call", output: "receipt saved" },
        });
        const fixture = setup(opening + middle + invocation + output);
        const resolved: ResolvedTranscript = { ...fixture.resolved, provider: "codex" };
        const anchor = {
            kind: "native" as const,
            provider: "codex" as const,
            sessionId: "session",
            receivedAt: Date.parse("2026-01-01T10:00:02Z"),
            turnId: "native-turn",
            toolCallId: "specific-call",
        };
        const result = transcriptAround({ resolved, anchor });
        expect(result.status).toBe("native");
        expect(result.anchorOffset).toBe(Buffer.byteLength(opening + middle));
        expect(result.around[0]?.tools[0]?.result).toBe("receipt saved");
        expect(transcriptAround({ resolved, anchor: { ...anchor, toolCallId: "absent-call" } }).status).toBe(
            "native-not-found"
        );
        expect(transcriptAround({ resolved, anchor: { ...anchor, turnId: "another-turn" } }).status).toBe(
            "native-not-found"
        );
        for (const skipped of ["malformed", "x".repeat(70_000)]) {
            writeFileSync(fixture.file, opening + skipped + "\n" + invocation + output);
            expect(transcriptAround({ resolved, anchor }).status).toBe("native-not-found");
            expect(transcriptAround({ resolved, anchor: { ...anchor, turnId: undefined } }).status).toBe("native");
        }
        expect(transcriptAround({ resolved, anchor, maxBytes: 1000 }).status).toBe("native-not-found");
        writeFileSync(
            fixture.file,
            opening +
                line({ type: "event_msg", payload: { type: "task_started", turn_id: "new-turn" } }) +
                invocation +
                output
        );
        expect(transcriptAround({ resolved, anchor }).status).toBe("native-not-found");
    });

    test("the matched native tool remains visible when the source message exceeds the tool display cap", () => {
        const fixture = setup(
            line({
                type: "assistant",
                uuid: "many-tools",
                timestamp: "2026-01-01T10:00:00Z",
                message: {
                    role: "assistant",
                    content: Array.from({ length: 20 }, (_, index) => ({
                        type: "tool_use",
                        id: `call-${index}`,
                        name: "Bash",
                        input: { command: "true" },
                    })),
                },
            })
        );
        const result = transcriptAround({
            resolved: fixture.resolved,
            anchor: { kind: "native", provider: "claude", sessionId: "session", receivedAt: 1, toolCallId: "call-19" },
        });
        expect(result.status).toBe("native");
        expect(result.around[0]?.tools).toHaveLength(12);
        expect(result.truncated).toBe(true);
        expect(result.around[0]?.tools.some((tool) => tool.id === "call-19")).toBe(true);
    });

    test("top-level Codex token usage records expose raw turn IDs but arbitrary fields do not", () => {
        const fixture = setup(
            line({
                type: "token_usage_record",
                timestamp: "2026-01-01T10:00:00Z",
                payload: { turn_id: "usage-turn", usage: {} },
            })
        );
        const resolved: ResolvedTranscript = { ...fixture.resolved, provider: "codex" };
        const anchor = {
            kind: "native" as const,
            provider: "codex" as const,
            sessionId: "session",
            receivedAt: Date.parse("2026-01-01T10:00:00Z"),
            turnId: "usage-turn",
        };
        expect(transcriptAround({ resolved, anchor }).status).toBe("native");
        writeFileSync(fixture.file, line({ type: "unrecognized", payload: { turn_id: "usage-turn" } }));
        expect(transcriptAround({ resolved, anchor }).status).toBe("native-not-found");
    });

    test("Claude supplied message and tool IDs must describe the same source record", () => {
        const fixture = setup(
            line({
                type: "assistant",
                uuid: "source-row",
                timestamp: "2026-01-01T10:00:00Z",
                message: {
                    id: "source-message",
                    role: "assistant",
                    content: [{ type: "tool_use", id: "source-call", name: "Bash", input: { command: "true" } }],
                },
            })
        );
        const anchor = {
            kind: "native" as const,
            provider: "claude" as const,
            sessionId: "session",
            receivedAt: Date.parse("2026-01-01T10:00:00Z"),
            messageId: "source-message",
            toolCallId: "source-call",
        };
        expect(transcriptAround({ resolved: fixture.resolved, anchor }).status).toBe("native");
        expect(
            transcriptAround({ resolved: fixture.resolved, anchor: { ...anchor, messageId: "different-message" } })
                .status
        ).toBe("native-not-found");
        expect(
            transcriptAround({ resolved: fixture.resolved, anchor: { ...anchor, toolCallId: "different-call" } }).status
        ).toBe("native-not-found");
    });

    test("Grok native tool IDs and seconds timestamps preserve receipt-time ordering", () => {
        const fixture = setup(
            [
                {
                    timestamp: 1_700_000_000,
                    params: { update: { sessionUpdate: "user_message", content: { type: "text", text: "before" } } },
                },
                {
                    timestamp: 1_700_000_010,
                    params: { update: { sessionUpdate: "tool_call", toolCallId: "grok-native", title: "shell" } },
                },
                {
                    timestamp: 1_700_000_011,
                    params: {
                        update: {
                            sessionUpdate: "tool_call_update",
                            toolCallId: "grok-native",
                            status: "completed",
                            content: { type: "text", text: "done" },
                        },
                    },
                },
            ]
                .map(line)
                .join("")
        );
        const resolved: ResolvedTranscript = { ...fixture.resolved, provider: "grok" };
        const anchor = {
            kind: "native" as const,
            provider: "grok" as const,
            sessionId: "session",
            receivedAt: 1_700_000_010_000,
            toolCallId: "grok-native",
        };
        const result = transcriptAround({ resolved, anchor });
        expect(result.status).toBe("native");
        expect(result.around[0]?.tools[0]?.result).toBe("done");
        expect(
            transcriptAround({ resolved, anchor: { ...anchor, kind: "receipt-time" } }).around[0]?.tools[0]?.id
        ).toBe("grok-native");
    });

    test("before and after counts are independent, bounded, and validated before reads", () => {
        const fixture = setup(user("before") + assistant("center", "count-tool") + user("after"));
        const anchor = {
            kind: "native" as const,
            provider: "claude" as const,
            sessionId: "session",
            receivedAt: 1,
            toolCallId: "count-tool",
        };
        const result = transcriptAround({ resolved: fixture.resolved, anchor, before: 0, after: 1 });
        expect(result.before).toEqual([]);
        expect(result.around[0]?.text).toBe("center");
        expect(result.after.map((turn) => turn.text)).toEqual(["after"]);
        expect(() => transcriptAround({ resolved: fixture.resolved, anchor, before: 11 })).toThrow("between 0 and 10");
        expect(() => transcriptAround({ resolved: fixture.resolved, anchor, after: 0.5 })).toThrow("between 0 and 10");
    });

    test("cancelled lookup aborts before reading and worker sources fail explicitly", () => {
        const fixture = setup(user("example"));
        const anchor = {
            kind: "receipt-time" as const,
            provider: "claude" as const,
            sessionId: "session",
            receivedAt: 1,
        };
        const controller = new AbortController();
        controller.abort();
        expect(() => transcriptAround({ resolved: fixture.resolved, anchor, signal: controller.signal })).toThrow();
        expect(transcriptAround({ resolved: { ...fixture.resolved, source: "worker" }, anchor }).status).toBe(
            "unsupported"
        );
    });
});
