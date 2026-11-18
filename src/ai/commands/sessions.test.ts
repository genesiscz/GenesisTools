import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { drainSpool } from "@genesiscz/utils/metrics/spool";
import { MetricsStore } from "@genesiscz/utils/metrics/store";
import { Command } from "commander";
import { spoolContextItems } from "../lib/sessions/session-context";
import { registerSessionsCommands, resumeAdvice } from "./sessions";

async function run(args: string[]): Promise<{ exitCode: typeof process.exitCode; errors: string[] }> {
    const errors: string[] = [];
    const printlnErr = spyOn(out, "printlnErr").mockImplementation((line?: unknown) => {
        errors.push(String(line));
    });
    const program = new Command().exitOverride();
    registerSessionsCommands(program);

    try {
        await program.parseAsync(["node", "tools", ...args]);
        return { exitCode: process.exitCode, errors };
    } finally {
        printlnErr.mockRestore();
    }
}

afterEach(() => {
    process.exitCode = 0;
});

describe("sessions range flags", () => {
    test("context exposes the five report sections and exports queryable source and carry dimensions", async () => {
        const dir = mkdtempSync(join(tmpdir(), "context-cli-"));
        const path = join(dir, "session.jsonl");
        const at = "2025-01-01T00:00:00Z";
        writeFileSync(
            path,
            [
                { type: "user", timestamp: at, message: { content: "test" } },
                {
                    type: "assistant",
                    timestamp: at,
                    message: { id: "one", model: "model", usage: { input_tokens: 10 } },
                },
            ]
                .map((row) => SafeJSON.stringify(row))
                .join("\n")
        );
        const result = spyOn(out, "result").mockImplementation(() => {});
        try {
            expect((await run(["sessions", "context", path, "--provider", "claude", "--json"])).errors).toEqual([]);
            expect(result.mock.calls[0]?.[0]).toMatchObject({
                supported: true,
                mainBySource: expect.any(Array),
                mainPushed: [{ source: "system-prompt+tools" }],
                startByType: [],
                agentsByCacheRead: [],
                largestItems: [
                    { loop: "session", line: 1, carry: 1 },
                    { line: 0, carry: 0 },
                ],
            });
            expect(result.mock.calls[0]?.[0]).not.toHaveProperty("metrics");
        } finally {
            result.mockRestore();
        }

        const { snapshot, events } = spoolContextItems({
            sessionId: "lead",
            dir,
            loops: [
                {
                    id: "helper",
                    kind: "subagent",
                    files: [path],
                    agentType: "reviewer",
                    teamName: null,
                    model: "model",
                    calls: 4,
                    firstCallContext: 100,
                    peakContext: 150,
                    cacheRead: 200,
                    toolCalls: {},
                    compactions: 0,
                    items: [{ path, line: 1, at, source: "instructions", key: "rules.md", tokens: 11, carryCalls: 3 }],
                },
            ],
        });
        expect(events).toBe(1);
        const db = join(dir, "metrics.db");
        const writer = MetricsStore.open({ path: db });
        try {
            expect(drainSpool(writer, { dir })).toMatchObject({ events: 1, bad: 0 });
        } finally {
            writer.close();
        }
        const reopened = MetricsStore.open({ path: db });
        try {
            expect(
                reopened.query({
                    project: "agent-context",
                    metric: "context.item",
                    groupBy: [
                        "session",
                        "loop",
                        "kind",
                        "agentType",
                        "model",
                        "source",
                        "key",
                        "carryCalls",
                        "snapshot",
                    ],
                    aggregates: ["count", "sum"],
                }).rows
            ).toEqual([
                {
                    group: {
                        session: "lead",
                        loop: "helper",
                        kind: "subagent",
                        agentType: "reviewer",
                        model: "model",
                        source: "instructions",
                        key: "rules.md",
                        carryCalls: 3,
                        snapshot,
                    },
                    values: { count: 1, sum: 11 },
                },
            ]);
        } finally {
            reopened.close();
        }
    });
    test("resumes --ttl-only groups the observed model and excludes compacted and model-changing gaps", async () => {
        const path = join(mkdtempSync(join(tmpdir(), "resumes-cli-")), "session.jsonl");
        const call = (id: string, minute: number, model: string, read: number) => ({
            type: "assistant",
            timestamp: new Date(minute * 60_000).toISOString(),
            message: {
                id,
                model,
                stop_reason: "end_turn",
                usage: { cache_read_input_tokens: read, cache_creation: { ephemeral_5m_input_tokens: 100 } },
            },
        });
        writeFileSync(
            path,
            [
                call("a", 0, "model-one", 0),
                call("b", 4, "model-one", 100),
                call("c", 9, "model-two", 0),
                { type: "system", subtype: "compact_boundary" },
                call("d", 14, "model-two", 0),
                call("e", 20, "model-two", 0),
            ]
                .map((row) => SafeJSON.stringify(row))
                .join("\n")
        );
        const result = spyOn(out, "result").mockImplementation(() => {});
        try {
            expect(
                (await run(["sessions", "resumes", path, "--provider", "claude", "--ttl-only", "--json"])).errors
            ).toEqual([]);
            expect(result.mock.calls[0]?.[0]).toMatchObject({
                scanned: 1,
                ttl: [
                    {
                        kind: "main",
                        model: "model-one",
                        writeTtl: "5m",
                        longestHitMin: 4,
                        shortestMissMin: null,
                        buckets: { "4-5m": { hit: 1 } },
                    },
                    { model: "model-two", longestHitMin: null, shortestMissMin: 6, buckets: { "6-15m": { miss: 1 } } },
                ],
            });
            expect(result.mock.calls[0]?.[0]).not.toHaveProperty("sessions");
        } finally {
            result.mockRestore();
        }
    });
    test("resume advice marks an idle large agent and preserves unknown context", () => {
        const agent = { lastAt: new Date(0).toISOString(), state: "done" as const, contextTokens: 300_001 };
        expect(resumeAdvice(agent, 300_001)).toEqual({ idleMs: 300_001, contextTokens: 300_001, coldLarge: true });
        expect(resumeAdvice(agent, 300_000).coldLarge).toBe(false);
        expect(resumeAdvice({ ...agent, contextTokens: 300_000 }, 300_001).coldLarge).toBe(false);
        expect(resumeAdvice({ ...agent, state: "running" }, 300_001).coldLarge).toBe(false);
        expect(resumeAdvice({ ...agent, contextTokens: null }, 300_001).coldLarge).toBeNull();
    });

    test("resumes requires a target and rejects invalid dates and gaps", async () => {
        expect((await run(["sessions", "resumes"])).errors).toContain("Give a session id or --since.");
        expect((await run(["sessions", "resumes", "--since", "nope"])).errors.join("")).toContain("--since needs");
        expect((await run(["sessions", "resumes", "test", "--min-gap", "-1"])).errors.join("")).toContain(
            "--min-gap needs"
        );
    });
    test.each([
        [["sessions", "tail", "session-1", "--limit", "2oops"], "--limit must be a positive integer"],
        [["sessions", "tail", "session-1", "--limit", "1.5"], "--limit must be a positive integer"],
        [["sessions", "tail", "session-1", "--limit", "0"], "--limit must be a positive integer"],
        [["sessions", "tail", "session-1", "--offset", "3x"], "--offset must be a non-negative integer"],
        [["sessions", "tail", "session-1", "--turns", "3,1.5"], "--turns must be a comma-separated list"],
        [["sessions", "grep", "session-1", "needle", "--limit", "2oops"], "--limit must be a positive integer"],
    ])("%p is refused, not truncated", async (args, message) => {
        const result = await run(args);

        expect(result.exitCode).toBe(2);
        expect(result.errors.join("\n")).toContain(message);
    });

    // Negative control: whole numbers get past the range checks and stop at the next check instead.
    test("whole numbers pass the range checks", async () => {
        const tail = await run(["sessions", "tail", "session-1", "--limit", "5", "--offset", "0", "--provider", "x"]);
        expect(tail.errors).toEqual([expect.stringContaining("--provider must be one of")]);

        const grep = await run(["sessions", "grep", "session-1", "", "--limit", "5"]);
        expect(grep.errors).toEqual(["<query> must not be empty"]);
    });
});
