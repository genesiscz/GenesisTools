import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexFinishedTurn } from "@genesiscz/utils/codex/turn-cost";
import type { NumstatEntry, PrInfo } from "@genesiscz/utils/git";
import { SafeJSON } from "@genesiscz/utils/json";
import type { ReviewManifest } from "@genesiscz/utils/worker/contract";
import { codexDriver } from "../driver";
import { spawnCodexSession } from "../spawn";
import { escalatedReviewName, markReviewShallow, recordReviewTurn } from "./controller";
import { checkReview, decideGate, parseReviewReport } from "./gate";
import { type ReviewLedgerRecord, readReviewRecords } from "./ledger";
import { prepareReview, type ReviewGitReaders } from "./prepare";
import { filterReviews, parseReviewSince, reviewTotals, summarizeReviews } from "./report";
import type { CodexReviewConfig } from "./types";

function entry(path: string, insertions: number, deletions = 0, binary = false): NumstatEntry {
    return { path, insertions, deletions, binary };
}

function readers(options: {
    branch?: string | null;
    pr?: PrInfo | null;
    upstream?: string | null;
    numstat?: NumstatEntry[];
    refs?: string[];
}): ReviewGitReaders & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        currentBranch: async () => (options.branch === undefined ? "feat/x" : options.branch),
        resolveBranch: async (_cwd, name) =>
            (options.refs ?? ["origin/master"]).includes(`origin/${name}`) ? `origin/${name}` : null,
        refExists: async (_cwd, ref) => (options.refs ?? ["origin/master"]).includes(ref),
        pullRequest: async () => options.pr ?? null,
        upstream: async () => options.upstream ?? null,
        numstat: async (_cwd, base, paths) => {
            calls.push(`numstat ${base}${paths ? ` ${paths.join(",")}` : ""}`);
            return options.numstat ?? [entry("src/a.ts", 40, 2)];
        },
    };
}

const PR: PrInfo = { number: 12, state: "OPEN", target: "master", url: "https://example.com/pr/12" };

