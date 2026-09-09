import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { codexGtEventsToTurns, codexNativeLinesToTurns } from "./codex";
import { totalsOf } from "./types";

describe("codexGtEventsToTurns", () => {
    test("maps agent message and command execution into turns", () => {
        const lines = [
            SafeJSON.stringify({
                seq: 1,
                ts: "2026-08-27T20:00:00.000Z",
                source: "app-server",
                method: "item/agentMessage/delta",
                params: { delta: "Working on it." },
            }),
            SafeJSON.stringify({
                seq: 2,
                ts: "2026-08-27T20:00:01.000Z",
                source: "app-server",
                method: "item/commandExecution/delta",
                params: { command: "git status", output: "clean" },
            }),
        ];
        const turns = codexGtEventsToTurns(lines);
        expect(turns.some((t) => t.text.includes("Working on it."))).toBe(true);
        const tool = turns.flatMap((t) => t.tools).find((t) => t.name === "commandExecution");
        expect(tool?.inputPreview).toBe("git status");
        expect(tool?.result).toBe("clean");
    });

    test("skips malformed JSONL in GT event logs", () => {
        const lines = [
            "not json",
            SafeJSON.stringify({
                seq: 1,
                ts: "2026-08-27T20:00:00.000Z",
                source: "app-server",
                method: "item/agentMessage/delta",
                params: { delta: "Working on it." },
            }),
        ];
        const turns = codexGtEventsToTurns(lines);
        expect(turns.some((t) => t.text.includes("Working on it."))).toBe(true);
    });
});

describe("codexNativeLinesToTurns", () => {
    test("maps event_msg agent_message and function_call pairs", () => {
        const lines = [
            SafeJSON.stringify({
                type: "event_msg",
                timestamp: "2026-08-27T20:00:00.000Z",
                payload: { type: "user_message", message: "run status" },
            }),
            SafeJSON.stringify({
                type: "event_msg",
                timestamp: "2026-08-27T20:00:01.000Z",
                payload: { type: "agent_message", message: "checking" },
            }),
            SafeJSON.stringify({
                type: "response_item",
                timestamp: "2026-08-27T20:00:02.000Z",
                payload: {
                    type: "function_call",
                    name: "shell",
                    call_id: "c1",
                    arguments: SafeJSON.stringify({ command: "git status" }),
                },
            }),
            SafeJSON.stringify({
                type: "response_item",
                timestamp: "2026-08-27T20:00:03.000Z",
                payload: { type: "function_call_output", call_id: "c1", output: "clean" },
            }),
        ];
        const turns = codexNativeLinesToTurns(lines);
        expect(turns[0]?.role).toBe("user");
        expect(turns[0]?.text).toBe("run status");
        expect(turns[1]?.text).toBe("checking");
        expect(turns[1]?.tools[0]).toEqual({
            id: "c1",
            name: "shell",
            inputPreview: "git status",
            result: "clean",
            isError: false,
        });
    });

    test("skips malformed and truncated JSONL lines", () => {
        const lines = [
            "not json",
            '{"type":"event_msg"',
            SafeJSON.stringify({
                type: "event_msg",
                timestamp: "2026-08-27T20:00:00.000Z",
                payload: { type: "user_message", message: "run status" },
            }),
            SafeJSON.stringify({
                type: "event_msg",
                timestamp: "2026-08-27T20:00:01.000Z",
                payload: { type: "agent_message", message: "checking" },
            }),
        ];
        const turns = codexNativeLinesToTurns(lines);
        expect(turns[0]?.text).toBe("run status");
        expect(turns[1]?.text).toBe("checking");
    });
});

describe("codexNativeLinesToTurns on a current rollout", () => {
    // The record shapes of a 2026-09 `codex` CLI rollout: messages are `response_item` items with
    // content parts, the reasoning summary lives in `item_completed`, tokens in `token_usage_record`.
    const line = (type: string, payload: Record<string, unknown>, ordinal: number) =>
        SafeJSON.stringify({
            timestamp: `2026-09-09T16:54:${String(34 + ordinal).padStart(2, "0")}.000Z`,
            ordinal,
            type,
            payload,
        });
    const lines = [
        line("session_meta", { id: "01a0-invented", cwd: "/tmp/project" }, 0),
        line("event_msg", { type: "task_started", turn_id: "t1" }, 1),
        line(
            "response_item",
            { type: "message", role: "developer", content: [{ type: "input_text", text: "instructions" }] },
            2
        ),
        line(
            "response_item",
            {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "<recommended_plugins>\nHere is a list of plugins" }],
                internal_chat_message_metadata_passthrough: {
                    content_item_kinds: ["plugins.recommendations", "environments.environment_context"],
                },
            },
            3
        ),
        line(
            "response_item",
            {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "list the homes" }],
                internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] },
            },
            3
        ),
        line(
            "event_msg",
            { type: "item_completed", item: { type: "Reasoning", id: "r1", summary_text: ["Thinking about homes"] } },
            4
        ),
        line("response_item", { type: "reasoning", id: "r1", summary: [], encrypted_content: "xxx" }, 5),
        line(
            "response_item",
            {
                type: "message",
                role: "assistant",
                phase: "final_answer",
                content: [
                    { type: "output_text", text: "Two homes." },
                    { type: "output_text", text: "Both clear." },
                ],
            },
            6
        ),
        line(
            "token_usage_record",
            {
                turn_id: "t1",
                usage: {
                    input_tokens: 120,
                    cached_input_tokens: 100,
                    output_tokens: 30,
                    reasoning_output_tokens: 12,
                    total_tokens: 150,
                },
            },
            7
        ),
        line("event_msg", { type: "task_complete", turn_id: "t1", last_agent_message: "Both clear." }, 8),
    ];

    test("replays user and assistant messages, the reasoning summary and the model call's tokens", () => {
        const turns = codexNativeLinesToTurns(lines);

        expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
        expect(turns[0]?.text).toBe("list the homes");
        expect(turns[1]?.text).toBe("Two homes.\nBoth clear.");
        expect(turns[1]?.reasoning).toBe("Thinking about homes");
        expect(turns[1]?.usage).toEqual({
            inputTokens: 120,
            cacheReadTokens: 100,
            outputTokens: 30,
            reasoningTokens: 12,
        });
        expect(totalsOf(turns)).toMatchObject({ modelCalls: 1, inputTokens: 120, outputTokens: 30 });
    });

    test("developer instructions and injected context blocks never become a turn", () => {
        const turns = codexNativeLinesToTurns(lines.slice(0, 4));
        expect(turns).toEqual([]);
    });

    test("a user message without metadata, from an older rollout, is still a prompt", () => {
        const turns = codexNativeLinesToTurns([
            line(
                "response_item",
                { type: "message", role: "user", content: [{ type: "input_text", text: "old style" }] },
                0
            ),
        ]);
        expect(turns.map((turn) => turn.text)).toEqual(["old style"]);
    });
});
