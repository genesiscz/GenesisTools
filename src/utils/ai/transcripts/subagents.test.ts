import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import type { ResolvedTranscript } from "./resolve";
import { listSubagents } from "./subagents";

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

    test("no directory and other providers give an empty list", () => {
        const lonely = join(root, "99999999-0000-0000-0000-000000000000.jsonl");
        writeFileSync(lonely, "");
        expect(listSubagents({ ...claude, filePath: lonely }).subagents).toEqual([]);
        expect(listSubagents({ ...claude, provider: "codex" }).subagents).toEqual([]);
    });
});
