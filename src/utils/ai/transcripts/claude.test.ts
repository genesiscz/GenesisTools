import { describe, expect, test } from "bun:test";
import type { AssistantMessage, ConversationMessage, UserMessage } from "@genesiscz/utils/claude/types";
import { claudeMessagesToTurns } from "./claude";
import { clipResult, sliceTurns, totalsOf } from "./types";

function user(partial: Partial<UserMessage> & Pick<UserMessage, "uuid" | "message">): UserMessage {
    return {
        type: "user",
        parentUuid: null,
        sessionId: "sess",
        timestamp: "2026-08-27T20:01:00.000Z",
        userType: "external",
        ...partial,
    };
}

function assistant(partial: Partial<AssistantMessage> & Pick<AssistantMessage, "uuid" | "message">): AssistantMessage {
    return {
        type: "assistant",
        parentUuid: null,
        sessionId: "sess",
        timestamp: "2026-08-27T20:01:08.000Z",
        userType: "external",
        ...partial,
    };
}

describe("claudeMessagesToTurns: usage", () => {
    const row = (uuid: string, id: string, content: AssistantMessage["message"]["content"], output: number) =>
        assistant({
            uuid,
            message: {
                role: "assistant",
                id,
                model: "claude-opus-5-5",
                type: "message",
                stop_reason: null,
                stop_sequence: null,
                content,
                usage: {
                    input_tokens: 10,
                    cache_creation_input_tokens: 5,
                    cache_read_input_tokens: 900,
                    output_tokens: output,
                },
            },
        });

    test("one API response counts once, with its last row's usage, on its first visible turn", () => {
        // Claude Code writes one row per content block, all sharing message.id and each carrying
        // usage. Without this, `tools ai sessions tail` printed "0 model calls · in 0" for every
        // Claude transcript; counting every row would multiply one call by its block count.
        const turns = claudeMessagesToTurns([
            row("r1", "msg-1", [{ type: "thinking", thinking: "plan", signature: "s" }], 3),
            row("r2", "msg-1", [{ type: "text", text: "Reading it." }], 20),
            row("r3", "msg-1", [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/tmp/a" } }], 42),
            row("r4", "msg-2", [{ type: "text", text: "Done." }], 7),
        ]);

        expect(turns.map((turn) => turn.usage)).toEqual([
            { inputTokens: 15, cacheReadTokens: 900, outputTokens: 42 },
            undefined,
            { inputTokens: 15, cacheReadTokens: 900, outputTokens: 7 },
        ]);
        expect(totalsOf(turns).modelCalls).toBe(2);
    });

    test("a synthetic message (session limit, local error) is not a model call", () => {
        const synthetic = row("r5", "msg-3", [{ type: "text", text: "limit reached" }], 0);
        synthetic.message.model = "<synthetic>";

        expect(claudeMessagesToTurns([synthetic])[0]?.usage).toBeUndefined();
    });
});

describe("claudeMessagesToTurns", () => {
    test("pairs a Read tool_use with the following tool_result", () => {
        const messages: ConversationMessage[] = [
            user({
                uuid: "u1",
                message: { role: "user", content: "fix the cache clock" },
            }),
            assistant({
                uuid: "a1",
                message: {
                    role: "assistant",
                    id: "msg-a1",
                    model: "claude-opus-4-6",
                    type: "message",
                    stop_reason: "tool_use",
                    stop_sequence: null,
                    usage: { input_tokens: 1, output_tokens: 1 },
                    content: [
                        { type: "text", text: "I will read the pane." },
                        {
                            type: "tool_use",
                            id: "toolu_01",
                            name: "Read",
                            input: { file_path: "SessionDetailsPane.swift" },
                        },
                    ],
                },
            }),
            user({
                uuid: "u2",
                message: {
                    role: "user",
                    content: [
                        {
                            type: "tool_result",
                            tool_use_id: "toolu_01",
                            content: "struct SessionDetailsPane",
                        },
                    ],
                },
            }),
            assistant({
                uuid: "a2",
                message: {
                    role: "assistant",
                    id: "msg-a2",
                    model: "claude-opus-4-6",
                    type: "message",
                    stop_reason: "end_turn",
                    stop_sequence: null,
                    usage: { input_tokens: 1, output_tokens: 1 },
                    content: [{ type: "text", text: "The clock is lastCacheAt." }],
                },
            }),
        ];

        const turns = claudeMessagesToTurns(messages);
        expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "assistant"]);
        expect(turns[0]?.text).toBe("fix the cache clock");
        expect(turns[1]?.tools).toEqual([
            {
                id: "toolu_01",
                name: "Read",
                inputPreview: "SessionDetailsPane.swift",
                result: "struct SessionDetailsPane",
                isError: false,
            },
        ]);
        expect(turns[2]?.text).toBe("The clock is lastCacheAt.");
    });

    test("keeps pending tools when results arrive across two user messages", () => {
        const messages: ConversationMessage[] = [
            assistant({
                uuid: "a1",
                message: {
                    role: "assistant",
                    id: "msg-a1",
                    model: "claude-opus-4-6",
                    type: "message",
                    stop_reason: "tool_use",
                    stop_sequence: null,
                    usage: { input_tokens: 1, output_tokens: 1 },
                    content: [
                        {
                            type: "tool_use",
                            id: "toolu_01",
                            name: "Read",
                            input: { file_path: "a.swift" },
                        },
                        {
                            type: "tool_use",
                            id: "toolu_02",
                            name: "Read",
                            input: { file_path: "b.swift" },
                        },
                    ],
                },
            }),
            user({
                uuid: "u1",
                message: {
                    role: "user",
                    content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "struct A" }],
                },
            }),
            user({
                uuid: "u2",
                message: {
                    role: "user",
                    content: [{ type: "tool_result", tool_use_id: "toolu_02", content: "struct B" }],
                },
            }),
        ];
        const turns = claudeMessagesToTurns(messages);
        expect(turns[0]?.tools.map((t) => t.result)).toEqual(["struct A", "struct B"]);
    });

    test("slash-command XML becomes a slash name plus its arguments", () => {
        const turns = claudeMessagesToTurns([
            user({
                uuid: "u1",
                message: {
                    role: "user",
                    content:
                        "<command-message><command-name>speckit.implement</command-name>" +
                        "<command-args>the login screen</command-args></command-message>",
                },
            }),
        ]);
        expect(turns[0]?.text).toBe("/speckit.implement the login screen");
    });

    test("a slash command with no arguments leaves no turn text", () => {
        const turns = claudeMessagesToTurns([
            user({
                uuid: "u1",
                message: {
                    role: "user",
                    content: "<command-message><command-name>clear</command-name></command-message>",
                },
            }),
        ]);
        expect(turns[0]?.text ?? "").toBe("");
    });
});

describe("sliceTurns", () => {
    test("with no offset, returns the last limit turns", () => {
        const turns = [1, 2, 3].map((n) => ({
            id: String(n),
            role: "user" as const,
            at: null,
            text: String(n),
            tools: [],
        }));
        const sliced = sliceTurns(turns, { limit: 2 });
        expect(sliced.turns.map((t) => t.text)).toEqual(["2", "3"]);
        expect(sliced.truncated).toBe(true);
        expect(sliced.offset).toBe(1);
    });
});

describe("clipResult", () => {
    test("marks a clipped tail with an ellipsis", () => {
        expect(clipResult("abcde", 4)).toBe("abc…");
        expect(clipResult("ab", 4)).toBe("ab");
    });

    test("never cuts an emoji in half, so no lone surrogate reaches the JSON a Swift reader parses", () => {
        const clipped = clipResult("ab🧹cd", 4);

        expect(clipped).toBe("ab…");
        expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(clipped)).toBe(false);
    });
});
