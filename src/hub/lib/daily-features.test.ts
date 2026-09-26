import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecisionRecord } from "@app/question/lib/decisions/store";
import type { AgentSearchFilters, AgentSearchHit, AgentSessionAdapter } from "@genesiscz/utils/agent-sessions/types";
import {
    buildDigest,
    type DigestDeps,
    digestDay,
    digestDecisions,
    digestFromTimeline,
    digestMarkdown,
    parseNumstat,
} from "./digest";
import { forecastFromSamples, forecastWindow, type UsageSample } from "./forecast";
import type { NotifyState } from "./notify-poll";
import {
    addRule,
    contextWindowFor,
    emptyRulesState,
    evaluateRules,
    type HubRule,
    normalizeRulesConfig,
    prRefFromKey,
    type RuleInputs,
    type RuleSession,
    ruleClickCommand,
    rulePrsFromNotifyState,
    runRules,
} from "./rules";
import { searchSessions, snippetAround } from "./search";
import type { TimelineEvent, TimelineResult } from "./timeline";

// The four daily hub doors (search, digest, forecast, rules) in one file: pure logic over injected
// inputs, no spawn, no network, no real clock wait.

const NOW = new Date("2026-03-02T15:00:00Z");
const minutesAgo = (minutes: number) => NOW.getTime() - minutes * 60_000;
const isoAgo = (minutes: number) => new Date(minutesAgo(minutes)).toISOString();

describe("search", () => {
    function hit(overrides: Partial<AgentSearchHit<string>> & { sessionId: string }): AgentSearchHit<string> {
        return {
            kind: "claude",
            cwd: "/work/shop",
            title: "Fix the cart",
            mtime: new Date(minutesAgo(10)),
            filePath: `/sessions/${overrides.sessionId}.jsonl`,
            project: "shop",
            ...overrides,
        };
    }

    function adapter(
        kind: string,
        hits: AgentSearchHit<string>[],
        seen: AgentSearchFilters[] = []
    ): () => AgentSessionAdapter<string> {
        return () => ({
            kind,
            list: async () => [],
            search: async (filters) => {
                seen.push(filters);
                return hits;
            },
        });
    }

    test("snippetAround keeps short text and centres long text on the match", () => {
        expect(snippetAround("  a   short\nline ", "short")).toBe("a short line");
        const long = `${"x".repeat(300)} needle here ${"y".repeat(300)}`;
        const cut = snippetAround(long, "needle", 60);
        expect(cut).toContain("needle here");
        expect(cut.startsWith("…")).toBe(true);
        expect(cut.endsWith("…")).toBe(true);
    });

    test("fans out to every provider with the filters pushed in, merges newest first and dedupes", async () => {
        const seen: AgentSearchFilters[] = [];
        const since = new Date(minutesAgo(600));
        const result = await searchSessions(
            { query: " cart bug ", project: "shop", since, limit: 5 },
            {
                claude: adapter(
                    "claude",
                    [
                        hit({
                            sessionId: "c1",
                            matchedEntries: [
                                {
                                    line: 7,
                                    role: "user",
                                    text: "the cart bug again",
                                    paths: [],
                                    commits: [],
                                    timestamp: isoAgo(20),
                                },
                                { line: 9, role: "assistant", text: "   ", paths: [], commits: [] },
                            ],
                        }),
                        hit({ sessionId: "c1" }),
                    ],
                    seen
                ),
                codex: adapter(
                    "codex",
                    [
                        hit({
                            kind: "codex",
                            sessionId: "x1",
                            mtime: new Date(minutesAgo(1)),
                            matchedText: "cart bug in title",
                        }),
                    ],
                    seen
                ),
            }
        );

        expect(seen).toHaveLength(2);
        expect(seen[0]).toMatchObject({
            query: "cart bug",
            project: "shop",
            all: false,
            since,
            limit: 5,
            excludeAgents: true,
        });
        expect(result.results.map((entry) => entry.sessionId)).toEqual(["x1", "c1"]);
        expect(result.results[1].snippets).toEqual([
            { role: "user", text: "the cart bug again", line: 7, timestamp: isoAgo(20), tool: null },
        ]);
        // A metadata hit still shows what matched.
        expect(result.results[0].snippets[0].text).toBe("cart bug in title");
        expect(result.filters.providers).toEqual(["claude", "codex"]);
    });

    test("one failing provider is reported and does not blank the others", async () => {
        const result = await searchSessions(
            { query: "cart", providers: ["claude", "grok"] },
            {
                claude: adapter("claude", [hit({ sessionId: "c1" })]),
                grok: () => {
                    throw new Error("index locked");
                },
            }
        );
        expect(result.results).toHaveLength(1);
        expect(result.providers.grok).toMatchObject({ hits: 0, error: "index locked" });
        expect(result.providers.claude).toMatchObject({ hits: 1, error: null });
    });

    test("an empty query is refused", async () => {
        await expect(searchSessions({ query: "   " }, {})).rejects.toThrow("empty");
    });
});