describe("prepareReview", () => {
    test("--base is verified and used; the PR number is still recorded", async () => {
        const fake = readers({ pr: PR });
        const prepared = await prepareReview({ cwd: "/repo", base: "origin/master", readers: fake });

        expect(prepared.config).toMatchObject({ base: "origin/master", baseSource: "flag", pr: 12, branch: "feat/x" });
        expect(prepared.notes[0]).toBe("review base origin/master (flag: --base)");
        expect(fake.calls).toEqual(["numstat origin/master"]);
        await expect(prepareReview({ cwd: "/repo", base: "origin/nope", readers: fake })).rejects.toThrow(
            "--base origin/nope does not resolve"
        );
    });

    test("without --base: the PR target first, then an upstream that is not the branch itself", async () => {
        const fromPr = await prepareReview({ cwd: "/repo", readers: readers({ pr: PR }) });
        expect(fromPr.config).toMatchObject({ base: "origin/master", baseSource: "pr", pr: 12 });
        expect(fromPr.notes[0]).toBe("review base origin/master (pr: OPEN PR #12 targets master)");

        const fromUpstream = await prepareReview({ cwd: "/repo", readers: readers({ upstream: "origin/develop" }) });
        expect(fromUpstream.config).toMatchObject({ base: "origin/develop", baseSource: "upstream" });

        await expect(prepareReview({ cwd: "/repo", readers: readers({ upstream: "origin/feat/x" }) })).rejects.toThrow(
            "--mode review needs --base <ref>: feat/x has no PR"
        );
        await expect(prepareReview({ cwd: "/repo", readers: readers({ branch: null }) })).rejects.toThrow(
            "HEAD is detached"
        );
    });

    test("an empty diff is refused; --paths reaches the numstat", async () => {
        await expect(
            prepareReview({ cwd: "/repo", base: "origin/master", readers: readers({ numstat: [] }) })
        ).rejects.toThrow("Nothing to review");

        const fake = readers({});
        await prepareReview({ cwd: "/repo", base: "origin/master", paths: ["src/codex"], readers: fake });
        expect(fake.calls).toEqual(["numstat origin/master src/codex"]);
    });

    test("the tier comes from the diff size; low and medium need --allow-shallow", async () => {
        const small = await prepareReview({ cwd: "/repo", base: "origin/master", readers: readers({}) });
        expect(small.config).toMatchObject({ effort: "high", effortSource: "diff-size" });

        const many = Array.from({ length: 16 }, (_, i) => entry(`src/f${i}.ts`, 10));
        const large = await prepareReview({ cwd: "/repo", base: "origin/master", readers: readers({ numstat: many }) });
        expect(large.config.effort).toBe("xhigh");

        const long = await prepareReview({
            cwd: "/repo",
            base: "origin/master",
            readers: readers({ numstat: [entry("src/a.ts", 801)] }),
        });
        expect(long.config.effort).toBe("xhigh");

        const base = { cwd: "/repo", base: "origin/master", readers: readers({}) };
        await expect(prepareReview({ ...base, effort: "medium" })).rejects.toThrow("--effort medium is refused");
        await expect(prepareReview({ ...base, effort: "low" })).rejects.toThrow("--allow-shallow");
        await expect(prepareReview({ ...base, effort: "huge" })).rejects.toThrow("must be one of low, medium");
        expect((await prepareReview({ ...base, effort: "medium", allowShallow: true })).config).toMatchObject({
            effort: "medium",
            effortSource: "flag",
            allowShallow: true,
        });
        expect((await prepareReview({ ...base, effort: "max" })).config.effort).toBe("max");
    });

    test("above 60 files the spawn proposes one reviewer per folder, split below a shared src/", async () => {
        const files = [
            ...Array.from({ length: 40 }, (_, i) => entry(`src/codex/f${i}.ts`, 5)),
            ...Array.from({ length: 30 }, (_, i) => entry(`src/utils/g${i}.ts`, 5)),
        ];
        const prepared = await prepareReview({
            cwd: "/repo",
            base: "origin/master",
            readers: readers({ numstat: files }),
        });

        expect(prepared.warnings).toHaveLength(1);
        expect(prepared.warnings[0]).toContain("src/codex (40 files, +200 -0), src/utils (30 files, +150 -0)");
        expect(prepared.warnings[0]).toContain("--paths <folder>");

        const smallDiff = await prepareReview({ cwd: "/repo", base: "origin/master", readers: readers({}) });
        expect(smallDiff.warnings).toEqual([]);
    });
});

const MANIFEST: ReviewManifest = {
    base: "origin/master",
    files: [
        { path: "src/a.ts", added: 60, deleted: 10 },
        { path: "src/b.ts", added: 20, deleted: 0 },
        { path: "src/c.ts", added: 10, deleted: 0 },
        { path: "assets/logo.png", added: 0, deleted: 0, binary: true },
    ],
    added: 90,
    deleted: 10,
};

const GOOD_REPORT = [
    "1. **[High]** src/a.ts:12 - the lock is never released. Scenario: a throw inside the callback. Fix: release in finally.",
    "2. [Low] src/b.ts:3 - stale comment.",
    "   Scenario: a reader trusts it. Fix: delete it.",
    "Ran: bun test src/a.test.ts",
    "Files reviewed: 3 of 4",
    "Not reviewed: assets/logo.png (binary image)",
    "RESULT: done",
].join("\n");

