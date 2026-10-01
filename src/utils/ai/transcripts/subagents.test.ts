import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { readTaskNotifications, scanClaudeToolCalls, scanFileMatches } from "./file-scan";
import type { ResolvedTranscript } from "./resolve";
import { listSubagents, SPAWN_PROMPT_CHARS } from "./subagents";

const root = mkdtempSync(join(tmpdir(), "gt-subagents-"));
const sessionId = "11111111-2222-3333-4444-555555555555";
const filePath = join(root, `${sessionId}.jsonl`);
const dir = join(root, sessionId, "subagents");
mkdirSync(dir, { recursive: true });
writeFileSync(filePath, "");

function lines(...records: unknown[]): string {
    return `${records.map((record) => SafeJSON.stringify(record)).join("\n")}\n`;
}

const prompt = (at: string) => ({ type: "user", timestamp: at, message: { role: "user", content: "go" } });
const reply = { type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] } };
const toolCall = { type: "assistant", message: { stop_reason: null, content: [{ type: "tool_use", id: "t1" }] } };

writeFileSync(join(dir, "agent-aone.jsonl"), lines(prompt("2026-09-24T10:00:00.000Z"), reply, { type: "progress" }));
writeFileSync(
    join(dir, "agent-aone.meta.json"),
    SafeJSON.stringify({ name: "worker", description: "Fix the list", agentType: "general-purpose" })
);
writeFileSync(join(dir, "agent-atwo.jsonl"), lines(prompt("2026-09-24T09:00:00.000Z"), toolCall));
writeFileSync(join(dir, "agent-athree.jsonl"), lines(prompt("2026-09-24T11:00:00.000Z")));
writeFileSync(join(dir, "notes.txt"), "not an agent");

const claude: ResolvedTranscript = { provider: "claude", source: "native", sessionId, filePath };

describe("listSubagents: a teammate that approved its shutdown", () => {
    const shutdownSession = "66666666-7777-8888-9999-000000000000";
    const shutdownFile = join(root, `${shutdownSession}.jsonl`);
    const shutdownDir = join(root, shutdownSession, "subagents");
    const approval = (approve: boolean) => ({
        type: "assistant",
        message: {
            stop_reason: null,
            content: [
                {
                    type: "tool_use",
                    id: "t9",
                    name: "SendMessage",
                    input: { to: "team-lead", message: { type: "shutdown_response", request_id: "r1", approve } },
                },
            ],
        },
    });

    mkdirSync(shutdownDir, { recursive: true });
    writeFileSync(shutdownFile, "");
    writeFileSync(
        join(shutdownDir, "agent-aapproved.jsonl"),
        lines(prompt("2026-09-24T10:00:00.000Z"), approval(true))
    );
    writeFileSync(
        join(shutdownDir, "agent-arejected.jsonl"),
        lines(prompt("2026-09-24T10:00:00.000Z"), approval(false))
    );

    test("is done, not running: approving the shutdown ends its process", () => {
        // The last record is the approving SendMessage tool call, and a trailing tool call reads as
        // mid-work, so a teammate that had just shut down was listed `running` for 15 minutes.
        const { subagents } = listSubagents({ ...claude, sessionId: shutdownSession, filePath: shutdownFile });
        expect(subagents.find((agent) => agent.id === "aapproved")?.state).toBe("done");
    });

    test("NEGATIVE CONTROL: a rejected shutdown keeps working, so it stays running", () => {
        const { subagents } = listSubagents({ ...claude, sessionId: shutdownSession, filePath: shutdownFile });
        expect(subagents.find((agent) => agent.id === "arejected")?.state).toBe("running");
    });
});

describe("listSubagents", () => {
    test("reads every agent file, oldest first, with its meta", () => {
        const { subagents } = listSubagents(claude);
        expect(subagents.map((agent) => agent.id)).toEqual(["atwo", "aone", "athree"]);
        const one = subagents.find((agent) => agent.id === "aone");
        expect(one).toMatchObject({ name: "worker", description: "Fix the list", agentType: "general-purpose" });
        expect(subagents.find((agent) => agent.id === "atwo")?.name).toBeNull();
    });

    test("a finished reply is done; a pending tool call or an unanswered prompt is running", () => {
        const states = Object.fromEntries(listSubagents(claude).subagents.map((agent) => [agent.id, agent.state]));
        expect(states).toEqual({ aone: "done", atwo: "running", athree: "running" });
    });

    test("an agent silent past the stale window is stopped, a finished one stays done", () => {
        const later = Date.now() + 60 * 60 * 1000;
        const states = Object.fromEntries(
            listSubagents(claude, { now: later }).subagents.map((agent) => [agent.id, agent.state])
        );
        expect(states).toEqual({ aone: "done", atwo: "stopped", athree: "stopped" });
    });

    test("ids reads only those agents; an unknown id is skipped", () => {
        const { subagents } = listSubagents(claude, { ids: ["aone", "athree", "amissing"] });
        expect(subagents.map((agent) => agent.id)).toEqual(["aone", "athree"]);
        expect(listSubagents(claude, { ids: [] }).subagents).toEqual([]);
    });

    test("no directory and other providers give an empty list", () => {
        const lonely = join(root, "99999999-0000-0000-0000-000000000000.jsonl");
        writeFileSync(lonely, "");
        expect(listSubagents({ ...claude, filePath: lonely }).subagents).toEqual([]);
        expect(listSubagents({ ...claude, provider: "codex" }).subagents).toEqual([]);
    });
});

