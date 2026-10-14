import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { workerTurnLogPath } from "@app/claude/lib/worker/paths";
import { ClaudeWorkerStore } from "@app/claude/lib/worker/store";
import { turnLogPath } from "@app/grok/lib/paths";
import { GrokSessionStore } from "@app/grok/lib/store";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { findCodexRollout } from "@genesiscz/utils/session-changes/codex";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { Storage } from "@genesiscz/utils/storage/storage";
import { withTimeZone } from "@genesiscz/utils/test/timezone";
import { aggregate } from "./lib/aggregate";
import { loadPricing } from "./lib/config";
import { isolateAgentHomeEnv } from "./lib/drivers/test-env";
import { parseTranscriptLine } from "./lib/parse";
import { costOf, DEFAULT_PRICING, priceFor, resolvePrice } from "./lib/pricing";
import { toUsageEvent, transcriptCutoffMs } from "./lib/register";
import { renderSummary } from "./lib/render";
import { resolveSessionFlag } from "./lib/reports/commands";
import { loadEvents } from "./lib/reports/load";
import { loadEventsParallel } from "./lib/reports/load-parallel";
import type { SpendEvent } from "./lib/reports/types";
import { walkFiles } from "./lib/reports/walk";
import { resolveSince } from "./lib/since";
import type { UsageEvent } from "./lib/types";
import { planWorkerBackfill, planWorkerReprice } from "./lib/workers/backfill";
import { formatCostLine, formatUsd, workerCostCard } from "./lib/workers/cost";
import {
    appendWorkerCostRows,
    bookedCostLine,
    buildWorkerCostRow,
    isStalePrice,
    readWorkerCostLedger,
    readWorkerCostRows,
    recordWorkerTurnCost,
    rewriteWorkerCostRows,
    sessionCostSummary,
    WORKER_PRICING_VERSION,
    type WorkerCostRow,
    workerCostLedgerPath,
} from "./lib/workers/ledger";
import type { WorkerSessionInfo } from "./lib/workers/sessions";
import { buildWorkerStats } from "./lib/workers/stats";

describe("parseTranscriptLine", () => {
    const assistantLine = SafeJSON.stringify({
        type: "assistant",
        timestamp: "2026-06-01T09:52:38.815Z",
        cwd: "/Users/x/Projects/Foo",
        sessionId: "sess-1",
        message: {
            id: "msg_abc",
            model: "claude-opus-4-8",
            usage: {
                input_tokens: 100,
                output_tokens: 20,
                cache_creation_input_tokens: 300,
                cache_read_input_tokens: 4000,
                iterations: [{ input_tokens: 100, output_tokens: 20 }],
            },
        },
    });

    it("extracts a UsageEvent from an assistant line", () => {
        const ev = parseTranscriptLine(assistantLine);
        expect(ev).not.toBeNull();
        expect(ev?.messageId).toBe("msg_abc");
        expect(ev?.model).toBe("claude-opus-4-8");
        expect(ev?.project).toBe("/Users/x/Projects/Foo");
        expect(ev?.inputTokens).toBe(100);
        expect(ev?.outputTokens).toBe(20);
        expect(ev?.cacheCreationTokens).toBe(300);
        expect(ev?.cacheReadTokens).toBe(4000);
    });

    it("keeps the one-hour share of the cache writes, which bills at 2x input", () => {
        const line = SafeJSON.stringify({
            type: "assistant",
            message: {
                id: "msg_1h",
                model: "claude-opus-5",
                usage: {
                    input_tokens: 24,
                    output_tokens: 11_471,
                    cache_creation_input_tokens: 106_816,
                    cache_read_input_tokens: 1_012_946,
                    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 106_816 },
                },
            },
        });
        const ev = parseTranscriptLine(line);

        expect(ev?.cacheCreationTokens).toBe(106_816);
        expect(ev?.cacheCreation1hTokens).toBe(106_816);
        // claude-opus-5 at $5 / $25 / $0.50 read / $10 one-hour write: Claude Code's own $1.861528.
        expect(ev && aggregate({ events: [ev], pricing: DEFAULT_PRICING, now: new Date() }).total.cost).toBeCloseTo(
            1.861528,
            6
        );
    });

    it("returns null for non-assistant lines", () => {
        expect(parseTranscriptLine(SafeJSON.stringify({ type: "user", message: {} }))).toBeNull();
    });

    it("returns null for assistant lines without usage", () => {
        expect(
            parseTranscriptLine(SafeJSON.stringify({ type: "assistant", message: { id: "m", model: "x" } }))
        ).toBeNull();
    });

    it("returns null for malformed JSON", () => {
        expect(parseTranscriptLine("{not json")).toBeNull();
        expect(parseTranscriptLine("")).toBeNull();
    });

    it("returns null for a bare null line instead of throwing", () => {
        expect(parseTranscriptLine("null")).toBeNull();
    });
});

describe("pricing", () => {
    it("prices the four token classes separately", () => {
        const price = { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 };
        const cost = costOf(
            { input: 1_000_000, output: 1_000_000, cacheWrite: 1_000_000, cacheRead: 1_000_000 },
            price
        );
        expect(cost).toBeCloseTo(15 + 75 + 18.75 + 1.5, 6);
    });

    it("knows the canonical Claude models", () => {
        expect(priceFor("claude-opus-4-8", DEFAULT_PRICING)).not.toBeNull();
        expect(priceFor("claude-sonnet-4-6", DEFAULT_PRICING)).not.toBeNull();
    });

    it("folds dated variant ids onto their base model, never open-ended prefixes", () => {
        expect(priceFor("claude-opus-4-8-20260101", DEFAULT_PRICING)).not.toBeNull();
        expect(priceFor("claude-3-5-haiku-20241022", DEFAULT_PRICING)).not.toBeNull();
        // no family-prefix bleed: unknown sibling ids stay unpriced
        expect(priceFor("claude-opus-4-85", DEFAULT_PRICING)).toBeNull();
    });

    it("returns null for genuinely unknown models", () => {
        expect(priceFor("glm-4.6", DEFAULT_PRICING)).toBeNull();
    });

    it("carries the catalog's rules through instead of flattening them away", () => {
        // claude-opus-5-5 bills Fast mode at twice the standard rate through a service-tier rule.
        const entry = priceFor("claude-opus-5-5", DEFAULT_PRICING);
        expect(entry?.rules?.length).toBeGreaterThan(0);

        const standard = resolvePrice(entry!, {});
        const fast = resolvePrice(entry!, { serviceTier: "fast" });

        expect({ input: standard.input, output: standard.output }).toEqual({ input: 4, output: 20 });
        expect({ input: fast.input, output: fast.output }).toEqual({ input: 8, output: 40 });
    });

    it("prices claude-sonnet-5 at the permanent $2/$10, with no rule that expires it", () => {
        const entry = priceFor("claude-sonnet-5", DEFAULT_PRICING);

        expect(entry?.rules ?? []).toEqual([]);
        expect(resolvePrice(entry!, { at: new Date("2026-09-24T00:00:00.000Z") })).toMatchObject({
            input: 2,
            output: 10,
        });
    });

    it("applies a long-context band to the request that is actually large", () => {
        const entry = priceFor("claude-sonnet-4-5-20250929", DEFAULT_PRICING);
        expect(entry?.rules?.length).toBeGreaterThan(0);

        const small = resolvePrice(entry!, { contextTokens: 1000 });
        const large = resolvePrice(entry!, { contextTokens: 250_000 });

        expect(large.input).toBeGreaterThan(small.input);
        expect(large.input).toBe(6);
    });

    it("a model with no rules resolves to its flat rates unchanged", () => {
        const entry = priceFor("claude-opus-4-8", DEFAULT_PRICING);

        expect(resolvePrice(entry!, { at: new Date() })).toEqual(entry!);
    });
});

