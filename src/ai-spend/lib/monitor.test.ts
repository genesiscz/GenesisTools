import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { Storage } from "@genesiscz/utils/storage/storage";
import { setupStorageSandbox } from "@genesiscz/utils/storage/test-sandbox";
import { claudeDriver, codexDriver, grokDriver } from "./drivers";
import { isolateAgentHomeEnv } from "./drivers/test-env";
import { buildMonitorReport, findRecentTranscripts, localDayString, type MonitorReport, mondayOfWeek } from "./monitor";
import { DEFAULT_PRICING } from "./pricing";
import type { PricingTable } from "./types";

setupStorageSandbox();
// CLAUDE_CONFIG_DIR / CODEX_HOME / GROK_HOME would drag real transcript trees
// into every fixture-home assertion below.
isolateAgentHomeEnv();

// claude-3-5-haiku (literal legacy rates): input $0.8/M, output $4/M, cacheWrite $1.0/M, cacheRead $0.08/M.
const MODEL = "claude-3-5-haiku";

function line(id: string, iso: string, usage: Record<string, number>): string {
    return `${SafeJSON.stringify({
        type: "assistant",
        timestamp: iso,
        cwd: "/tmp/proj",
        sessionId: "s1",
        message: { id, model: MODEL, usage },
    })}\n`;
}

describe("local time helpers", () => {
    test("localDayString uses local clock fields", () => {
        expect(localDayString(new Date(2026, 0, 5, 0, 30))).toBe("2026-01-05");
        expect(localDayString(new Date(2026, 11, 31, 23, 59))).toBe("2026-12-31");
    });

    test("mondayOfWeek returns the local Monday midnight (Monday week start)", () => {
        // 2026-08-27 is a Thursday; 2026-08-30 a Sunday — both map to Monday 2026-08-24.
        expect(localDayString(mondayOfWeek(new Date(2026, 7, 27, 15, 0)))).toBe("2026-08-24");
        expect(localDayString(mondayOfWeek(new Date(2026, 7, 30, 1, 0)))).toBe("2026-08-24");
        // A Monday maps to itself.
        expect(localDayString(mondayOfWeek(new Date(2026, 7, 24, 0, 0)))).toBe("2026-08-24");
        const monday = mondayOfWeek(new Date(2026, 7, 27, 15, 42));
        expect([monday.getHours(), monday.getMinutes()]).toEqual([0, 0]);
    });
});