describe("file scans", () => {
    const scanRoot = mkdtempSync(join(tmpdir(), "gt-file-scan-"));

    test("a match split across the 4 MB read boundary is reported once and whole", () => {
        const path = join(scanRoot, "big.jsonl");
        const needle = '"type":"tool_use","id":"';
        const record = `{"type":"tool_use","id":"toolu_split","name":"Agent"}`;
        // The needle starts 10 bytes before the first chunk ends.
        const padding = "x".repeat(4 * 1024 * 1024 - 10);
        writeFileSync(path, `${padding}${record}\n${record.replace("toolu_split", "toolu_tail")}\n`);

        const seen: string[] = [];
        expect(scanFileMatches(path, needle, 80, (slice) => seen.push(slice.toString("latin1")))).toBe(true);
        // A slice starts at the needle, one byte into the record.
        const body = record.slice(1);
        expect(seen.map((slice) => slice.split("\n")[0])).toEqual([body, body.replace("toolu_split", "toolu_tail")]);
        expect(scanClaudeToolCalls(path)).toEqual({ toolCalls: 2, agentCalls: ["toolu_split", "toolu_tail"] });
    });

    test("a quoted tool call inside a string is not counted", () => {
        const path = join(scanRoot, "quoted.jsonl");
        writeFileSync(
            path,
            lines(
                { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_real", name: "Bash" }] } },
                { type: "user", message: { content: 'she wrote {"type":"tool_use","id":"toolu_fake"}' } }
            )
        );
        expect(scanClaudeToolCalls(path)).toEqual({ toolCalls: 1, agentCalls: [] });
        expect(scanClaudeToolCalls(join(scanRoot, "missing.jsonl"))).toBeNull();
    });

    test("task notifications: the last status per task wins, a status-less event is skipped", () => {
        const path = join(scanRoot, "parent.jsonl");
        const note = (id: string, body: string) => ({
            type: "queue-operation",
            content: `<task-notification>\n<task-id>${id}</task-id>\n${body}</task-notification>`,
        });
        writeFileSync(
            path,
            lines(
                note("aone", "<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n"),
                note("aone", "<status>killed</status>\n"),
                note("bmon", "<summary>Monitor event</summary>\n")
            )
        );
        expect([...readTaskNotifications(path).values()]).toEqual([
            { taskId: "aone", toolUseId: null, status: "killed" },
        ]);
    });
});

describe("listSubagents: meta and head fields", () => {
    const metaRoot = mkdtempSync(join(tmpdir(), "gt-subagents-meta-"));
    const id = "22222222-2222-3333-4444-555555555555";
    const metaDir = join(metaRoot, id, "subagents");
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(join(metaRoot, `${id}.jsonl`), "");
    const longPrompt = `<teammate-message teammate_id="team-lead">\n${"p".repeat(20_000)}\n</teammate-message>`;
    writeFileSync(
        join(metaDir, "agent-amate-0000000000000001.jsonl"),
        lines(
            { type: "user", timestamp: "2026-09-24T10:00:00.000Z", message: { role: "user", content: longPrompt } },
            { type: "assistant", message: { model: "claude-test", stop_reason: "end_turn", content: [] } }
        )
    );
    writeFileSync(
        join(metaDir, "agent-amate-0000000000000001.meta.json"),
        SafeJSON.stringify({
            name: "mate",
            spawnDepth: 0,
            requestShape: "background",
            teamName: "session-22222222",
            taskKind: "in_process_teammate",
            model: "inherit",
        })
    );

    test("a first record longer than the head still gives the spawn prompt, without its envelope", () => {
        const [mate] = listSubagents({
            provider: "claude",
            source: "native",
            sessionId: id,
            filePath: join(metaRoot, `${id}.jsonl`),
        }).subagents;
        expect(mate).toMatchObject({
            spawnDepth: 0,
            requestShape: "background",
            isFork: false,
            teamName: "session-22222222",
            taskKind: "in_process_teammate",
            model: "inherit",
            transcriptModel: "claude-test",
            startedAt: "2026-09-24T10:00:00.000Z",
        });
        expect(mate.spawnPrompt).toBe("p".repeat(SPAWN_PROMPT_CHARS));
        expect(mate.toolCalls).toBeUndefined();
    });

    test("promptChars: Infinity keeps the whole spawn prompt for a one-agent view", () => {
        const [mate] = listSubagents(
            { provider: "claude", source: "native", sessionId: id, filePath: join(metaRoot, `${id}.jsonl`) },
            { promptChars: Number.POSITIVE_INFINITY }
        ).subagents;
        expect(mate.spawnPrompt).toBe("p".repeat(20_000));
    });
});