describe("the depth gate", () => {
    test("parses the review shape, markdown and wrapped findings included", () => {
        const parsed = parseReviewReport(GOOD_REPORT);

        expect(parsed.coverage).toEqual({ reviewed: 3, total: 4 });
        expect(parsed.notReviewed).toEqual([{ path: "assets/logo.png", reason: "binary image" }]);
        expect(parsed.findings.map((finding) => [finding.index, finding.ok])).toEqual([
            [1, true],
            [2, true],
        ]);
        expect(parsed.ran).toBe(true);
    });

    test("passes a full review: a named binary file with a reason is excused", () => {
        const checks = checkReview({ report: GOOD_REPORT, manifest: MANIFEST, effort: "high", reasoningTokens: 400 });

        expect(checks.coverage).toMatchObject({ ok: true, reviewed: 3, total: 4, unread: [] });
        expect(checks.reasoning).toMatchObject({ ok: true, per100Lines: 400, floor: 100 });
        expect(checks.shape.ok).toBe(true);
        expect(decideGate(checks, { effort: "high", step: 0, allowShallow: false }).verdict).toBe("pass");
    });

    test("names the unread files: the Not reviewed line, else the manifest files the report never mentions", () => {
        const named = checkReview({
            report: GOOD_REPORT.replace("Files reviewed: 3 of 4", "Files reviewed: 2 of 4").replace(
                "Not reviewed: assets/logo.png (binary image)",
                "Not reviewed: src/c.ts (ran out of time), assets/logo.png (binary image)"
            ),
            manifest: MANIFEST,
            effort: "high",
            reasoningTokens: 400,
        });
        expect(named.coverage).toMatchObject({ ok: false, unread: ["src/c.ts"] });

        const silent = checkReview({
            report: GOOD_REPORT.replace("Files reviewed: 3 of 4", "Files reviewed: 2 of 4").replace(
                "Not reviewed: assets/logo.png (binary image)",
                "Not reviewed: none"
            ),
            manifest: MANIFEST,
            effort: "high",
            reasoningTokens: 400,
        });
        expect(silent.coverage.unread).toEqual(["src/c.ts", "assets/logo.png"]);

        const missing = checkReview({ report: "1. nothing", manifest: MANIFEST, effort: "high", reasoningTokens: 400 });
        expect(missing.coverage).toMatchObject({
            ok: false,
            reviewed: null,
            detail: "no `Files reviewed: n of N` line",
        });
        expect(missing.shape).toMatchObject({ ok: false, malformed: [1] });
    });

    test("holds each tier to its reasoning floor per 100 changed lines", () => {
        const thin = checkReview({ report: GOOD_REPORT, manifest: MANIFEST, effort: "xhigh", reasoningTokens: 200 });
        expect(thin.reasoning).toMatchObject({ ok: false, per100Lines: 200, floor: 250 });
        expect(
            checkReview({ report: GOOD_REPORT, manifest: MANIFEST, effort: "high", reasoningTokens: 99 }).reasoning.ok
        ).toBe(false);
        expect(
            checkReview({ report: GOOD_REPORT, manifest: MANIFEST, effort: "high", reasoningTokens: null }).reasoning
        ).toMatchObject({ ok: true, detail: "reasoning tokens unknown" });
    });

    test("steers once, escalates once, then ends shallow; --allow-shallow tiers are never tuned up", () => {
        const miss = checkReview({
            report: "Ran: nothing\nFindings: none",
            manifest: MANIFEST,
            effort: "high",
            reasoningTokens: 10,
        });

        const first = decideGate(miss, { effort: "high", step: 0, allowShallow: false });
        expect(first.verdict).toBe("steered");
        expect(first.steer).toContain("You did not read: src/a.ts, src/b.ts, src/c.ts, assets/logo.png.");
        expect(first.steer).toContain("Depth: 10 reasoning tokens per 100 changed lines, high floor 100.");
        expect(first.steer).toContain("`Files reviewed: <n> of 4`");

        expect(decideGate(miss, { effort: "high", step: 1, allowShallow: false })).toMatchObject({
            verdict: "escalated",
            nextEffort: "xhigh",
        });
        expect(decideGate(miss, { effort: "max", step: 1, allowShallow: false }).reason).toContain("no tier above max");
        expect(decideGate(miss, { effort: "xhigh", step: 2, allowShallow: false })).toMatchObject({
            verdict: "shallow",
        });
        expect(decideGate(miss, { effort: "medium", step: 0, allowShallow: true }).verdict).toBe("shallow");
        expect(decideGate(miss, { effort: "low", step: 0, allowShallow: true }).verdict).toBe("shallow");
    });
});

