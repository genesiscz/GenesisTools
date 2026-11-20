import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as door from "@genesiscz/utils/ai/transcripts/door";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { drainSpool } from "@genesiscz/utils/metrics/spool";
import { MetricsStore } from "@genesiscz/utils/metrics/store";
import { promptCancelSymbol } from "@genesiscz/utils/prompts/cancel";
import * as prompts from "@genesiscz/utils/prompts/p";
import { Command } from "commander";
import { coldComparison } from "../lib/sessions/cold-resumes";
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

/** Runs `work` with stdin reporting `tty`, which is what decides whether a bare --provider may ask. */
async function withStdinTTY<T>(tty: boolean, work: () => Promise<T>): Promise<T> {
    const saved = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: tty, configurable: true });
    try {
        return await work();
    } finally {
        if (saved) {
            Object.defineProperty(process.stdin, "isTTY", saved);
        } else {
            Reflect.deleteProperty(process.stdin, "isTTY");
        }
    }
}

describe("sessions --provider without a value", () => {
    test("without a terminal it lists the harnesses and asks nothing", async () => {
        const select = spyOn(prompts, "select");
        try {
            const { exitCode, errors } = await withStdinTTY(false, () =>
                run(["sessions", "tail", "session-1", "--provider"])
            );
            expect(exitCode).toBe(1);
            expect(errors.join("\n")).toContain("claude");
            expect(select).not.toHaveBeenCalled();
        } finally {
            select.mockRestore();
        }
    });

    test("in a terminal the picked harness reaches the transcript read", async () => {
        const select = spyOn(prompts, "select").mockResolvedValue("codex");
        const read = spyOn(door, "runTranscriptDoor").mockResolvedValue(undefined);
        try {
            const { exitCode, errors } = await withStdinTTY(true, () =>
                run(["sessions", "tail", "session-1", "--provider"])
            );
            expect({ exitCode, errors }).toEqual({ exitCode: 0, errors: [] });
            expect(select).toHaveBeenCalledTimes(1);
            expect(read).toHaveBeenCalledWith(expect.objectContaining({ provider: "codex", query: "session-1" }));
        } finally {
            select.mockRestore();
            read.mockRestore();
        }
    });

    test("a cancelled pick reads no transcript", async () => {
        const select = spyOn(prompts, "select").mockResolvedValue(promptCancelSymbol);
        const read = spyOn(door, "runTranscriptDoor").mockResolvedValue(undefined);
        try {
            const { exitCode, errors } = await withStdinTTY(true, () =>
                run(["sessions", "tail", "session-1", "--provider"])
            );
            expect({ exitCode, errors }).toEqual({ exitCode: 0, errors: [] });
            expect(select).toHaveBeenCalledTimes(1);
            expect(read).not.toHaveBeenCalled();
        } finally {
            select.mockRestore();
            read.mockRestore();
        }
    });
});

