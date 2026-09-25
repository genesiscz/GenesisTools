import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { findCodexRollout } from "@genesiscz/utils/session-changes/codex";
import { Storage } from "@genesiscz/utils/storage/storage";
import { withTimeZone } from "@genesiscz/utils/test/timezone";
import { aggregate } from "./lib/aggregate";
import { loadPricing } from "./lib/config";
import { isolateAgentHomeEnv } from "./lib/drivers/test-env";
import { parseTranscriptLine } from "./lib/parse";
import { costOf, DEFAULT_PRICING, priceFor, resolvePrice } from "./lib/pricing";
import { renderSummary } from "./lib/render";
import { resolveSessionFlag } from "./lib/reports/commands";
import { loadEvents } from "./lib/reports/load";
import type { SpendEvent } from "./lib/reports/types";
import { resolveSince } from "./lib/since";
import type { UsageEvent } from "./lib/types";

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