function finishedTurn(over: Partial<CodexFinishedTurn> = {}): CodexFinishedTurn {
    return {
        turn: 1,
        outcome: "completed",
        startedAt: new Date("2026-10-22T10:00:00Z"),
        endedAt: new Date("2026-10-22T10:05:00Z"),
        durationMs: 300_000,
        parts: [{ model: "gpt-x", tokens: { input: 900, cacheRead: 0, cacheWrite: 0, output: 600, reasoning: 50 } }],
        toolCalls: 12,
        model: "gpt-x",
        auth: "subscription",
        ...over,
    };
}

function reviewConfig(over: Partial<CodexReviewConfig> = {}): CodexReviewConfig {
    return {
        base: "origin/master",
        baseSource: "pr",
        baseDetail: "OPEN PR #12 targets master",
        branch: "feat/x",
        pr: 12,
        manifest: MANIFEST,
        effort: "high",
        effortSource: "diff-size",
        allowShallow: false,
        step: 0,
        chain: "rv",
        ...over,
    };
}

describe("recordReviewTurn", () => {
    test("a miss steers the same session and logs a turn line and a gate line", () => {
        const ledgerPath = join(mkdtempSync(join(tmpdir(), "gt-review-ledger-")), "reviews.jsonl");
        const outcome = recordReviewTurn({
            name: "rv",
            label: "babysit pr12",
            review: reviewConfig(),
            finished: finishedTurn(),
            report: "Ran: nothing\nFindings: none\nFiles reviewed: 1 of 4\nNot reviewed: none",
            costUsd: 0.4,
            ledgerPath,
        });

        expect(outcome.action.kind).toBe("steer");
        expect(outcome.review).toMatchObject({ verdict: "steered", step: 1 });
        expect(outcome.review.spent).toEqual({
            turns: 1,
            durationMs: 300_000,
            toolCalls: 12,
            reasoningTokens: 50,
            outputTokens: 600,
            costUsd: 0.4,
        });

        const { records } = readReviewRecords(ledgerPath);
        expect(records.map((record) => record.kind)).toEqual(["turn", "gate"]);
        expect(records[0]).toMatchObject({
            name: "rv",
            label: "babysit pr12",
            pr: 12,
            base: "origin/master",
            files: 4,
            lines: 100,
            effort: "high",
            coverage: { reviewed: 1, total: 4 },
            reasoningTokens: 50,
        });
        expect(records[1]).toMatchObject({ verdict: "steered", step: 1, reasoningPer100Lines: 50, floor: 100 });

        const second = recordReviewTurn({
            name: "rv",
            review: outcome.review,
            finished: finishedTurn({ turn: 2 }),
            report: "Ran: nothing\nFindings: none\nFiles reviewed: 2 of 4\nNot reviewed: none",
            costUsd: 0.2,
            ledgerPath,
        });
        expect(second.action).toEqual({
            kind: "escalate",
            effort: "xhigh",
            name: escalatedReviewName({ chain: "rv" }, "xhigh"),
        });
        expect(second.review).toMatchObject({ verdict: "escalated", step: 2, escalatedTo: "rv-xhigh" });
        expect(second.review.spent?.reasoningTokens).toBe(100);
    });

    test("a failed turn and a follow-up after a final verdict are booked without the gate", () => {
        const ledgerPath = join(mkdtempSync(join(tmpdir(), "gt-review-ledger-")), "reviews.jsonl");
        const failed = recordReviewTurn({
            name: "rv",
            review: reviewConfig(),
            finished: finishedTurn({ outcome: "failed" }),
            report: "",
            costUsd: null,
            ledgerPath,
        });
        expect(failed).toMatchObject({ action: { kind: "none" } });
        expect(failed.decision).toBeUndefined();
        expect(failed.review.spent?.costUsd).toBeNull();

        const followUp = recordReviewTurn({
            name: "rv",
            review: reviewConfig({ verdict: "pass" }),
            finished: finishedTurn(),
            report: "",
            costUsd: 0.1,
            ledgerPath,
        });
        expect(followUp.decision).toBeUndefined();
        expect(readReviewRecords(ledgerPath).records.map((record) => record.kind)).toEqual(["turn", "turn"]);

        const shallow = markReviewShallow({
            name: "rv",
            review: reviewConfig({ verdict: "steered" }),
            reason: "steer failed",
            ledgerPath,
        });
        expect(shallow.verdict).toBe("shallow");
        expect(readReviewRecords(ledgerPath).records.at(-1)).toMatchObject({
            kind: "gate",
            verdict: "shallow",
            reason: "steer failed",
        });
    });
});