describe("sessions range flags", () => {
    test("cold comparison medians average the two middle values of an even count", () => {
        const sample = { expected: 10, gapMs: 600_000, hit: false, rewriteUsd: null, followUsd: null };
        const comparison = coldComparison(
            { edges: new Map(), samples: [1, 9].map((calls) => ({ ...sample, calls })) },
            { priceModel: "fixture-unpriced", freshStart: 0, idleSeconds: 295 }
        );
        expect(comparison.bands).toMatchObject([{ resumes: 2, medianCalls: 5, medianRewriteUsd: null }]);
    });
    test("context and resumes list the harnesses for an unknown --provider", async () => {
        for (const sub of ["context", "resumes"]) {
            const { exitCode, errors } = await run(["sessions", sub, "some-id", "--provider", "nope"]);
            expect(exitCode).toBe(1);
            expect(errors.join("\n")).toContain('does not accept "nope"');
            expect(errors.join("\n")).toContain("claude");
        }
    });
    test("cold comparison reads the resumed agent and makes an unknown comparison price explicit", async () => {
        const root = mkdtempSync(join(tmpdir(), "cold-cli-"));
        const path = join(root, "session.jsonl");
        writeFileSync(path, "");
        const agents = join(root, "session", "subagents");
        mkdirSync(agents, { recursive: true });
        writeFileSync(
            join(agents, "agent-helper.jsonl"),
            [0, 7]
                .map((minute) =>
                    SafeJSON.stringify({
                        type: "assistant",
                        timestamp: new Date(minute * 60_000).toISOString(),
                        message: {
                            id: `call-${minute}`,
                            model: "fixture",
                            stop_reason: "end_turn",
                            usage: { cache_creation: { ephemeral_5m_input_tokens: 100 } },
                        },
                    })
                )
                .join("\n")
        );
        const output = spyOn(out, "println").mockImplementation(() => {});
        try {
            expect(
                (
                    await run([
                        "sessions",
                        "resumes",
                        path,
                        "--provider",
                        "claude",
                        "--no-main",
                        "--cold",
                        "--price-model",
                        "fixture-unpriced",
                    ])
                ).errors
            ).toEqual([]);
            const rendered = output.mock.calls.flat().join("\n");
            expect(rendered).toContain("Cold resumes after 295s: 1");
            expect(rendered).toContain("no price for fixture-unpriced");
        } finally {
            output.mockRestore();
        }

        const result = spyOn(out, "result").mockImplementation(() => {});
        try {
            const args = ["sessions", "resumes", path, "--provider", "claude", "--no-main", "--cold", "--json"];
            expect((await run([...args, "--idle-seconds", "600", "--price-model", "fixture-unpriced"])).errors).toEqual(
                []
            );
            expect(result.mock.calls[0]?.[0]).toMatchObject({
                cold: { idleSeconds: 600, resumes: 0, bands: [], fresh: null },
            });
            expect(result.mock.calls[0]?.[0]).not.toHaveProperty("sessions");
            expect((await run([...args, "--price-model", "fixture-unpriced"])).errors).toEqual([]);
            expect(result.mock.calls[1]?.[0]).toMatchObject({
                cold: {
                    idleSeconds: 295,
                    resumes: 1,
                    bands: [{ from: 0, resumes: 1 }],
                    fresh: { priced: false, reason: "no price for fixture-unpriced" },
                },
            });
        } finally {
            result.mockRestore();
        }
    });
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
                    { line: 0, carry: 9 },
                    { loop: "session", line: 1, carry: 1 },
                ],
            });
            expect(result.mock.calls[0]?.[0]).not.toHaveProperty("metrics");

            const [one, two] = ["session-one", "session-two"].map((name) => join(dir, `${name}.jsonl`));
            writeFileSync(one, readFileSync(path, "utf8"));
            writeFileSync(two, readFileSync(path, "utf8"));
            const exported = join(dir, "exported");
            const args = ["sessions", "context", one, two, "--provider", "claude", "--json", "--out", exported];
            expect((await run(args)).errors).toEqual([]);
            expect(readdirSync(exported).sort()).toEqual([
                "claude-session-one.context-sources.json",
                "claude-session-one.context-sources.txt",
                "claude-session-two.context-sources.json",
                "claude-session-two.context-sources.txt",
            ]);

            const otherHome = join(dir, "other-home");
            mkdirSync(otherHome);
            const twin = join(otherHome, "session-one.jsonl");
            writeFileSync(twin, readFileSync(path, "utf8"));
            const twins = join(dir, "twins");
            const twinArgs = ["sessions", "context", one, one, twin, "--provider", "claude", "--json", "--out", twins];
            expect((await run(twinArgs)).errors).toEqual([]);
            expect(readdirSync(twins).filter((name) => name.endsWith(".json"))).toHaveLength(2);
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
                    input: 0,
                    cacheWrite: 0,
                    output: 0,
                    estimatedAtSegmentEnds: 0,
                    measuredAtSegmentEnds: 0,
                    excluded: {},
                    bashResults: { count: 0, tokens: 0, bigCount: 0, bigTokens: 0 },
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
        expect(tail.errors).toEqual([expect.stringContaining('--provider does not accept "x". Possible: claude')]);

        const grep = await run(["sessions", "grep", "session-1", "", "--limit", "5"]);
        expect(grep.errors).toEqual(["<query> must not be empty"]);
    });
});