describe("resolveSince", () => {
    const now = new Date("2026-06-02T12:00:00.000Z");

    it("parses Nd as N days back (UTC day)", () => {
        expect(resolveSince("7d", now)).toBe("2026-05-26");
        expect(resolveSince("0d", now)).toBe("2026-06-02");
    });

    it("passes through a YYYY-MM-DD literal", () => {
        expect(resolveSince("2026-05-01", now)).toBe("2026-05-01");
    });

    it("defaults nonsense to undefined (caller applies its own default)", () => {
        expect(resolveSince("garbage", now)).toBeUndefined();
    });

    it("rejects shape-valid but impossible dates", () => {
        expect(resolveSince("2026-02-30", now)).toBeUndefined();
        expect(resolveSince("2026-13-01", now)).toBeUndefined();
    });
});

function ev(over: Partial<UsageEvent>): UsageEvent {
    return {
        messageId: "m",
        model: "claude-opus-4-8",
        timestamp: "2026-06-01T10:00:00.000Z",
        project: "/p/Foo",
        sessionId: "s1",
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        ...over,
    };
}

describe("aggregate", () => {
    const now = new Date("2026-06-02T00:00:00.000Z");

    it("dedups by messageId — identical triplicate events count once", () => {
        const dup = ev({ messageId: "dup", inputTokens: 100, outputTokens: 10 });
        const report = aggregate({ events: [dup, { ...dup }, { ...dup }], pricing: DEFAULT_PRICING, now });
        expect(report.total.tokens.input).toBe(100);
        expect(report.total.tokens.output).toBe(10);
    });

    it("computes four-component cost against hand numbers (two models, two days)", () => {
        const events: UsageEvent[] = [
            ev({
                messageId: "a",
                model: "claude-opus-4-8",
                timestamp: "2026-06-01T10:00:00.000Z",
                inputTokens: 1_000_000,
                outputTokens: 1_000_000,
                cacheCreationTokens: 1_000_000,
                cacheReadTokens: 1_000_000,
            }),
            ev({
                messageId: "b",
                model: "claude-sonnet-4-6",
                timestamp: "2026-06-02T10:00:00.000Z",
                inputTokens: 1_000_000,
                outputTokens: 0,
                cacheCreationTokens: 0,
                cacheReadTokens: 0,
            }),
        ];
        const report = aggregate({ events, pricing: DEFAULT_PRICING, now });
        // opus: 5+25+6.25+0.5 = 36.75 ; sonnet: 3 ; total 39.75
        expect(report.total.cost).toBeCloseTo(39.75, 6);
        expect(report.days.map((d) => d.day)).toEqual(["2026-06-01", "2026-06-02"]);
        expect(report.models.find((m) => m.model === "claude-opus-4-8")?.cost).toBeCloseTo(36.75, 6);
    });

    it("computes cache-hit rate = cacheRead / (input + cacheRead)", () => {
        const report = aggregate({
            events: [ev({ messageId: "c", inputTokens: 100, cacheReadTokens: 900 })],
            pricing: DEFAULT_PRICING,
            now,
        });
        expect(report.total.cacheHitRate).toBeCloseTo(0.9, 6);
    });

    it("counts tokens but $0 for an unpriced model, marked priced=false", () => {
        const report = aggregate({
            events: [ev({ messageId: "u", model: "glm-4.6", inputTokens: 5000 })],
            pricing: DEFAULT_PRICING,
            now,
        });
        const m = report.models.find((x) => x.model === "glm-4.6");
        expect(m?.priced).toBe(false);
        expect(m?.tokens.input).toBe(5000);
        expect(m?.cost).toBe(0);
        expect(report.total.cost).toBe(0);
    });

    it("applies since/model/project filters in-core", () => {
        const events: UsageEvent[] = [
            ev({ messageId: "old", timestamp: "2026-05-01T10:00:00.000Z", inputTokens: 1 }),
            ev({ messageId: "new", timestamp: "2026-06-01T10:00:00.000Z", inputTokens: 2 }),
            ev({ messageId: "other-proj", project: "/p/Bar", inputTokens: 4 }),
            ev({ messageId: "sonnet", model: "claude-sonnet-4-6", inputTokens: 8 }),
        ];
        const r = aggregate({
            events,
            pricing: DEFAULT_PRICING,
            now,
            sinceDay: "2026-05-15",
            project: "foo",
            model: "opus",
        });
        // keeps only events on/after 2026-05-15, project contains "foo", model contains "opus"
        expect(r.total.tokens.input).toBe(2);
    });

    it("UTC day keys are TZ-independent", () => {
        // `withTimeZone`, not `process.env.TZ = prev`: when TZ was never set, that
        // restore is a delete, which does NOT return the process to the system zone
        // and latches the zone against every later change. bun runs many files per
        // process, so this file used to leave UTC+14 behind for the rest of them.
        withTimeZone("Pacific/Kiritimati", () => {
            const r = aggregate({
                events: [ev({ messageId: "tz", timestamp: "2026-06-01T23:30:00.000Z", inputTokens: 1 })],
                pricing: DEFAULT_PRICING,
                now,
            });
            expect(r.days[0].day).toBe("2026-06-01");
        });
    });
});

describe("claude transcript discovery", () => {
    // The summary views read through `loadEvents`, the same stack the ccusage
    // reports use. `discover.ts` was a second one that saw only
    // `~/.claude/projects` and missed `~/.config/claude/projects`.
    isolateAgentHomeEnv();

    it("finds *.jsonl under <home>/.claude/projects and parses events", () => {
        const home = mkdtempSync(join(tmpdir(), "ai-spend-home-"));
        const projDir = join(home, ".claude", "projects", "-Users-x-Foo");
        mkdirSync(projDir, { recursive: true });
        const line = SafeJSON.stringify({
            type: "assistant",
            timestamp: "2026-06-01T10:00:00.000Z",
            cwd: "/Users/x/Foo",
            sessionId: "s1",
            message: { id: "m1", model: "claude-opus-4-8", usage: { input_tokens: 10, output_tokens: 2 } },
        });
        writeFileSync(join(projDir, "sess.jsonl"), `${line}\n{garbage}\n\n`);

        const events = loadEvents({ home, sources: ["claude"] });
        expect(events.length).toBe(1);
        expect(events[0].id).toBe("m1");
        expect(events[0].project).toBe("/Users/x/Foo");
    });

    it("also reads the second root, which the old discover walk never saw", () => {
        const home = mkdtempSync(join(tmpdir(), "ai-spend-second-root-"));
        const cfgDir = join(home, ".config", "claude", "projects", "-Users-x-Bar");
        mkdirSync(cfgDir, { recursive: true });
        writeFileSync(
            join(cfgDir, "sess.jsonl"),
            `${SafeJSON.stringify({
                type: "assistant",
                timestamp: "2026-06-01T10:00:00.000Z",
                cwd: "/Users/x/Bar",
                sessionId: "s2",
                message: { id: "m2", model: "claude-opus-4-8", usage: { input_tokens: 5 } },
            })}\n`
        );

        expect(loadEvents({ home, sources: ["claude"] }).map((event) => event.id)).toEqual(["m2"]);
    });

    it("returns [] when the projects dir is absent", () => {
        const home = mkdtempSync(join(tmpdir(), "ai-spend-empty-"));
        expect(loadEvents({ home, sources: ["claude"] })).toEqual([]);
    });
});