describe("monitor report", () => {
    let home: string;
    let mainFile: string;
    let oldFile: string;

    // The suite writes real transcript trees; leaving them behind accumulates
    // across runs and lets one run's files leak into the next one's roots.
    afterEach(() => {
        rmSync(home, { recursive: true, force: true });
    });

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "ai-spend-monitor-"));
        const projDir = join(home, ".claude", "projects", "p1");
        const subDir = join(projDir, "subagents");
        const cfgDir = join(home, ".config", "claude", "projects", "p2");
        mkdirSync(subDir, { recursive: true });
        mkdirSync(cfgDir, { recursive: true });

        const now = new Date();
        const iso = now.toISOString();
        mainFile = join(projDir, "s1.jsonl");
        // msg-a duplicated with huge usage — dedup must keep the first.
        writeFileSync(
            mainFile,
            line("msg-a", iso, { input_tokens: 1_000_000 }) +
                line("msg-a", iso, { input_tokens: 999_000_000 }) +
                line("msg-b", iso, { output_tokens: 500_000, cache_read_input_tokens: 1_000_000 })
        );
        // Subagent transcript nests deeper — must be found by recursion.
        writeFileSync(join(subDir, "sub.jsonl"), line("msg-c", iso, { output_tokens: 100_000 }));
        // Second root: ~/.config/claude/projects.
        writeFileSync(join(cfgDir, "x.jsonl"), line("msg-d", iso, { input_tokens: 250_000 }));

        // A transcript last touched WAY before the week start must never be opened.
        oldFile = join(projDir, "old.jsonl");
        writeFileSync(oldFile, line("msg-old", "2026-01-01T10:00:00Z", { output_tokens: 900_000_000 }));
        const old = new Date("2026-01-02T00:00:00Z");
        utimesSync(oldFile, old, old);
    });

    test("pins today/week numbers, skips the old file, recurses both roots", () => {
        const opened: string[] = [];
        const report = buildMonitorReport({
            home,
            pricing: DEFAULT_PRICING,
            storage: new Storage("ai-spend"),
            sweepTtlMs: 0,
            readTailFn: (path, _offset, _size) => {
                opened.push(path);

                return readFileSync(path, "utf8");
            },
        });

        // msg-a: 1M input = $0.80 · msg-b: 0.5M out = $2.00 + 1M cacheRead = $0.08
        // msg-c: 0.1M out = $0.40 · msg-d: 0.25M input = $0.20 → $3.48 total
        expect(report.today.cost).toBeCloseTo(3.48, 5);
        expect(report.today.tokens).toBe(2_850_000);
        // Every fixture event is stamped "now", so week == today.
        expect(report.week).toEqual(report.today);
        expect(report.todayDate).toBe(localDayString(new Date()));
        expect(report.weekStart).toBe(localDayString(mondayOfWeek(new Date())));
        expect(report.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);

        // The stale file was never opened (mtime pruning), and 3 recent files were.
        expect(opened.some((p) => p.includes("old.jsonl"))).toBe(false);
        expect(report.recentFiles).toBe(3);
        expect(report.parsedFiles).toBe(3);
    });

    test("second run is a full cache hit; appended lines parse only the tail", () => {
        buildMonitorReport({ home, pricing: DEFAULT_PRICING, storage: new Storage("ai-spend"), sweepTtlMs: 0 });

        const second = buildMonitorReport({
            home,
            pricing: DEFAULT_PRICING,
            storage: new Storage("ai-spend"),
            sweepTtlMs: 0,
        });
        expect(second.parsedFiles).toBe(0);
        expect(second.today.cost).toBeCloseTo(3.48, 5);

        // Append one event → exactly one file re-parses, from a non-zero offset.
        const offsets: number[] = [];
        appendFileSync(mainFile, line("msg-e", new Date().toISOString(), { output_tokens: 1_000_000 }));

        const third = buildMonitorReport({
            home,
            pricing: DEFAULT_PRICING,
            storage: new Storage("ai-spend"),
            sweepTtlMs: 0,
            readTailFn: (path, offset, _size) => {
                offsets.push(offset);

                return readFileSync(path, "utf8").slice(offset);
            },
        });
        expect(third.parsedFiles).toBe(1);
        expect(offsets).toHaveLength(1);
        expect(offsets[0]).toBeGreaterThan(0);
        expect(third.today.cost).toBeCloseTo(3.48 + 4.0, 5);
        expect(third.today.tokens).toBe(3_850_000);
    });

    test("fast path within sweep TTL catches appends, new siblings, and new project dirs", () => {
        const storage = new Storage("ai-spend");
        const iso = new Date().toISOString();
        // Rebase the cache on THIS home with a forced sweep, then stay inside the TTL.
        buildMonitorReport({ home, pricing: DEFAULT_PRICING, storage, sweepTtlMs: 0 });

        appendFileSync(mainFile, line("msg-f", iso, { output_tokens: 1_000_000 }));
        writeFileSync(
            join(home, ".claude", "projects", "p1", "s2.jsonl"),
            line("msg-g", iso, { input_tokens: 1_000_000 })
        );
        const p3 = join(home, ".claude", "projects", "p3");
        mkdirSync(p3, { recursive: true });
        writeFileSync(join(p3, "y.jsonl"), line("msg-h", iso, { input_tokens: 500_000 }));

        const second = buildMonitorReport({ home, pricing: DEFAULT_PRICING, storage, sweepTtlMs: 60 * 60 * 1000 });
        expect(second.parsedFiles).toBe(3);
        // +$4.00 append, +$0.80 sibling, +$0.40 new project dir on top of $3.48.
        expect(second.today.cost).toBeCloseTo(8.68, 5);
        expect(second.today.tokens).toBe(2_850_000 + 1_000_000 + 1_000_000 + 500_000);
    });

    test("the claude roots and findRecentTranscripts never look outside the fixed roots", () => {
        const roots = claudeDriver.roots(home);
        expect(roots).toEqual([join(home, ".claude", "projects"), join(home, ".config", "claude", "projects")]);

        const files = findRecentTranscripts(roots, Date.now() - 60_000, claudeDriver);
        expect(files.every((f) => f.startsWith(roots[0]) || f.startsWith(roots[1]))).toBe(true);
        expect(files.some((f) => f.endsWith("old.jsonl"))).toBe(false);
    });

    test("a timestamp-less record does not burn its id for the real record that follows", () => {
        const iso = new Date().toISOString();
        // Claude Code rewrites a streaming message in place, so the same id can appear
        // first without a timestamp and again complete. Counting the first one into the
        // dedup frontier would make the second — the billable one — invisible forever.
        writeFileSync(
            join(home, ".claude", "projects", "p1", "stream.jsonl"),
            `${SafeJSON.stringify({
                type: "assistant",
                cwd: "/tmp/proj",
                sessionId: "s9",
                message: { id: "msg-stream", model: MODEL, usage: { output_tokens: 250_000 } },
            })}\n${line("msg-stream", iso, { output_tokens: 250_000 })}`
        );

        const report = buildMonitorReport({
            home,
            pricing: DEFAULT_PRICING,
            storage: new Storage("ai-spend"),
            sweepTtlMs: 0,
        });

        // 0.25M output at $4/M = $1.00, counted exactly once on top of the $3.48 fixture.
        expect(report.today.cost).toBeCloseTo(4.48, 5);
        expect(report.today.tokens).toBe(2_850_000 + 250_000);
    });
});