function ledgerFixture(): ReviewLedgerRecord[] {
    const base = {
        v: 1 as const,
        chain: "rv",
        base: "origin/master",
        files: 4,
        lines: 100,
        pr: 12,
        label: "babysit pr12",
    };
    const spent = {
        turns: 2,
        durationMs: 600_000,
        toolCalls: 30,
        reasoningTokens: 600,
        outputTokens: 900,
        costUsd: 0.9,
    };
    return [
        {
            ...base,
            kind: "start",
            ts: "2026-10-22T10:00:00Z",
            name: "rv",
            effort: "high",
            cwd: "/repo",
            effortSource: "diff-size",
            allowShallow: false,
        },
        {
            ...base,
            kind: "turn",
            ts: "2026-10-22T10:05:00Z",
            name: "rv",
            effort: "high",
            turn: 1,
            outcome: "completed",
            model: "gpt-x",
            durationMs: 300_000,
            toolCalls: 10,
            reasoningTokens: 50,
            outputTokens: 300,
            costUsd: 0.4,
            coverage: { reviewed: 1, total: 4 },
        },
        {
            ...base,
            kind: "gate",
            ts: "2026-10-22T10:05:01Z",
            name: "rv",
            effort: "high",
            step: 1,
            verdict: "escalated",
            reason: "coverage: 1 of 4",
            coverage: { reviewed: 1, total: 4 },
            reasoningPer100Lines: 50,
            floor: 100,
            findings: 0,
            malformedFindings: 0,
            unread: ["src/b.ts"],
            escalatedTo: "rv-xhigh",
            spent,
        },
        {
            ...base,
            kind: "start",
            ts: "2026-10-22T10:06:00Z",
            name: "rv-xhigh",
            effort: "xhigh",
            cwd: "/repo",
            effortSource: "flag",
            allowShallow: false,
            parent: "rv",
        },
        {
            ...base,
            kind: "turn",
            ts: "2026-10-22T10:20:00Z",
            name: "rv-xhigh",
            effort: "xhigh",
            turn: 1,
            outcome: "completed",
            model: "gpt-x",
            durationMs: 840_000,
            toolCalls: 60,
            reasoningTokens: 3000,
            outputTokens: 900,
            costUsd: 1.5,
            coverage: { reviewed: 4, total: 4 },
        },
        {
            ...base,
            kind: "gate",
            ts: "2026-10-22T10:20:01Z",
            name: "rv-xhigh",
            effort: "xhigh",
            step: 2,
            verdict: "pass",
            reason: "4 of 4 files reviewed",
            coverage: { reviewed: 4, total: 4 },
            reasoningPer100Lines: 3000,
            floor: 250,
            findings: 3,
            malformedFindings: 0,
            unread: [],
            spent,
        },
    ];
}