describe("session-scoped loading (session --id)", () => {
    isolateAgentHomeEnv();

    const usageLine = (over: { id: string; sessionId: string; writtenBy?: string; sidechain?: boolean }): string =>
        SafeJSON.stringify({
            type: "assistant",
            timestamp: "2026-06-01T10:00:00.000Z",
            cwd: "/Users/x/Foo",
            sessionId: over.sessionId,
            ...(over.writtenBy ? { session_id: over.writtenBy } : {}),
            isSidechain: over.sidechain ?? false,
            message: { id: over.id, model: "claude-opus-4-8", usage: { input_tokens: 10, output_tokens: 2 } },
        });

    /**
     * `sess-work` owns a file, a subagent and a legacy `agent-*.jsonl`. The
     * other project holds `sess-personal`, whose file ALSO carries one line of
     * `sess-work` and one of a workflow run id no file is named after.
     */
    function claudeFixture(): { home: string; projects: string } {
        const home = mkdtempSync(join(tmpdir(), "ai-spend-session-"));
        const projects = join(home, ".claude", "projects");
        const own = join(projects, "-Users-x-Foo");
        const other = join(projects, "-Users-x-Bar");
        mkdirSync(join(own, "sess-work", "subagents"), { recursive: true });
        mkdirSync(join(other, "sess-personal", "subagents"), { recursive: true });
        writeFileSync(join(own, "sess-work.jsonl"), `${usageLine({ id: "m-main", sessionId: "sess-work" })}\n`);
        writeFileSync(
            join(own, "sess-work", "subagents", "agent-a1.jsonl"),
            `${usageLine({ id: "m-sub", sessionId: "sess-work", sidechain: true })}\n`
        );
        writeFileSync(
            join(own, "agent-legacy.jsonl"),
            `${usageLine({ id: "m-legacy", sessionId: "sess-work", sidechain: true })}\n`
        );
        writeFileSync(
            join(own, "agent-elsewhere.jsonl"),
            `${usageLine({ id: "m-other-legacy", sessionId: "sess-personal", sidechain: true })}\n`
        );
        writeFileSync(
            join(other, "sess-personal.jsonl"),
            [
                usageLine({ id: "m-personal", sessionId: "sess-personal" }),
                usageLine({ id: "m-copied", sessionId: "sess-work" }),
                usageLine({ id: "m-workflow", sessionId: "wf-run-1" }),
            ].join("\n")
        );
        writeFileSync(
            join(other, "sess-personal", "subagents", "agent-b1.jsonl"),
            `${usageLine({ id: "m-personal-sub", sessionId: "sess-personal", sidechain: true })}\n`
        );
        return { home, projects };
    }

    it("a fork bills only its own turns: a copied line keeps the parent's session_id", () => {
        const home = mkdtempSync(join(tmpdir(), "ai-spend-fork-"));
        const dir = join(home, ".claude", "projects", "-Users-x-Foo");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "sess-parent.jsonl"),
            `${usageLine({ id: "m-1", sessionId: "sess-parent", writtenBy: "sess-parent" })}\n`
        );
        writeFileSync(
            join(dir, "sess-fork.jsonl"),
            [
                usageLine({ id: "m-1", sessionId: "sess-fork", writtenBy: "sess-parent" }),
                usageLine({ id: "m-2", sessionId: "sess-fork", writtenBy: "sess-fork" }),
            ].join("\n")
        );

        expect(idsOf(loadEvents({ home, sources: ["claude"], sessionId: "sess-fork" }), "sess-fork")).toEqual(["m-2"]);
        expect(idsOf(loadEvents({ home, sources: ["claude"], sessionId: "sess-parent" }), "sess-parent")).toEqual([
            "m-1",
        ]);
    });

    /** Files read below `root` while `run` executes, relative and sorted. */
    function readsUnder(root: string, run: () => void): string[] {
        const spy = spyOn(fs, "readFileSync");

        try {
            run();
            return spy.mock.calls
                .map(([path]) => String(path))
                .filter((path) => path.startsWith(`${root}/`))
                .map((path) => path.slice(root.length + 1))
                .sort();
        } finally {
            spy.mockRestore();
        }
    }

    const idsOf = (events: SpendEvent[], sessionId: string): string[] =>
        events
            .filter((event) => event.sessionId === sessionId)
            .map((event) => event.id)
            .sort();

    it("reads only the session's file, its subagents and the legacy agent files beside it", () => {
        const { home, projects } = claudeFixture();
        let events: SpendEvent[] = [];
        const reads = readsUnder(projects, () => {
            events = loadEvents({ home, sources: ["claude"], sessionId: "sess-work" });
        });

        expect(idsOf(events, "sess-work")).toEqual(["m-legacy", "m-main", "m-sub"]);
        // A legacy agent file names its session only inside, so the ones beside the
        // session are read; nothing of the other project ever is.
        expect(reads).toEqual([
            "-Users-x-Foo/agent-elsewhere.jsonl",
            "-Users-x-Foo/agent-legacy.jsonl",
            "-Users-x-Foo/sess-work.jsonl",
            "-Users-x-Foo/sess-work/subagents/agent-a1.jsonl",
        ]);
    });

    it("the full walk still reads every transcript (the unscoped path is unchanged)", () => {
        const { home, projects } = claudeFixture();
        let events: SpendEvent[] = [];
        const reads = readsUnder(projects, () => {
            events = loadEvents({ home, sources: ["claude"] });
        });

        expect(reads).toHaveLength(6);
        // The line of `sess-work` inside another session's file: only the full walk sees it.
        expect(idsOf(events, "sess-work")).toEqual(["m-copied", "m-legacy", "m-main", "m-sub"]);
    });

    it("falls back to the full walk for an id no file is named after", () => {
        const { home } = claudeFixture();
        const events = loadEvents({ home, sources: ["claude"], sessionId: "wf-run-1" });

        expect(idsOf(events, "wf-run-1")).toEqual(["m-workflow"]);
    });

    it("an id a Codex rollout is named after never touches the Claude tree", () => {
        const { home, projects } = claudeFixture();
        const rollout = "rollout-2026-06-01T10-00-00-fixture";
        const dir = join(home, ".codex", "sessions", "2026", "06", "01");
        mkdirSync(dir, { recursive: true });
        const usage = { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10, reasoning_output_tokens: 0 };
        writeFileSync(
            join(dir, `${rollout}.jsonl`),
            [
                SafeJSON.stringify({
                    timestamp: "2026-06-01T10:00:00.000Z",
                    type: "turn_context",
                    payload: { cwd: "/tmp/proj", model: "gpt-5.6-sol" },
                }),
                SafeJSON.stringify({
                    timestamp: "2026-06-01T10:00:10.000Z",
                    type: "event_msg",
                    payload: { type: "token_count", info: { total_token_usage: usage, last_token_usage: usage } },
                }),
            ].join("\n")
        );
        let events: SpendEvent[] = [];
        const reads = readsUnder(projects, () => {
            events = loadEvents({ home, sessionId: rollout });
        });

        expect(reads).toEqual([]);
        expect(events.map((event) => [event.source, event.sessionId])).toEqual([["codex", rollout]]);
    });
});

describe("loadPricing", () => {
    it("merges user config pricing over defaults", async () => {
        const home = mkdtempSync(join(tmpdir(), "ai-spend-cfg-"));
        const prev = process.env.GENESIS_TOOLS_HOME;
        process.env.GENESIS_TOOLS_HOME = home;
        try {
            const storage = new Storage("ai-spend");
            await storage.setConfigValue("pricing", {
                "glm-4.6": { input: 1, output: 2, cacheWrite: 1, cacheRead: 0.1 },
            });
            const pricing = await loadPricing(storage);
            expect(pricing["glm-4.6"]).toEqual({ input: 1, output: 2, cacheWrite: 1, cacheRead: 0.1 });
            expect(pricing["claude-opus-4-8"]).toBeDefined();
        } finally {
            process.env.GENESIS_TOOLS_HOME = prev;
        }
    });
});

describe("renderSummary", () => {
    it("renders totals, model and project sections from a Report", () => {
        const report = aggregate({
            events: [
                ev({ messageId: "r1", model: "claude-opus-4-8", inputTokens: 1_000_000, outputTokens: 1_000_000 }),
                ev({ messageId: "r2", model: "glm-4.6", project: "/p/Bar", inputTokens: 1000 }),
            ],
            pricing: DEFAULT_PRICING,
            now: new Date("2026-06-02T00:00:00.000Z"),
        });
        const text = renderSummary(report);
        expect(text).toContain("TOTAL");
        expect(text).toContain("claude-opus-4-8");
        expect(text).toContain("(unpriced)");
    });
});