describe("multi-agent monitor report", () => {
    let home: string;

    afterEach(() => {
        rmSync(home, { recursive: true, force: true });
    });

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "ai-spend-agents-"));
        const iso = new Date().toISOString();

        const claudeDir = join(home, ".claude", "projects", "p1");
        mkdirSync(claudeDir, { recursive: true });
        // 1M input on claude-3-5-haiku = $0.80.
        writeFileSync(join(claudeDir, "s1.jsonl"), line("msg-a", iso, { input_tokens: 1_000_000 }));

        const codexDir = join(home, ".codex", "sessions", "2026", "08", "27");
        mkdirSync(codexDir, { recursive: true });
        // gpt-5: $1.25 in · $10 out · $0.125 cacheRead per Mtok.
        // 1M uncached in + 1M cacheRead + 0.1M out = 1.25 + 0.125 + 1.00 = $2.375
        writeFileSync(
            join(codexDir, "rollout-2026-08-27T09-00-00-synthetic.jsonl"),
            `${SafeJSON.stringify({
                timestamp: iso,
                type: "turn_context",
                payload: { turn_id: "t1", cwd: "/tmp/proj", model: "gpt-5" },
            })}\n${SafeJSON.stringify({
                timestamp: iso,
                type: "event_msg",
                payload: {
                    type: "token_count",
                    info: {
                        total_token_usage: {
                            input_tokens: 2_000_000,
                            cached_input_tokens: 1_000_000,
                            output_tokens: 100_000,
                            total_tokens: 2_100_000,
                        },
                        last_token_usage: {
                            input_tokens: 2_000_000,
                            cached_input_tokens: 1_000_000,
                            output_tokens: 100_000,
                            total_tokens: 2_100_000,
                        },
                    },
                },
            })}\n`
        );

        const grokDir = join(home, ".grok", "sessions", "%2Ftmp%2Fproj", "sess-grok-1");
        mkdirSync(grokDir, { recursive: true });
        // 500_000_000 ticks / 1e10 = $0.05, recorded by grok itself.
        writeFileSync(
            join(grokDir, "updates.jsonl"),
            `${SafeJSON.stringify({
                timestamp: Math.floor(Date.now() / 1000),
                method: "_x.ai/session/update",
                params: {
                    sessionId: "sess-grok-1",
                    update: {
                        sessionUpdate: "turn_completed",
                        usage: {
                            modelUsage: {
                                "grok-4.6-build": {
                                    inputTokens: 100_000,
                                    outputTokens: 2_000,
                                    cachedReadTokens: 60_000,
                                    costUsdTicks: 500_000_000,
                                },
                            },
                        },
                    },
                    _meta: { eventId: "evt-1", agentTimestampMs: Date.now() },
                },
            })}\n`
        );
        // events.jsonl sits next to it and must never be read.
        writeFileSync(join(grokDir, "events.jsonl"), `${SafeJSON.stringify({ nonsense: true })}\n`);
    });

    test("splits today/week per agent and sums them at the top level", () => {
        const opened: string[] = [];
        const report = buildMonitorReport({
            home,
            pricing: DEFAULT_PRICING,
            storage: new Storage("ai-spend"),
            sweepTtlMs: 0,
            readTailFn: (path, _offset, _size) => {
                opened.push(path);

                return readFileSync(path, "utf8");
            },
        });

        expect(report.agents.claude.today.cost).toBeCloseTo(0.8, 6);
        expect(report.agents.claude.today.tokens).toBe(1_000_000);
        expect(report.agents.codex.today.cost).toBeCloseTo(2.375, 6);
        expect(report.agents.codex.today.tokens).toBe(2_100_000);
        expect(report.agents.grok.today.cost).toBeCloseTo(0.05, 8);
        expect(report.agents.grok.today.tokens).toBe(102_000);

        expect(report.today.cost).toBeCloseTo(0.8 + 2.375 + 0.05, 6);
        expect(report.today.tokens).toBe(1_000_000 + 2_100_000 + 102_000);
        expect(report.week).toEqual(report.today);

        // One transcript per agent, and grok's events.jsonl was never opened.
        expect(report.recentFiles).toBe(3);
        expect(report.parsedFiles).toBe(3);
        expect(opened.some((path) => path.endsWith("events.jsonl"))).toBe(false);
    });

    test("the cache is keyed per agent — a second run parses nothing", () => {
        const storage = new Storage("ai-spend");
        const run = (): MonitorReport => buildMonitorReport({ home, pricing: DEFAULT_PRICING, storage, sweepTtlMs: 0 });

        const first = run();
        const second = run();

        expect(second.parsedFiles).toBe(0);
        expect(second.today.cost).toBeCloseTo(first.today.cost, 10);
        expect(second.agents).toEqual(first.agents);
    });

    test("a driver subset reports only the agents it scanned, never stale cached ones", () => {
        const storage = new Storage("ai-spend");
        const all = buildMonitorReport({ home, pricing: DEFAULT_PRICING, storage, sweepTtlMs: 0 });
        expect(all.agents.codex.today.tokens).toBe(2_100_000);
        expect(all.agents.grok.today.tokens).toBe(102_000);

        // Codex and Grok day sums are now cached. Asking for claude alone must not
        // report them, and must not fold them into the top-level totals either.
        const claudeOnly = buildMonitorReport({
            home,
            pricing: DEFAULT_PRICING,
            storage,
            sweepTtlMs: 0,
            drivers: [claudeDriver],
        });

        expect(claudeOnly.agents.codex).toEqual({ today: { cost: 0, tokens: 0 }, week: { cost: 0, tokens: 0 } });
        expect(claudeOnly.agents.grok).toEqual({ today: { cost: 0, tokens: 0 }, week: { cost: 0, tokens: 0 } });
        expect(claudeOnly.today.cost).toBeCloseTo(0.8, 6);
        expect(claudeOnly.today.tokens).toBe(1_000_000);
    });

    test("a tail ending mid-line is re-read whole once the writer completes it", () => {
        const storage = new Storage("ai-spend");
        const codexFile = join(
            home,
            ".codex",
            "sessions",
            "2026",
            "08",
            "27",
            "rollout-2026-08-27T09-00-00-synthetic.jsonl"
        );
        const iso = new Date().toISOString();
        const nextEvent = SafeJSON.stringify({
            timestamp: iso,
            type: "event_msg",
            payload: {
                type: "token_count",
                info: {
                    total_token_usage: {
                        input_tokens: 3_000_000,
                        cached_input_tokens: 1_000_000,
                        output_tokens: 100_000,
                    },
                    last_token_usage: { input_tokens: 1_000_000, output_tokens: 0, total_tokens: 1_000_000 },
                },
            },
        });

        buildMonitorReport({ home, pricing: DEFAULT_PRICING, storage, sweepTtlMs: 0, drivers: [codexDriver] });

        // Append HALF of a line, exactly as a stat landing mid-write would observe.
        const split = Math.floor(nextEvent.length / 2);
        appendFileSync(codexFile, nextEvent.slice(0, split));

        const partial = buildMonitorReport({
            home,
            pricing: DEFAULT_PRICING,
            storage,
            sweepTtlMs: 0,
            drivers: [codexDriver],
        });
        // The fragment is not parseable, so nothing new is counted yet.
        expect(partial.agents.codex.today.tokens).toBe(2_100_000);

        // The writer finishes the line. Its FIRST half must not have been consumed.
        appendFileSync(codexFile, `${nextEvent.slice(split)}\n`);

        const complete = buildMonitorReport({
            home,
            pricing: DEFAULT_PRICING,
            storage,
            sweepTtlMs: 0,
            drivers: [codexDriver],
        });
        // +1M uncached input on gpt-5 = +$1.25 on top of $2.375.
        expect(complete.agents.codex.today.tokens).toBe(2_100_000 + 1_000_000);
        expect(complete.agents.codex.today.cost).toBeCloseTo(2.375 + 1.25, 6);
    });

    test("grok's roots follow GROK_HOME even when the fixture home has its own tree", () => {
        expect(grokDriver.roots(home)).toEqual([join(home, ".grok", "sessions")]);
        expect(codexDriver.roots(home)).toEqual([
            join(home, ".codex", "sessions"),
            join(home, ".codex", "archived_sessions"),
        ]);
    });
});