function decision(overrides: Partial<DecisionRecord> & { id: string }): DecisionRecord {
    return {
        sessionId: "s1",
        number: 1,
        prompt: "Pick a cache TTL",
        options: ["30 s", "60 s"],
        state: "open",
        project: "shop",
        updatedTs: isoAgo(30),
        createdTs: isoAgo(30),
        ...overrides,
    };
}

describe("digest", () => {
    const window = { since: new Date("2026-03-02T00:00:00Z"), until: NOW };

    function event(overrides: Partial<TimelineEvent> & Pick<TimelineEvent, "id" | "kind" | "at">): TimelineEvent {
        return { title: "t", detail: null, project: "shop", repo: "/work/shop", ...overrides };
    }

    function timeline(events: TimelineEvent[]): TimelineResult {
        return {
            since: window.since.toISOString(),
            until: window.until.toISOString(),
            before: null,
            limit: 1000,
            events,
            repos: ["/work/shop"],
            counts: { "session.start": 0, "session.turn": 0, commit: 0, push: 0, pr: 0, thread: 0, decision: 0, ci: 0 },
            warnings: [],
            elapsedMs: 1,
            cached: false,
            hasMore: false,
            nextBefore: null,
            truncated: [],
        };
    }

    const events: TimelineEvent[] = [
        event({
            id: "start:s1",
            kind: "session.start",
            at: "2026-03-02T09:00:00Z",
            sessionId: "s1",
            provider: "claude",
            title: "Cart fix",
        }),
        event({
            id: "turn:s1",
            kind: "session.turn",
            at: "2026-03-02T11:00:00Z",
            sessionId: "s1",
            provider: "claude",
            title: "Cart fix",
            branch: "fix/cart",
        }),
        event({
            id: "turn:s2",
            kind: "session.turn",
            at: "2026-03-02T14:00:00Z",
            sessionId: "s2",
            provider: "codex",
            title: "Docs",
            repo: "/work/docs",
            project: "docs",
        }),
        event({
            id: "commit:aaa",
            kind: "commit",
            at: "2026-03-02T10:30:00Z",
            sha: "aaa111",
            title: "fix: cart total",
            mine: true,
        }),
        event({
            id: "commit:bbb",
            kind: "commit",
            at: "2026-03-02T12:00:00Z",
            sha: "bbb222",
            title: "someone else",
            mine: false,
        }),
        event({
            id: "pr-open:shop#4",
            kind: "pr",
            at: "2026-03-02T11:10:00Z",
            title: "Cart fix",
            pr: { ref: "work/shop#4", number: 4, url: "https://example.com/4" },
        }),
        event({
            id: "pr-merged:shop#3",
            kind: "pr",
            at: "2026-03-02T13:00:00Z",
            title: "Older",
            pr: { ref: "work/shop#3", number: 3, url: "https://example.com/3" },
        }),
        event({ id: "pr-updated:shop#2", kind: "pr", at: "2026-03-02T13:30:00Z", title: "Noise" }),
        event({ id: "ci:1", kind: "ci", at: "2026-03-02T11:20:00Z", state: "failed" }),
        event({ id: "push:1", kind: "push", at: "2026-03-02T11:15:00Z" }),
    ];

    test("digestDay reads today, yesterday and a date, and refuses anything else", () => {
        const local = new Date(2026, 2, 2, 15, 0, 0);
        expect(digestDay("today", local)?.until).toEqual(local);
        expect(digestDay("yesterday", local)?.since).toEqual(new Date(2026, 2, 1));
        expect(digestDay("2026-02-10", local)).toEqual({ since: new Date(2026, 1, 10), until: new Date(2026, 1, 11) });
        expect(digestDay("2026-02-30", local)).toBeNull();
        expect(digestDay("last week", local)).toBeNull();
    });

    test("parseNumstat sums per path and counts binary files as zero", () => {
        const stats = parseNumstat("3\t1\tsrc/a.ts\n-\t-\tlogo.png\n\n2\t0\tsrc/a.ts\nnot a line");
        expect(stats.get("src/a.ts")).toEqual({ added: 5, removed: 1 });
        expect(stats.get("logo.png")).toEqual({ added: 0, removed: 0 });
        expect(stats.size).toBe(2);
    });

    test("folds the feed into sessions, my commits (attributed to the one session in that repo), PRs and CI", () => {
        const digest = digestFromTimeline({ window, timeline: timeline(events), decisions: [], now: NOW });
        expect(digest.sessions.map((session) => session.sessionId)).toEqual(["s2", "s1"]);
        expect(digest.sessions[1]).toMatchObject({ startedAt: "2026-03-02T09:00:00Z", branch: "fix/cart", commits: 1 });
        expect(digest.commits).toEqual([
            expect.objectContaining({ sha: "aaa111", sessionId: "s1", subject: "fix: cart total" }),
        ]);
        expect(digest.prs.opened.map((pr) => pr.ref)).toEqual(["work/shop#4"]);
        expect(digest.prs.merged.map((pr) => pr.ref)).toEqual(["work/shop#3"]);
        expect(digest.ci).toEqual({ failed: 1, passed: 0 });
        expect(digest.pushes).toBe(1);
    });

    test("decisions: posted by createdTs, answered by updatedTs in an answered state, todos skipped", () => {
        const rows = [
            decision({ id: "d1", createdTs: "2026-03-02T08:00:00Z" }),
            decision({
                id: "d2",
                state: "answered",
                option: "b",
                createdTs: "2026-03-01T08:00:00Z",
                updatedTs: "2026-03-02T10:00:00Z",
            }),
            decision({ id: "d3", type: "todo", createdTs: "2026-03-02T08:00:00Z" }),
            decision({
                id: "d4",
                state: "answered",
                updatedTs: "2026-03-01T10:00:00Z",
                createdTs: "2026-03-01T09:00:00Z",
            }),
        ];
        const { posted, answered } = digestDecisions(rows, window);
        expect(posted.map((row) => row.id)).toEqual(["d1"]);
        expect(answered.map((row) => [row.id, row.answer])).toEqual([["d2", "b)"]]);
    });

    test("buildDigest adds files per repo, and a repo whose numstat fails becomes a warning", async () => {
        const deps: DigestDeps = {
            timeline: async () => ({ ...timeline(events), repos: ["/work/shop", "/work/docs"] }),
            numstat: async (repo) => {
                if (repo === "/work/docs") {
                    throw new Error("not a git repository");
                }

                return "10\t2\tsrc/cart.ts\n1\t1\tREADME.md\n";
            },
            decisions: () => [decision({ id: "d1", createdTs: "2026-03-02T08:00:00Z" })],
        };
        const digest = await buildDigest({ window, deps, now: NOW });
        expect(digest.files).toMatchObject({ total: 2, added: 11, removed: 3 });
        expect(digest.files.repos[0].paths[0]).toEqual({ path: "src/cart.ts", added: 10, removed: 2 });
        expect(digest.warnings.some((warning) => warning.includes("docs"))).toBe(true);

        const markdown = digestMarkdown(digest);
        expect(markdown).toContain("# Agents digest 2026-03-02");
        expect(markdown).toContain("## Files changed");
        expect(markdown).toContain("[work/shop#4](https://example.com/4)");
        expect(markdown).toContain("posted #1 Pick a cache TTL");
        expect(markdown).toContain("> [!warning] Incomplete");
    });
});