describe("session --id prefix", () => {
    isolateAgentHomeEnv();

    const match = (sessionId: string) => ({ sessionId, providerId: "anthropic-sub", title: "Fixture", mtime: 1 });

    const noRollout = () => null;

    it("resolves a unique prefix through the index, refuses an ambiguous one, and passes an unknown id through", () => {
        expect(
            resolveSessionFlag("aaaa", {
                resolve: () => ({ kind: "unique", sessionId: "aaaa-1", match: match("aaaa-1") }),
                findRollout: noRollout,
            })
        ).toEqual({
            id: "aaaa-1",
            note: "--id aaaa is session aaaa-1",
        });

        const ambiguous = resolveSessionFlag("bbbb", {
            resolve: () => ({ kind: "ambiguous", candidates: [match("bbbb-1"), match("bbbb-2")] }),
            findRollout: noRollout,
        });
        expect("error" in ambiguous && ambiguous.error).toContain("bbbb-2");
        expect(resolveSessionFlag("run-7", { resolve: () => ({ kind: "none" }), findRollout: noRollout })).toEqual({
            id: "run-7",
        });
        expect(
            resolveSessionFlag("full", {
                resolve: () => ({ kind: "exact", sessionId: "full" }),
                findRollout: noRollout,
            })
        ).toEqual({ id: "full" });
    });

    it("a Codex thread id, as the hub passes it, finds the usage keyed by its rollout's file name", () => {
        const home = mkdtempSync(join(tmpdir(), "ai-spend-codex-id-"));
        const thread = "0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
        const rollout = `rollout-2026-06-01T10-00-00-${thread}`;
        const dir = join(home, ".codex", "sessions", "2026", "06", "01");
        mkdirSync(dir, { recursive: true });
        const usage = { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10, reasoning_output_tokens: 0 };
        writeFileSync(
            join(dir, `${rollout}.jsonl`),
            [
                SafeJSON.stringify({
                    timestamp: "2026-06-01T10:00:00.000Z",
                    type: "turn_context",
                    payload: { cwd: "/tmp/proj", model: "gpt-5.6-sol" },
                }),
                SafeJSON.stringify({
                    timestamp: "2026-06-01T10:00:10.000Z",
                    type: "event_msg",
                    payload: { type: "token_count", info: { total_token_usage: usage, last_token_usage: usage } },
                }),
            ].join("\n")
        );

        const resolved = resolveSessionFlag(thread, {
            resolve: () => ({ kind: "exact", sessionId: thread }),
            findRollout: (id) => findCodexRollout(id, [join(home, ".codex")]),
        });
        const id = "error" in resolved ? "" : resolved.id;

        expect(loadEvents({ home, sources: ["codex"], sessionId: id }).map((event) => event.sessionId)).toEqual([
            rollout,
        ]);
    });
});

describe("toUsageEvent", () => {
    const now = new Date("2026-06-02T00:00:00.000Z");
    const grok: SpendEvent = {
        source: "grok",
        id: "same-id",
        model: "grok-unlisted-model",
        timestamp: "2026-06-01T10:00:00.000Z",
        sessionId: "s1",
        project: "/p",
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        recordedCostUsd: 0.42,
    };
    const claude: SpendEvent = { ...grok, source: "claude", model: "claude-opus-4-8", recordedCostUsd: undefined };
    const opus = (1000 * 5 + 500 * 25) / 1_000_000;

    it("keeps a recorded cost for a model no rate table lists", () => {
        const report = aggregate({ events: [toUsageEvent(grok, DEFAULT_PRICING)], pricing: DEFAULT_PRICING, now });

        expect(report.total.cost).toBeCloseTo(0.42, 9);
        expect(report.models[0].priced).toBe(true);
    });

    it("keeps the same id from two sources apart", () => {
        const events = [toUsageEvent(grok, DEFAULT_PRICING), toUsageEvent(claude, DEFAULT_PRICING)];
        const report = aggregate({ events, pricing: DEFAULT_PRICING, now });

        expect(report.total.totalTokens).toBe(3000);
        expect(report.total.cost).toBeCloseTo(0.42 + opus, 9);
    });

    it("prices an event with no recorded cost from the table, and leaves an unlisted model unpriced", () => {
        const unlisted = { ...claude, id: "u", model: "unlisted-model" };
        const report = aggregate({
            events: [toUsageEvent(claude, DEFAULT_PRICING), toUsageEvent(unlisted, DEFAULT_PRICING)],
            pricing: DEFAULT_PRICING,
            now,
        });

        expect(report.models.find((model) => model.model === "claude-opus-4-8")?.cost).toBeCloseTo(opus, 9);
        expect(report.models.find((model) => model.model === "unlisted-model")).toMatchObject({
            cost: 0,
            priced: false,
        });
    });
});