/**
 * Regression test: the monitor path never called resolvePrice, so it billed every
 * event at the catalog's list rate and ignored the dated promotions and
 * long-context bands aggregate.ts already honoured. `ModelPriceEntry` extends
 * `ModelPrice`, so dropping the rules type-checked silently.
 *
 * Drives buildMonitorReport, not resolvePrice — a test of the resolver alone
 * would pass both before and after the fix.
 */
describe("monitor honours dated and context-banded pricing", () => {
    let home: string;

    afterEach(() => {
        rmSync(home, { recursive: true, force: true });
    });

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "ai-spend-rules-"));
        const projDir = join(home, ".claude", "projects", "p1");
        mkdirSync(projDir, { recursive: true });
        writeFileSync(join(projDir, "s1.jsonl"), line("msg-r", new Date().toISOString(), { input_tokens: 1_000_000 }));
    });

    test("a dated rule beats the list rate for an event inside its window", () => {
        // List rate $100/1M; a rule in force since 2020 drops input to $1/1M.
        const ruled: PricingTable = {
            [MODEL]: {
                input: 100,
                output: 100,
                cacheWrite: 100,
                cacheRead: 100,
                rules: [{ from: "2020-01-01", inputPer1M: 1, outputPer1M: 1 }],
            },
        };

        const report = buildMonitorReport({
            home,
            pricing: ruled,
            storage: new Storage("ai-spend"),
            sweepTtlMs: 0,
            readTailFn: (path) => readFileSync(path, "utf8"),
        });

        // 1M input tokens: $1 under the rule, $100 if the rules are dropped.
        expect(report.today.cost).toBeCloseTo(1, 5);
    });
});
