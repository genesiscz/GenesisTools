import { describe, expect, test } from "bun:test";
import type { AssistantMessage, ConversationMessage, UserMessage } from "@genesiscz/utils/claude/types";
import { claudeMessagesToTurns } from "./claude";
import { clipResult, sliceTurns } from "./types";

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

    test("slash-command XML becomes a slash name", () => {
        const turns = claudeMessagesToTurns([
            user({
                uuid: "u1",
                message: {
                    role: "user",
                    content: "<command-message><command-name>speckit.implement</command-name></command-message>",
                },
            }),
        ]);
        expect(turns[0]?.text).toBe("/speckit.implement");
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
});