describe("forecast", () => {
    function sample(overrides: Partial<UsageSample> & Pick<UsageSample, "utilization" | "timestamp">): UsageSample {
        return {
            provider: "anthropic-sub",
            account: "work",
            bucket: "five_hour",
            kind: "session",
            resetsAt: null,
            ...overrides,
        };
    }

    test("a 5h window burning at the active rate runs out before its reset", () => {
        const resetsAt = new Date(NOW.getTime() + 3 * 3_600_000).toISOString();
        const samples = [0, 10, 20, 30, 40].map((minutes, index) =>
            sample({ utilization: 50 + index * 5, timestamp: isoAgo(40 - minutes), resetsAt })
        );
        const window = forecastWindow(samples, NOW);
        expect(window).not.toBeNull();
        expect(window?.basis).toBe("active");
        expect(window?.ratePctPerHour).toBe(30);
        // 70 % at the last sample, 30 %/h: 100 % in one hour, three hours before the reset.
        expect(window?.minutesToExhaust).toBe(60);
        expect(window?.beforeReset).toBe(true);
        expect(window?.projectedAtReset).toBe(160);
        expect(window?.stale).toBe(false);
    });

    test("a weekly window uses its own average since it started, idle time included", () => {
        const resetsAt = new Date(NOW.getTime() + 4 * 24 * 3_600_000).toISOString();
        const window = forecastWindow(
            [
                sample({ bucket: "seven_day", kind: "weekly", utilization: 20, timestamp: isoAgo(24 * 60), resetsAt }),
                sample({ bucket: "seven_day", kind: "weekly", utilization: 30, timestamp: isoAgo(0), resetsAt }),
            ],
            NOW
        );
        // 3 days of a 7-day window gone at 30 %: 10 %/day, 70 % at the reset, no warning.
        expect(window?.basis).toBe("window");
        expect(window?.beforeReset).toBe(false);
        expect(window?.projectedAtReset).toBe(70);
        expect(window?.label).toBe("Weekly");
    });

    test("a weekly window a few hours after its reset averages over a full day, not over its busy hours", () => {
        const resetsAt = new Date(NOW.getTime() + (7 * 24 - 3) * 3_600_000).toISOString();
        const window = forecastWindow(
            [sample({ bucket: "seven_day", kind: "weekly", utilization: 3, timestamp: isoAgo(0), resetsAt })],
            NOW
        );
        // 3 % over 3 h is 1 %/h and "runs out in 4 days"; over a day it is 0.125 %/h and lasts the week.
        expect(window?.ratePctPerHour).toBe(0.13);
        expect(window?.beforeReset).toBe(false);
    });

    test("a stale weekly window projects nothing: the account may have been idle since its last sample", () => {
        const resetsAt = new Date(NOW.getTime() + 3 * 24 * 3_600_000).toISOString();
        const window = forecastWindow(
            [
                sample({ bucket: "seven_day", kind: "weekly", utilization: 40, timestamp: isoAgo(72 * 60), resetsAt }),
                sample({ bucket: "seven_day", kind: "weekly", utilization: 55, timestamp: isoAgo(48 * 60), resetsAt }),
            ],
            NOW
        );
        expect(window).toMatchObject({ stale: true, exhaustAt: null, beforeReset: false, utilization: 55 });
        expect(
            forecastFromSamples([sample({ utilization: 90, timestamp: isoAgo(24 * 60) })], NOW)[0]?.warning
        ).toBeNull();
    });

    test("a window whose reset passed after the last sample forecasts nothing", () => {
        const window = forecastWindow([sample({ utilization: 90, timestamp: isoAgo(400), resetsAt: isoAgo(60) })], NOW);
        expect(window).toMatchObject({ resetSinceSample: true, exhaustAt: null, stale: true });
    });

    test("groups by account and names the earliest window that runs out first", () => {
        const resetsAt = new Date(NOW.getTime() + 3 * 3_600_000).toISOString();
        const accounts = forecastFromSamples(
            [
                ...[0, 10, 20, 30].map((minutes, index) =>
                    sample({ utilization: 60 + index * 10, timestamp: isoAgo(30 - minutes), resetsAt })
                ),
                sample({ account: "side", utilization: 5, timestamp: isoAgo(5) }),
                sample({ account: "side", utilization: 5, timestamp: isoAgo(1) }),
            ],
            NOW
        );
        expect(accounts.map((account) => account.account)).toEqual(["side", "work"]);
        expect(accounts[1].warning).toContain("5h runs out");
        expect(accounts[0].warning).toBeNull();
        expect(accounts[0].windows[0].exhaustAt).toBeNull();
    });
});

