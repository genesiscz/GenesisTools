import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { codexGtEventsToTurns, codexNativeLinesToTurns } from "./codex";

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
});