describe("the review ledger report", () => {
    test("folds one row per review session, with the escalation linked both ways", () => {
        const reviews = summarizeReviews(ledgerFixture());

        expect(reviews.map((review) => [review.name, review.verdict, review.coverage, review.turns])).toEqual([
            ["rv", "escalated", "1/4", 1],
            ["rv-xhigh", "pass", "4/4", 1],
        ]);
        expect(reviews[0]).toMatchObject({ escalatedTo: "rv-xhigh", reasoningPer100Lines: 50, costUsd: 0.4, pr: 12 });
        expect(reviews[1]).toMatchObject({ parent: "rv", effort: "xhigh", reasoningPer100Lines: 3000, toolCalls: 60 });
        expect(reviewTotals(reviews)).toMatchObject({
            reviews: 2,
            turns: 2,
            toolCalls: 70,
            costUsd: 1.9,
            verdicts: { escalated: 1, pass: 1 },
        });
    });

    test("a reused session name starts a new review row at its start line", () => {
        const [start, turn] = ledgerFixture();
        const again = { ...start, ts: "2026-10-23T09:00:00Z" };
        const reviews = summarizeReviews([start, turn, again]);

        expect(reviews.map((review) => [review.name, review.turns, review.startedAt])).toEqual([
            ["rv", 1, "2026-10-22T10:00:00Z"],
            ["rv", 0, "2026-10-23T09:00:00Z"],
        ]);
    });

    test("filters by PR, label, tier, verdict, name and time", () => {
        const reviews = summarizeReviews(ledgerFixture());
        const names = (filters: Parameters<typeof filterReviews>[1]) =>
            filterReviews(reviews, filters).map((r) => r.name);

        expect(names({ pr: 12 })).toEqual(["rv", "rv-xhigh"]);
        expect(names({ pr: 13 })).toEqual([]);
        expect(names({ label: "PR12" })).toEqual(["rv", "rv-xhigh"]);
        expect(names({ effort: "xhigh" })).toEqual(["rv-xhigh"]);
        expect(names({ verdict: "escalated" })).toEqual(["rv"]);
        expect(names({ name: "xhigh" })).toEqual(["rv-xhigh"]);
        expect(names({ since: new Date("2026-10-22T10:10:00Z") })).toEqual(["rv-xhigh"]);
    });

    test("--since takes a duration back, a time today or a date", () => {
        const now = new Date("2026-10-22T12:00:00Z");

        expect(parseReviewSince("24h", now)?.toISOString()).toBe("2026-10-21T12:00:00.000Z");
        expect(parseReviewSince("90m", now)?.toISOString()).toBe("2026-10-22T10:30:00.000Z");
        expect(parseReviewSince("2026-10-01", now)?.getDate()).toBe(1);
        expect(parseReviewSince("bogus", now)).toBeNull();
    });

    test("a torn ledger line is skipped and counted, never fatal", () => {
        const path = join(mkdtempSync(join(tmpdir(), "gt-review-ledger-")), "reviews.jsonl");
        const [start] = ledgerFixture();
        appendFileSync(path, `${SafeJSON.stringify(start, { strict: true })}\n{"v":1,"kind":"tu\n{"other":true}\n`);

        expect(readReviewRecords(path)).toMatchObject({ records: [{ name: "rv", kind: "start" }], skipped: 2 });
        expect(readFileSync(path, "utf8").split("\n")).toHaveLength(4);
    });
});

describe("spawn guards", () => {
    test("--base, --allow-shallow and --paths are refused outside --mode review", async () => {
        const spawn = (extras: Record<string, unknown>) =>
            codexDriver.spawn({
                name: "x",
                cwd: "/repo",
                surfaces: { skills: true, rules: true },
                extras: { mode: "task", ...extras },
            });

        await expect(spawn({ base: "origin/master" })).rejects.toThrow("apply to --mode review only");
        await expect(spawn({ allowShallow: true })).rejects.toThrow("apply to --mode review only");
    });

    test("a review session cannot start without its review record, and a task session cannot carry one", async () => {
        await expect(spawnCodexSession({ name: "x", mode: "review" })).rejects.toThrow("needs its review record");
        await expect(spawnCodexSession({ name: "x", mode: "task", review: reviewConfig() })).rejects.toThrow(
            "needs its review record"
        );
    });
});
