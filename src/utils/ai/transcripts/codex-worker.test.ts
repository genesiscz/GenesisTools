import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { transcriptEnvelope } from "./load";
import type { ResolvedTranscript } from "./resolve";

const THREAD = "thr_1";

// The shapes `tools codex` really stores: app-server notifications by METHOD
// (`item/started`, `item/completed`, `turn/completed`), not the substring
// matcher the first transcript adapter guessed at (PR #364 review, eve HIGH).
const lines = [
    { source: "app-server", method: "turn/started", params: { threadId: THREAD, turn: { id: "t1" } } },
    { source: "app-server", method: "item/agentMessage/delta", params: { threadId: THREAD, delta: "Under" } },
    { source: "app-server", method: "item/agentMessage/delta", params: { threadId: THREAD, delta: "stood." } },
    {
        source: "app-server",
        method: "item/completed",
        params: { threadId: THREAD, item: { type: "agentMessage", id: "msg_1", text: "Understood." } },
    },
    {
        source: "app-server",
        method: "item/started",
        params: {
            threadId: THREAD,
            item: { type: "commandExecution", id: "exec-1", command: "ls", status: "inProgress" },
        },
    },
    {
        source: "app-server",
        method: "item/completed",
        params: {
            threadId: THREAD,
            item: {
                type: "commandExecution",
                id: "exec-1",
                command: "ls",
                status: "completed",
                exitCode: 0,
                aggregatedOutput: "a.txt\n",
            },
        },
    },
    {
        source: "app-server",
        method: "item/completed",
        params: { threadId: THREAD, item: { type: "agentMessage", id: "msg_2", text: "One file: a.txt." } },
    },
    {
        source: "app-server",
        method: "turn/completed",
        params: { threadId: THREAD, turn: { id: "t1", status: "completed" } },
    },
];

describe("codex worker session files", () => {
    test("go through the codex CLI's own event mapping: messages, tool calls with results, and the terminal event", async () => {
        const dir = mkdtempSync(join(tmpdir(), "codex-worker-"));
        const filePath = join(dir, "task.jsonl");
        writeFileSync(filePath, `${lines.map((line) => SafeJSON.stringify(line, { strict: true })).join("\n")}\n`);

        const resolved: ResolvedTranscript = { provider: "codex", source: "worker", sessionId: "task", filePath };
        const envelope = await transcriptEnvelope(resolved);

        expect(envelope.terminated).toBe("end");
        const assistant = envelope.turns.filter((turn) => turn.role === "assistant");
        expect(assistant.map((turn) => turn.text)).toEqual(["Understood.", "One file: a.txt."]);
        expect(assistant[0]?.tools).toHaveLength(1);
        expect(assistant[0]?.tools[0]).toMatchObject({ id: "exec-1", result: "a.txt\n", isError: false });
        expect(envelope.turns.at(-1)?.event?.kind).toBe("end");
    });
});