describe("the transcript time window", () => {
    isolateAgentHomeEnv();

    it("transcriptCutoffMs keeps a 3-day margin before the window start, and no cutoff without one", () => {
        expect(transcriptCutoffMs("2026-06-10")).toBe(Date.parse("2026-06-07T00:00:00.000Z"));
        expect(transcriptCutoffMs(undefined)).toBe(0);
        expect(transcriptCutoffMs("not-a-day")).toBe(0);
    });

    it("walkFiles skips files last written before minMtimeMs, and reads everything when it is unset or 0", () => {
        const root = mkdtempSync(join(tmpdir(), "ai-spend-walk-"));
        const oldFile = join(root, "old.jsonl");
        const newFile = join(root, "new.jsonl");
        writeFileSync(oldFile, "{}\n");
        writeFileSync(newFile, "{}\n");
        fs.utimesSync(oldFile, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
        const isFile = (name: string) => name.endsWith(".jsonl");
        const cutoff = Date.parse("2026-06-01T00:00:00Z");

        expect(walkFiles([root], { maxDepth: 1, isFile, minMtimeMs: cutoff })).toEqual([newFile]);
        expect(walkFiles([root], { maxDepth: 1, isFile, minMtimeMs: 0 })).toEqual([newFile, oldFile].sort());
        expect(walkFiles([root], { maxDepth: 1, isFile })).toEqual([newFile, oldFile].sort());
    });

    it("walkFiles applies the cutoff to a root that is a file", () => {
        const root = mkdtempSync(join(tmpdir(), "ai-spend-walk-root-"));
        const oldFile = join(root, "old.jsonl");
        writeFileSync(oldFile, "{}\n");
        fs.utimesSync(oldFile, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
        const isFile = (name: string) => name.endsWith(".jsonl");

        expect(walkFiles([oldFile], { maxDepth: 0, isFile, minMtimeMs: Date.parse("2026-06-01T00:00:00Z") })).toEqual(
            []
        );
        expect(walkFiles([oldFile], { maxDepth: 0, isFile })).toEqual([oldFile]);
    });

    it("loadEvents skips a transcript written before the window", () => {
        const home = mkdtempSync(join(tmpdir(), "ai-spend-window-"));
        const dir = join(home, ".claude", "projects", "-Users-x-Old");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, "sess.jsonl");
        writeFileSync(
            file,
            `${SafeJSON.stringify({
                type: "assistant",
                timestamp: "2026-01-01T10:00:00.000Z",
                cwd: "/Users/x/Old",
                sessionId: "s-old",
                message: { id: "m-old", model: "claude-opus-4-8", usage: { input_tokens: 5 } },
            })}\n`
        );
        fs.utimesSync(file, new Date("2026-01-01T10:00:00Z"), new Date("2026-01-01T10:00:00Z"));

        expect(loadEvents({ home, sources: ["claude"], minMtimeMs: Date.parse("2026-06-01T00:00:00Z") })).toEqual([]);
        expect(loadEvents({ home, sources: ["claude"] }).map((event) => event.id)).toEqual(["m-old"]);
    });
});

describe("loadEventsParallel", () => {
    isolateAgentHomeEnv();

    function homeWithClaudeAndCodex(): string {
        const home = mkdtempSync(join(tmpdir(), "ai-spend-parallel-"));
        const claudeDir = join(home, ".claude", "projects", "-Users-x-Par");
        mkdirSync(claudeDir, { recursive: true });
        writeFileSync(
            join(claudeDir, "sess.jsonl"),
            `${SafeJSON.stringify({
                type: "assistant",
                timestamp: "2026-06-01T10:00:00.000Z",
                cwd: "/Users/x/Par",
                sessionId: "s-par",
                message: { id: "m-par", model: "claude-opus-4-8", usage: { input_tokens: 7, output_tokens: 3 } },
            })}\n`
        );
        const codexDir = join(home, ".codex", "sessions", "2026", "06", "01");
        mkdirSync(codexDir, { recursive: true });
        const usage = { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10, reasoning_output_tokens: 0 };
        writeFileSync(
            join(codexDir, "rollout-2026-06-01T10-00-00-0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee.jsonl"),
            [
                SafeJSON.stringify({
                    timestamp: "2026-06-01T10:00:00.000Z",
                    type: "turn_context",
                    payload: { cwd: "/tmp/par", model: "gpt-5.6-sol" },
                }),
                SafeJSON.stringify({
                    timestamp: "2026-06-01T10:00:10.000Z",
                    type: "event_msg",
                    payload: { type: "token_count", info: { total_token_usage: usage, last_token_usage: usage } },
                }),
            ].join("\n")
        );

        return home;
    }

    const key = (event: SpendEvent) => `${event.source}:${event.id}`;
    const inlineReads = (warn: { mock: { calls: unknown[][] } }) =>
        warn.mock.calls.filter((call) =>
            call.some((arg) => typeof arg === "string" && arg.includes("reading this group inline"))
        );

    it("returns the same events as the sequential loader, from one worker per source", async () => {
        const home = homeWithClaudeAndCodex();
        const sequential = loadEvents({ home, sources: ["claude", "codex"] });
        const warn = spyOn(logger, "warn");
        const parallel = await loadEventsParallel({ home, sources: ["claude", "codex"] });
        const inline = inlineReads(warn);
        warn.mockRestore();

        // A failed worker is read inline and logs a warning, so no warning means the workers did the loading.
        expect(inline).toHaveLength(0);
        expect(sequential.map(key).sort()).toEqual(["claude:m-par", expect.stringContaining("codex:")]);
        expect(parallel.map(key).sort()).toEqual(sequential.map(key).sort());
        expect(parallel.find((event) => event.source === "claude")).toMatchObject({
            inputTokens: 7,
            outputTokens: 3,
            project: "/Users/x/Par",
        });
    });

    it("reads every group inline when its worker cannot start, and loses no event", async () => {
        const home = homeWithClaudeAndCodex();
        const sequential = loadEvents({ home, sources: ["claude", "codex"] });
        const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
        const events = await loadEventsParallel(
            { home, sources: ["claude", "codex"] },
            { workerUrl: new URL("file:///nonexistent/load-worker.ts") }
        );

        const inline = inlineReads(warn);
        warn.mockRestore();

        expect(events.map(key).sort()).toEqual(sequential.map(key).sort());
        expect(inline).toHaveLength(2);
    });

    it("stops waiting for a worker that never answers, then reads its group inline", async () => {
        const home = homeWithClaudeAndCodex();
        const sequential = loadEvents({ home, sources: ["claude", "codex"] });
        const silent = join(mkdtempSync(join(tmpdir(), "ai-spend-silent-worker-")), "silent-worker.ts");
        writeFileSync(silent, "self.onmessage = () => {};\n");
        const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
        const events = await loadEventsParallel(
            { home, sources: ["claude", "codex"] },
            { workerUrl: pathToFileURL(silent), timeoutMs: 50 }
        );

        const inline = inlineReads(warn);
        warn.mockRestore();

        expect(events.map(key).sort()).toEqual(sequential.map(key).sort());
        expect(inline).toHaveLength(2);
    });

    it("loads one source inline, without a worker", async () => {
        const home = homeWithClaudeAndCodex();

        expect((await loadEventsParallel({ home, sources: ["claude"] })).map((event) => event.id)).toEqual(["m-par"]);
    });
});

describe("worker cost card", () => {
    const at = new Date("2026-10-13T22:00:00.000Z");
    const million = { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, output: 1_000_000, reasoning: 0 };
    // The Claude estimate comes from the catalog, whose Claude rates change on their own schedule (Sonnet 5.5 cache
    // reads were halved on 2026-10-07). Derive it, so these tests pin the worker's own price and the wiring.
    const asClaude = (model: string): number => {
        const entry = priceFor(model, DEFAULT_PRICING);

        if (!entry) {
            throw new Error(`no catalog price for ${model}`);
        }

        return costOf(million, resolvePrice(entry, { at }));
    };
    const claudeTail = () =>
        `as Claude ≈ Opus ${formatUsd(asClaude("claude-opus-5-5"))} / Sonnet ${formatUsd(asClaude("claude-sonnet-5-5"))} (estimate)`;

    it("prices cache reads at the cache rate and the Claude counterfactual from the same table", () => {
        // gpt-6.1-sol: $2 input, $0.10 cache read, $10 output. The Claude figures are the catalog's own prices.
        const card = workerCostCard({
            backend: "codex",
            sessionId: "thread-1",
            parts: [{ model: "gpt-6.1-sol", tokens: million }],
            auth: "api-key",
            at,
        });

        expect(card.apiEquivalentUsd).toBeCloseTo(12.1, 10);
        expect(card.billedUsd).toBeCloseTo(12.1, 10);
        expect(card.claudeEquivalent).toMatchObject({ estimate: true, opusModel: "claude-opus-5-5" });
        expect(card.claudeEquivalent.opusUsd).toBeCloseTo(asClaude("claude-opus-5-5"), 10);
        expect(card.claudeEquivalent.sonnetUsd).toBeCloseTo(asClaude("claude-sonnet-5-5"), 10);
    });

    it("a subscription login bills 0 while the API-equivalent stays the list price", () => {
        const card = workerCostCard({
            backend: "codex",
            sessionId: "thread-1",
            parts: [{ model: "gpt-6.1-sol", tokens: million }],
            auth: "subscription",
            at,
        });

        expect(card.billedUsd).toBe(0);
        expect(card.apiEquivalentUsd).toBeCloseTo(12.1, 10);
        expect(formatCostLine(card, "codex")).toBe(
            `cost: $12.10 API-equivalent (subscription, billed $0) · ${claudeTail()}`
        );
    });

    it("a model with no price is unknown, never 0, and so is what an API key billed", () => {
        const card = workerCostCard({
            backend: "grok",
            sessionId: "s-1",
            parts: [{ model: "grok-0-unpriced", tokens: million }],
            auth: "api-key",
            at,
        });

        expect(card.apiEquivalentUsd).toBeNull();
        expect(card.billedUsd).toBeNull();
        expect(card.unpriced).toBe("no list price for grok-0-unpriced");
        expect(formatCostLine(card, "grok")).toMatch(
            /^cost: API-equivalent unknown \(no list price for grok-0-unpriced; api-key, billed \?\) · as Claude/
        );
        expect(card.claudeEquivalent.opusUsd).toBeCloseTo(asClaude("claude-opus-5-5"), 10);
    });

    it("bands one request by its own prompt length, never a sum of requests", () => {
        // 300K of context in ONE request crosses gpt-6.1-sol's 272K band: $4 / $0.20 / $15.
        const big = { input: 100_000, cacheRead: 200_000, cacheWrite: 0, output: 10_000, reasoning: 0 };
        const one = workerCostCard({
            backend: "codex",
            sessionId: "t",
            parts: [{ model: "gpt-6.1-sol", tokens: big, singleRequest: true }],
            auth: "subscription",
            at,
        });
        const half = { input: 50_000, cacheRead: 100_000, cacheWrite: 0, output: 5_000, reasoning: 0 };
        const two = workerCostCard({
            backend: "codex",
            sessionId: "t",
            parts: [
                { model: "gpt-6.1-sol", tokens: half, singleRequest: true },
                { model: "gpt-6.1-sol", tokens: half, singleRequest: true },
            ],
            auth: "subscription",
            at,
        });

        expect(one.apiEquivalentUsd).toBeCloseTo(0.1 * 4 + 0.2 * 0.2 + 0.01 * 15, 10);
        expect(one.longContextRequests).toBe(1);
        expect(two.apiEquivalentUsd).toBeCloseTo(0.1 * 2 + 0.2 * 0.1 + 0.01 * 10, 10);
        expect(two.longContextRequests).toBe(0);
    });

    it("grok bills its list price; the figure grok reported is shown, and stands in only without a price", () => {
        // grok-4.7: $2 input, $0.50 cached, $6 output. Grok's own figure is its plan metering, not a list price.
        const card = workerCostCard({
            backend: "grok",
            sessionId: "s-1",
            parts: [{ model: "grok-4.7", tokens: million }],
            auth: "subscription",
            reportedUsd: 2.44,
            at,
        });

        expect(card).toMatchObject({ apiEquivalentUsd: 8.5, basis: "catalog", billedUsd: 0, reportedUsd: 2.44 });
        expect(formatCostLine(card, "grok")).toBe(
            `cost: $8.50 API-equivalent (subscription, billed $0; grok reported $2.44) · ${claudeTail()}`
        );

        const unpriced = workerCostCard({
            backend: "grok",
            sessionId: "s-1",
            parts: [{ model: "grok-0-unpriced", tokens: million }],
            auth: "subscription",
            reportedUsd: 2.44,
            at,
        });

        expect(unpriced).toMatchObject({
            apiEquivalentUsd: 2.44,
            basis: "reported",
            unpriced: "no list price for grok-0-unpriced",
        });
        expect(formatCostLine(unpriced, "grok")).toMatch(
            /^cost: \$2\.44 reported by grok \(no list price for grok-0-unpriced; subscription, billed \$0\)/
        );
    });

    it("a one-hour cache write bills at 2x input, a five-minute one at 1.25x", () => {
        // claude-opus-5: $5 input, $25 output, $0.50 cache read, $6.25 five-minute write, $10 one-hour write.
        const tokens = {
            input: 24,
            cacheRead: 1_012_946,
            cacheWrite: 106_816,
            cacheWrite1h: 106_816,
            output: 11_471,
            reasoning: 0,
        };
        const card = workerCostCard({
            backend: "claude",
            sessionId: "s-2",
            parts: [{ model: "claude-opus-5", tokens }],
            auth: "subscription",
            at,
        });

        // The figure Claude Code itself reported for this token profile on 2026-09-16: $1.861528.
        expect(card.apiEquivalentUsd).toBeCloseTo(1.861528, 6);
        const fiveMinute = workerCostCard({
            backend: "claude",
            sessionId: "s-2",
            parts: [{ model: "claude-opus-5", tokens: { ...tokens, cacheWrite1h: 0 } }],
            auth: "subscription",
            at,
        });
        expect(fiveMinute.apiEquivalentUsd).toBeCloseTo(1.861528 - 106_816 * (10 - 6.25) * 1e-6, 6);
    });
});

describe("worker cost ledger", () => {
    it("appends rows without touching the ones already there", async () => {
        const row = (turn: number) =>
            buildWorkerCostRow({
                backend: "claude",
                name: "ledger-fixture",
                sessionId: "00000000-0000-4000-8000-0000000000bb",
                turn,
                auth: "subscription",
                account: "work",
                startedAt: new Date("2026-10-13T10:00:00.000Z"),
                endedAt: new Date("2026-10-13T10:01:30.000Z"),
                toolCalls: 3,
                parts: [
                    {
                        model: "claude-sonnet-5-5",
                        tokens: { input: 10, cacheRead: 0, cacheWrite: 0, output: 5, reasoning: 0 },
                    },
                ],
                cwd: "/w",
                label: " review-loop pr1 ",
            });
        const before = readWorkerCostRows().length;

        await appendWorkerCostRows([row(1)]);
        await appendWorkerCostRows([row(2)]);
        const rows = readWorkerCostRows().filter((entry) => entry.name === "ledger-fixture");

        expect(readWorkerCostRows().length).toBe(before + 2);
        expect(rows.map((entry) => entry.turn)).toEqual([1, 2]);
        expect(rows[0]).toMatchObject({ durationMs: 90_000, label: "review-loop pr1", account: "work" });
        expect(workerCostLedgerPath()).not.toContain(`${homedir()}/.genesis-tools`);
    });

    const grokTurn = (options: { name: string; model: string; auth?: "subscription" | "api-key" }) =>
        buildWorkerCostRow({
            backend: "grok",
            name: options.name,
            sessionId: `00000000-0000-4000-8000-${options.name.padStart(12, "0").slice(-12)}`,
            turn: 1,
            auth: options.auth ?? "subscription",
            account: "work",
            startedAt: new Date("2026-10-13T10:00:00.000Z"),
            endedAt: new Date("2026-10-13T10:02:00.000Z"),
            toolCalls: 9,
            parts: [
                {
                    model: options.model,
                    tokens: { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, output: 1_000_000, reasoning: 0 },
                    singleRequest: false,
                },
            ],
            reportedUsd: 2.44,
            cwd: "/w",
            label: "babysit pr512",
        });

    it.each(["claude", "grok"] as const)(
        "%s backfill waits for published completion before reserving a booking key",
        async (backend) => {
            const home = mkdtempSync(join(tmpdir(), "backfill-active-"));
            await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
                const name = "active-backfill";
                const sessionId = "00000000-0000-4000-8000-0000000000ac";
                const startedAt = new Date("2026-10-13T10:00:00Z");
                const common = { name, sessionId, cwd: home, turns: 1, createdAt: startedAt.toISOString() };
                const activeTurn = { turn: 1, ownerPid: process.pid, startedAt: startedAt.toISOString() };
                const claude = new ClaudeWorkerStore();
                const grok = new GrokSessionStore();
                const publish = (finished: boolean) => {
                    const state = finished
                        ? { lastTurn: { turn: 1, exitCode: 0, ended: true, at: "2026-10-13T10:01:00Z" } }
                        : { activeTurn };
                    if (backend === "claude") {
                        claude.writeMeta({ ...common, ...state, account: "work" });
                    } else {
                        grok.writeMeta({ ...common, ...state, workerHome: home, readOnly: true });
                    }
                };
                publish(false);
                const path = backend === "claude" ? workerTurnLogPath(name, 1) : turnLogPath(name, 1);
                writeFileSync(path, "");
                expect(planWorkerBackfill([]).rows).toEqual([]);
                expect(await appendWorkerCostRows(planWorkerBackfill([]).rows)).toEqual([]);
                // Even a terminal record is not enough until the child has exited and closed its log.
                writeFileSync(
                    path,
                    SafeJSON.stringify({
                        type: backend === "claude" ? "result" : "end",
                        subtype: "success",
                        is_error: false,
                        session_id: sessionId,
                        usage: { input_tokens: 100, output_tokens: 20 },
                    }) + "\n"
                );
                expect(planWorkerBackfill([]).rows).toEqual([]);
                publish(true);
                expect(planWorkerBackfill([]).rows).toHaveLength(1);
                const live = await recordWorkerTurnCost({
                    backend,
                    name,
                    sessionId,
                    turn: 1,
                    cwd: home,
                    auth: "subscription",
                    startedAt,
                    endedAt: new Date("2026-10-13T10:01:00Z"),
                    toolCalls: 0,
                    outcome: "completed",
                    parts: [
                        { model: null, tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0 } },
                    ],
                });
                expect(live?.outcome).toBe("completed");
                expect(readWorkerCostRows()).toHaveLength(1);
                expect(readWorkerCostRows()[0].tokens?.input).toBe(100);
                expect(planWorkerBackfill(readWorkerCostRows()).rows).toEqual([]);
            });
        }
    );

    it("returns the persisted cost when backfill owns a turn before live booking", async () => {
        const home = mkdtempSync(join(tmpdir(), "ledger-booking-duplicate-"));
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const backfilled: WorkerCostRow = {
                ...grokTurn({ name: "backfill-before-live", model: "grok-4.7" }),
                backfilled: true,
            };
            expect(await appendWorkerCostRows([backfilled])).toEqual([backfilled]);
            const live = await recordWorkerTurnCost({
                backend: backfilled.backend,
                name: backfilled.name,
                sessionId: backfilled.sessionId,
                turn: backfilled.turn,
                auth: "api-key",
                startedAt: new Date("2026-10-13T10:00:00Z"),
                endedAt: new Date("2026-10-13T10:03:00Z"),
                toolCalls: 1,
                parts: [
                    { model: "grok-4.7", tokens: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0 } },
                ],
                cwd: home,
            });

            expect(live?.cost).toEqual(backfilled.cost);
            expect(live).toEqual(backfilled);
            expect(readWorkerCostRows()).toEqual([backfilled]);
        });
    });

    it("deduplicates concurrent backfills and a live booking inside the append lock", async () => {
        const row = grokTurn({ name: "dedup-turn", model: "grok-4.7" });
        const backfilled: WorkerCostRow = { ...row, backfilled: true };
        const results = await Promise.all([
            appendWorkerCostRows([row]),
            appendWorkerCostRows([backfilled, backfilled]),
        ]);
        expect(results.flat()).toHaveLength(1);
        expect(readWorkerCostRows().filter((entry) => entry.name === row.name)).toHaveLength(1);
        expect(await appendWorkerCostRows([backfilled])).toEqual([]);
    });

    it("bounds status bytes and parsing while streaming complete report snapshots", async () => {
        const home = mkdtempSync(join(tmpdir(), "ledger-status-bound-"));
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const row = grokTurn({ name: "recent-status", model: "grok-4.7" });
            const older = { ...row, name: "older-worker", label: "x".repeat(512) };
            const text = (SafeJSON.stringify(older) + "\n").repeat(2000) + SafeJSON.stringify(row) + "\n";
            expect(Buffer.byteLength(text)).toBeGreaterThan(1024 * 1024);
            mkdirSync(join(workerCostLedgerPath(), ".."), { recursive: true });
            writeFileSync(workerCostLedgerPath(), text);
            const read = spyOn(fs, "readSync");
            const parse = spyOn(SafeJSON, "parse");
            try {
                const summary = sessionCostSummary({ backend: "grok", name: row.name, sessionId: row.sessionId });
                expect(summary?.lastTurn.name).toBe(row.name);
                expect(summary?.note).toContain("Partial session totals");
                const statusReads = read.mock.calls.map((call) => Number(call[2]?.length));
                expect(statusReads.length).toBeGreaterThan(0);
                expect(statusReads.reduce((sum, count) => sum + count, 0)).toBeLessThanOrEqual(1024 * 1024);
                expect(parse.mock.calls.length).toBeLessThan(2000);
                read.mockClear();
                const complete = readWorkerCostLedger();
                expect(complete.rows).toHaveLength(2001);
                expect(complete.bytes).toBe(Buffer.byteLength(text));
                expect(read.mock.calls.every((call) => Number(call[2]?.length) <= 64 * 1024)).toBe(true);
            } finally {
                read.mockRestore();
                parse.mockRestore();
            }
        });
    });

    it("skips malformed ledger structures while keeping valid rows usable", async () => {
        const valid = grokTurn({ name: "validated", model: "grok-4.7" });
        await appendWorkerCostRows([valid]);
        const before = readWorkerCostRows();
        const invalid = [
            { v: 1, ts: valid.ts, backend: "codex", name: "incomplete" },
            { ...valid, cost: null },
            { ...valid, backend: "unsupported" },
            { ...valid, tokens: { input: -1 } },
            { ...valid, ts: "not-a-date" },
            { ...valid, cost: { ...valid.cost, billedUsd: "bad" } },
            { ...valid, durationMs: -1 },
        ];
        fs.appendFileSync(workerCostLedgerPath(), invalid.map((row) => SafeJSON.stringify(row)).join("\n") + "\n");
        expect(readWorkerCostRows()).toEqual(before);
    });

    it("locks appends from another process against a rewrite and rejects a stale repricer snapshot", async () => {
        await appendWorkerCostRows([grokTurn({ name: "locked-original", model: "grok-4.7" })]);
        const ledger = readWorkerCostLedger();
        const row = grokTurn({ name: "locked-child", model: "grok-4.7" });
        let rewrite: Promise<void> | undefined;
        let child: ReturnType<typeof Bun.spawn> | undefined;
        await withFileLock(workerCostLedgerPath() + ".lock", async () => {
            const source =
                "import { appendWorkerCostRows } from " +
                SafeJSON.stringify(join(import.meta.dir, "lib/workers/ledger.ts")) +
                "; const pending = appendWorkerCostRows([" +
                SafeJSON.stringify(row) +
                "]); console.log('started'); await pending;";
            const proc = Bun.spawn([process.execPath, "-e", source], {
                env: env.getProcessEnv(),
                stdout: "pipe",
                stderr: "pipe",
            });
            child = proc;
            const reader = proc.stdout.getReader();
            try {
                expect(new TextDecoder().decode((await reader.read()).value)).toContain("started");
            } finally {
                reader.releaseLock();
            }
            rewrite = rewriteWorkerCostRows(
                ledger.rows.map((item) =>
                    item.name === "locked-original" ? { ...item, label: "locked rewrite" } : item
                ),
                ledger
            );
            expect(readWorkerCostRows().some((item) => item.name === "locked-child")).toBe(false);
        });
        await rewrite;
        expect(await child?.exited).toBe(0);
        const after = readWorkerCostRows();
        expect(after.find((item) => item.name === "locked-original")?.label).toBe("locked rewrite");
        expect(after.filter((item) => item.name === "locked-child")).toHaveLength(1);
        await expect(rewriteWorkerCostRows(ledger.rows, ledger)).rejects.toThrow("changed since");
    });

    it("a re-price moves only the price, and keeps a row whose turn files are gone", () => {
        // A row booked under the old rules: grok's own metering stood in as the list price.
        const booked: WorkerCostRow = {
            ...grokTurn({ name: "reprice-a", model: "grok-4.7" }),
            priced: undefined,
            cost: { ...grokTurn({ name: "reprice-a", model: "grok-0-unpriced" }).cost },
            backfilled: true,
        };
        const orphan: WorkerCostRow = { ...grokTurn({ name: "reprice-gone", model: "grok-4.7" }), priced: undefined };
        const plan = planWorkerReprice([booked, orphan], [grokTurn({ name: "reprice-a", model: "grok-4.7" })]);

        expect(booked.cost.apiEquivalentUsd).toBe(2.44);
        expect(isStalePrice(booked)).toBe(true);
        expect(plan.kept).toBe(1);
        expect(plan.rows[1]).toBe(orphan);
        expect(plan.rows[0]).toMatchObject({
            name: "reprice-a",
            label: "babysit pr512",
            backfilled: true,
            durationMs: 120_000,
            priced: WORKER_PRICING_VERSION,
            cost: { apiEquivalentUsd: 8.5, basis: "catalog", reportedUsd: 2.44, billedUsd: 0 },
        });
        expect(isStalePrice(plan.rows[0])).toBe(false);
        expect(bookedCostLine(orphan)).toEndWith("priced under older rules, see: tools ai-spend workers --reprice");
        expect(bookedCostLine(plan.rows[0])).not.toContain("older rules");
    });

    it("an API-key row's billed amount follows its new price; the booked login is never re-derived", () => {
        const booked = { ...grokTurn({ name: "reprice-key", model: "grok-4.7", auth: "api-key" }), priced: 1 };
        const source = grokTurn({ name: "reprice-key", model: "grok-4.7", auth: "subscription" });
        const [after] = planWorkerReprice([booked], [source]).rows;

        expect(after.auth).toBe("api-key");
        expect(after.cost).toMatchObject({ auth: "api-key", apiEquivalentUsd: 8.5, billedUsd: 8.5 });
    });

    it("a rewrite keeps the old ledger as .bak and carries a row appended while it ran", async () => {
        await appendWorkerCostRows([grokTurn({ name: "rewrite-a", model: "grok-4.7" })]);
        const ledger = readWorkerCostLedger();
        await appendWorkerCostRows([grokTurn({ name: "rewrite-late", model: "grok-4.7" })]);

        await rewriteWorkerCostRows(
            ledger.rows.map((row) => (row.name === "rewrite-a" ? { ...row, label: "rewritten" } : row)),
            ledger
        );
        const after = readWorkerCostRows();

        expect(after.find((row) => row.name === "rewrite-a")?.label).toBe("rewritten");
        expect(after.filter((row) => row.name === "rewrite-late")).toHaveLength(1);
        expect(after).toHaveLength(ledger.rows.length + 1);
        expect(fs.readFileSync(`${workerCostLedgerPath()}.bak`, "utf8")).toContain('"rewrite-late"');
    });
});