describe("rules", () => {
    const session = (overrides: Partial<RuleSession> & { sessionId: string }): RuleSession => ({
        provider: "claude",
        title: "Cart fix",
        project: "shop",
        cwd: "/work/shop",
        lastActivityMs: minutesAgo(45),
        contextTokens: null,
        model: null,
        ...overrides,
    });
    const inputs = (overrides: Partial<RuleInputs> = {}): RuleInputs => ({
        sessions: [],
        decisions: [],
        prs: [],
        postedCi: [],
        ...overrides,
    });
    const rule = (overrides: Partial<HubRule> & Pick<HubRule, "kind">): HubRule => ({
        id: `r_${overrides.kind}`,
        enabled: true,
        ...overrides,
    });

    test("the first evaluation takes a baseline, the next one notifies only what is new", () => {
        const config = { rules: [rule({ kind: "decision" })] };
        const first = evaluateRules({
            config,
            state: emptyRulesState(),
            inputs: inputs({ decisions: [decision({ id: "d1" })] }),
            now: NOW,
        });
        expect(first.firings).toEqual([]);
        expect(first.reports[0]).toMatchObject({ seeded: true, matches: 1, fired: 0 });

        const second = evaluateRules({
            config,
            state: first.state,
            inputs: inputs({ decisions: [decision({ id: "d1" }), decision({ id: "d2", number: 2, sessionId: "s9" })] }),
            now: NOW,
        });
        expect(second.firings.map((firing) => firing.key)).toEqual(["d2"]);
        expect(second.firings[0].target).toEqual({ sessionId: "s9", tab: "decisions" });
    });

    test("idle: notifies once per quiet stretch, again after the session works and stops again", () => {
        const config = { rules: [rule({ kind: "idle", minutes: 30 })] };
        const seeded = { ...emptyRulesState(), seeded: { r_idle: true } };
        const quiet = evaluateRules({
            config,
            state: seeded,
            inputs: inputs({ sessions: [session({ sessionId: "s1" })] }),
            now: NOW,
        });
        expect(quiet.firings).toHaveLength(1);
        expect(quiet.firings[0].message).toBe("No activity for 45 min");

        const same = evaluateRules({
            config,
            state: quiet.state,
            inputs: inputs({ sessions: [session({ sessionId: "s1" })] }),
            now: NOW,
        });
        expect(same.firings).toEqual([]);

        const again = evaluateRules({
            config,
            state: same.state,
            inputs: inputs({ sessions: [session({ sessionId: "s1", lastActivityMs: minutesAgo(31) })] }),
            now: NOW,
        });
        expect(again.firings).toHaveLength(1);

        // Busy sessions and ones idle for far longer than the threshold are not news.
        const none = evaluateRules({
            config,
            state: seeded,
            inputs: inputs({
                sessions: [
                    session({ sessionId: "busy", lastActivityMs: minutesAgo(5) }),
                    session({ sessionId: "old", lastActivityMs: minutesAgo(9 * 60) }),
                ],
            }),
            now: NOW,
        });
        expect(none.firings).toEqual([]);
    });

    test("context: fires over the threshold, re-arms after the session drops below it", () => {
        const config = { rules: [rule({ kind: "context", percent: 80 })] };
        const seeded = { ...emptyRulesState(), seeded: { r_context: true } };
        const full = session({
            sessionId: "s1",
            contextTokens: 170_000,
            model: "no-such-model",
            lastActivityMs: minutesAgo(2),
        });
        const over = evaluateRules({ config, state: seeded, inputs: inputs({ sessions: [full] }), now: NOW });
        expect(over.firings[0].message).toBe("Context at 85% (170k tokens)");

        const compacted = evaluateRules({
            config,
            state: over.state,
            inputs: inputs({ sessions: [{ ...full, contextTokens: 20_000 }] }),
            now: NOW,
        });
        expect(compacted.firings).toEqual([]);
        const refilled = evaluateRules({
            config,
            state: compacted.state,
            inputs: inputs({ sessions: [full] }),
            now: NOW,
        });
        expect(refilled.firings).toHaveLength(1);
    });

    test("contextWindowFor falls back to 200k and moves to the long-context window past it", () => {
        expect(contextWindowFor(null, 10_000)).toBe(200_000);
        expect(contextWindowFor(null, 450_000)).toBe(1_000_000);
    });

    test("ciFailed: a failing PR notifies unless the PR poller already posted it lately; the filter narrows", () => {
        const state: NotifyState = {
            lastPollAt: null,
            prs: {
                "github.com/work/shop#4": {
                    state: "OPEN",
                    threadIds: [],
                    botReviewIds: [],
                    ciSeen: "abc123:failed",
                    notes: null,
                    seenAt: isoAgo(1),
                },
                "github.com/work/shop#5": {
                    state: "OPEN",
                    threadIds: [],
                    botReviewIds: [],
                    ciSeen: "def456:success",
                    notes: null,
                    seenAt: isoAgo(1),
                },
                "github.com/work/side#6": {
                    state: "OPEN",
                    threadIds: [],
                    botReviewIds: [],
                    ciSeen: "fff000:failed",
                    notes: null,
                    seenAt: isoAgo(1),
                },
                "github.com/work/shop#7": {
                    state: "MERGED",
                    threadIds: [],
                    botReviewIds: [],
                    ciSeen: "eee000:failed",
                    notes: null,
                    seenAt: isoAgo(1),
                },
            },
            repos: {},
            hosts: {},
            recent: [
                {
                    type: "ciFailed",
                    key: "github.com/work/side#6",
                    provider: "github",
                    project: "work/side",
                    number: 6,
                    url: "https://example.com/6",
                    title: "Side PR",
                    message: "CI failed",
                    at: isoAgo(10),
                    posted: true,
                },
            ],
            requests: [],
        };
        const pr = rulePrsFromNotifyState(state);
        expect(pr.prs.map((entry) => entry.ref).sort()).toEqual(["work/shop#4", "work/shop#5", "work/side#6"]);

        const seeded = { ...emptyRulesState(), seeded: { r_ciFailed: true, r_narrow: true } };
        const result = evaluateRules({
            config: { rules: [rule({ kind: "ciFailed" }), rule({ id: "r_narrow", kind: "ciFailed", match: "side" })] },
            state: seeded,
            inputs: inputs(pr),
            now: NOW,
        });
        expect(result.firings.map((firing) => [firing.ruleId, firing.key])).toEqual([
            ["r_ciFailed", "github.com/work/shop#4@abc123"],
        ]);
        expect(result.firings[0].target).toEqual({ pr: "work/shop#4" });

        // The failure the poller posted is recorded as seen, so it cannot notify later once the
        // suppression window has passed; only a new head would.
        expect(result.state.fired.r_narrow).toHaveProperty(["github.com/work/side#6@fff000"]);
        const later = evaluateRules({
            config: { rules: [rule({ id: "r_narrow", kind: "ciFailed", match: "side" })] },
            state: result.state,
            inputs: { ...inputs(pr), postedCi: [] },
            now: new Date(NOW.getTime() + 3 * 3_600_000),
        });
        expect(later.firings).toEqual([]);
    });

    test("ciFailed: the poller's recent post mutes only the head it named; a new failing head still notifies", () => {
        const side = {
            key: "github.com/work/side#6",
            ref: "work/side#6",
            title: "Side PR",
            url: null,
            sha: "fff000",
            ci: "failed" as const,
        };
        const run = (postedSha: string | null) =>
            evaluateRules({
                config: { rules: [rule({ id: "r_side", kind: "ciFailed" })] },
                state: { ...emptyRulesState(), seeded: { r_side: true } },
                inputs: {
                    ...inputs({}),
                    prs: [side],
                    postedCi: [{ key: side.key, atMs: minutesAgo(10), sha: postedSha }],
                },
                now: NOW,
            });

        expect(run("aaa1111").firings.map((firing) => firing.key)).toEqual(["github.com/work/side#6@fff000"]);
        expect(run("fff000").firings).toEqual([]);
        // An older poller entry that did not record its head keeps muting, as before.
        expect(run(null).firings).toEqual([]);
    });

    test("an invalid or disabled rule does not evaluate, and a deleted rule's memory is dropped", () => {
        const state = { seeded: { gone: true }, fired: { gone: { k: isoAgo(1) } }, lastRunAt: null };
        const result = evaluateRules({
            config: { rules: [rule({ kind: "idle" }), rule({ id: "off", kind: "decision", enabled: false })] },
            state,
            inputs: inputs({ decisions: [decision({ id: "d1" })] }),
            now: NOW,
        });
        expect(result.reports.map((report) => [report.id, report.problem !== null, report.matches])).toEqual([
            ["r_idle", true, 0],
            ["off", false, 0],
        ]);
        expect(result.state.fired.gone).toBeUndefined();
    });

    test("config normalising drops junk and duplicates; addRule validates the threshold", () => {
        const config = normalizeRulesConfig({
            rules: [
                { id: "a", kind: "idle", minutes: 30 },
                { id: "a", kind: "decision" },
                { id: "b", kind: "nope" },
                "junk",
            ],
        });
        expect(config.rules).toEqual([{ id: "a", kind: "idle", enabled: true, minutes: 30 }]);
        expect(() => addRule(config, { kind: "context" })).toThrow("--percent");
        const added = addRule(config, { kind: "context", percent: 90, project: "shop" });
        expect(added).toMatchObject({ kind: "context", percent: 90, project: "shop", enabled: true });
        expect(config.rules).toHaveLength(2);
    });

    test("click commands open the hub at the PR or the session's Decisions pane", () => {
        expect(prRefFromKey("github.com/work/shop#4")).toBe("work/shop#4");
        expect(ruleClickCommand({ pr: "work/shop#4" }, "/Apps/G.app")).toContain("'--mode' 'prs' '--pr' 'work/shop#4'");
        expect(ruleClickCommand({ sessionId: "s1", tab: "decisions" }, "/Apps/G.app")).toContain(
            "'--session' 's1' '--tab' 'decisions'"
        );
    });

    test("runRules --dry-run posts nothing and saves nothing; a real run posts and saves under the lock", async () => {
        const dir = mkdtempSync(join(tmpdir(), "hub-rules-"));
        const statePath = join(dir, "rules-state.json");
        const posted: string[] = [];
        const shared = {
            now: NOW,
            statePath,
            readConfig: async () => ({ rules: [rule({ kind: "decision" })] }),
            inputs: async () => inputs({ decisions: [decision({ id: "d1" })] }),
            post: async (firing: { key: string }) => {
                posted.push(firing.key);
                return true;
            },
        };

        const seed = await runRules(shared);
        expect(seed.reports[0].seeded).toBe(true);
        const dry = await runRules({
            ...shared,
            dryRun: true,
            inputs: async () => inputs({ decisions: [decision({ id: "d1" }), decision({ id: "d2" })] }),
        });
        expect(dry.firings.map((firing) => firing.key)).toEqual(["d2"]);
        expect(posted).toEqual([]);

        const real = await runRules({
            ...shared,
            inputs: async () => inputs({ decisions: [decision({ id: "d1" }), decision({ id: "d2" })] }),
        });
        expect(real.posted).toBe(1);
        expect(posted).toEqual(["d2"]);
        const none = await runRules({ ...shared, readConfig: async () => ({ rules: [] }) });
        expect(none.skipped).toContain("no rules");
    });

    test("a notification that fails to post fires again on the next run", async () => {
        const dir = mkdtempSync(join(tmpdir(), "hub-rules-"));
        const statePath = join(dir, "rules-state.json");
        let deliver = false;
        const attempts: string[] = [];
        const shared = {
            now: NOW,
            statePath,
            readConfig: async () => ({ rules: [rule({ kind: "decision" })] }),
            inputs: async () => inputs({ decisions: [decision({ id: "d1" }), decision({ id: "d2" })] }),
            post: async (firing: { key: string }) => {
                attempts.push(firing.key);
                return deliver;
            },
        };

        await runRules({ ...shared, inputs: async () => inputs({ decisions: [decision({ id: "d1" })] }) });
        const failed = await runRules(shared);
        expect(failed.posted).toBe(0);

        deliver = true;
        const retried = await runRules(shared);
        expect(retried.posted).toBe(1);
        expect(attempts).toEqual(["d2", "d2"]);
        // Delivered once, it stays sent.
        expect((await runRules(shared)).posted).toBe(0);
    });
});