describe("worker stats", () => {
    const session = (name: string, label: string | null): WorkerSessionInfo => ({
        backend: "codex",
        name,
        sessionId: `thread-${name}`,
        home: null,
        cwd: "/w",
        model: "gpt-6.1-sol",
        effort: null,
        label,
        auth: "subscription",
        account: null,
        lastActiveAt: "2026-10-13T12:00:00.000Z",
    });
    const event = (sessionId: string, timestamp: string): SpendEvent => ({
        source: "codex",
        id: `${sessionId}|${timestamp}`,
        model: "gpt-6.1-sol",
        timestamp,
        sessionId,
        project: "",
        inputTokens: 100_000,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
    });

    const booked = (options: { name: string; day: string; auth: "api-key" | "subscription"; model?: string }) =>
        buildWorkerCostRow({
            backend: "codex",
            name: options.name,
            sessionId: "thread-" + options.name,
            turn: Number(options.day.slice(-2)),
            model: options.model ?? "gpt-6.1-sol",
            auth: options.auth,
            endedAt: new Date(options.day + "T11:00:00.000Z"),
            durationMs: 3_600_000,
            toolCalls: 1,
            parts: [
                {
                    model: options.model ?? "gpt-6.1-sol",
                    tokens: { input: 100_000, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
                },
            ],
            cwd: "/w",
            label: "historic",
        });

    it("keeps an unpriced API-key request's billed amount unknown", () => {
        const report = buildWorkerStats({
            home: "/nonexistent",
            timezone: "UTC",
            dimensions: ["day"],
            sessions: [session("unpriced", null)],
            rows: [booked({ name: "unpriced", day: "2026-10-13", auth: "api-key", model: "not-in-catalog" })],
            loadSessionEvents: () => [
                { ...event("thread-unpriced", "2026-10-13T10:30:00.000Z"), model: "not-in-catalog" },
            ],
        });
        expect(report.total).toMatchObject({ unpricedRequests: 1, billedUsd: 0, unbilledRequests: 1 });
    });

    it("includes deleted and reused-name sessions from booked rows, respecting filters", () => {
        const rows = [
            booked({ name: "reused", day: "2026-10-12", auth: "api-key" }),
            booked({ name: "deleted", day: "2026-10-13", auth: "api-key" }),
        ];
        const report = buildWorkerStats({
            home: "/nonexistent",
            timezone: "UTC",
            dimensions: ["name"],
            label: "historic",
            sessions: [{ ...session("reused", "new-label"), sessionId: "new-thread" }],
            rows,
            loadSessionEvents: () => {
                throw new Error("ledger-only sessions must use booked rows");
            },
        });
        expect(report.total).toMatchObject({ sessions: 2, turns: 2, ledgerOnlySessions: 2, requests: 2 });
        expect(report.total.billedUsd).toBeCloseTo(0.4);
        const filtered = buildWorkerStats({
            home: "/nonexistent",
            timezone: "UTC",
            dimensions: ["name"],
            rows,
            sessions: [],
            sinceDay: "2026-10-13",
            backends: ["codex"],
        });
        expect(filtered.groups.map((group) => group.key.name)).toEqual(["deleted"]);
    });

    it("uses each booked turn's login and leaves unmatched history unknown", () => {
        for (const auths of [
            ["subscription", "api-key"],
            ["api-key", "subscription"],
        ] as const) {
            const report = buildWorkerStats({
                home: "/nonexistent",
                timezone: "UTC",
                dimensions: ["day"],
                sessions: [session("history", null)],
                rows: [
                    booked({ name: "history", day: "2026-10-12", auth: auths[0] }),
                    booked({ name: "history", day: "2026-10-13", auth: auths[1] }),
                ],
                loadSessionEvents: () => [
                    event("thread-history", "2026-10-12T10:30:00.000Z"),
                    event("thread-history", "2026-10-13T10:30:00.000Z"),
                    event("thread-history", "2026-10-11T10:30:00.000Z"),
                ],
            });
            const days = Object.fromEntries(report.groups.map((group) => [group.key.day, group]));
            expect(days["2026-10-12"].billedUsd).toBeCloseTo(auths[0] === "api-key" ? 0.2 : 0);
            expect(days["2026-10-13"].billedUsd).toBeCloseTo(auths[1] === "api-key" ? 0.2 : 0);
            expect(days["2026-10-11"].unbilledRequests).toBe(1);
        }
    });

    it("prices the transcripts per request and groups by label; a missing transcript falls back to its ledger rows", () => {
        const ledgerRow = buildWorkerCostRow({
            backend: "codex",
            name: "gone",
            sessionId: "thread-gone",
            turn: 1,
            model: "gpt-6.1-sol",
            auth: "subscription",
            endedAt: new Date("2026-10-13T11:00:00.000Z"),
            durationMs: 60_000,
            toolCalls: 4,
            parts: [
                {
                    model: "gpt-6.1-sol",
                    tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1_000_000, reasoning: 0 },
                },
            ],
            cwd: "/w",
        });
        const report = buildWorkerStats({
            home: "/nonexistent",
            timezone: "UTC",
            sinceDay: "2026-10-13",
            dimensions: ["label"],
            sessions: [session("a", "pr1"), session("b", "pr1"), session("gone", null)],
            rows: [ledgerRow],
            loadSessionEvents: (worker) =>
                worker.name === "gone"
                    ? null
                    : [
                          event(`rollout-${worker.name}`, "2026-10-13T10:00:00.000Z"),
                          event(`rollout-${worker.name}`, "2026-10-12T10:00:00.000Z"),
                      ],
        });

        const byLabel = Object.fromEntries(report.groups.map((group) => [group.key.label, group]));
        // Two in-window requests of 100K input at $2/M; the 10-12 ones are outside the window.
        expect(byLabel.pr1).toMatchObject({ sessions: 2, requests: 2, turns: 0, billedUsd: 0 });
        expect(byLabel.pr1.apiEquivalentUsd).toBeCloseTo(0.4, 10);
        expect(byLabel.pr1.claudeOpusUsd).toBeCloseTo(0.8, 10);
        expect(byLabel[""]).toMatchObject({
            sessions: 1,
            turns: 1,
            toolCalls: 4,
            durationMs: 60_000,
            ledgerOnlySessions: 1,
        });
        expect(byLabel[""].apiEquivalentUsd).toBeCloseTo(10, 10);
        expect(report.total.sessions).toBe(3);
        expect(report.notes).toEqual(["codex gone: no transcript found, priced from its ledger rows"]);
    });
});
