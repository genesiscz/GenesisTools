import { describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerCostRow } from "@app/ai-spend/lib/workers/ledger";
import type { CodexFinishedTurn } from "@genesiscz/utils/codex/turn-cost";
import { env } from "@genesiscz/utils/env";
import type { NumstatEntry, PrInfo } from "@genesiscz/utils/git";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { ReviewManifest } from "@genesiscz/utils/worker/contract";
import { runImport } from "../../commands/reviews";
import { codexDriver } from "../driver";
import { spawnCodexSession } from "../spawn";
import type { CodexSessionMeta } from "../store";
import { escalatedReviewName, markReviewShallow, recordReviewTurn } from "./controller";
import { checkReview, decideGate, parseReviewReport } from "./gate";
import { importReviewSessions, type ReviewImportReaders } from "./import";
import { type ReviewGateRecord, type ReviewLedgerRecord, readReviewRecords } from "./ledger";
import { prepareReview, type ReviewGitReaders } from "./prepare";
import {
    currentReviewRecords,
    filterReviews,
    gateCheckRows,
    parseReviewSince,
    reviewTotals,
    summarizeReviews,
} from "./report";
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
    commitBefore?: (at: string) => string | null;
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
        numstat: async (_cwd, base, paths, head) => {
            calls.push(`numstat ${base}${head ? `...${head}` : ""}${paths ? ` ${paths.join(",")}` : ""}`);
            return options.numstat ?? [entry("src/a.ts", 40, 2)];
        },
        commitBefore: async (_cwd, at) => (options.commitBefore ? options.commitBefore(at) : null),
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

    test("a text file on the Not reviewed line fails coverage even when the count is full; a repeated binary counts once", () => {
        const admitted = checkReview({
            report: GOOD_REPORT.replace("Files reviewed: 3 of 4", "Files reviewed: 4 of 4").replace(
                "Not reviewed: assets/logo.png (binary image)",
                "Not reviewed: src/c.ts (ran out of time)"
            ),
            manifest: MANIFEST,
            effort: "high",
            reasoningTokens: 400,
        });
        expect(admitted.coverage).toMatchObject({ ok: false, unread: ["src/c.ts"] });
        expect(admitted.coverage.detail).toContain("Not reviewed names 1 text file(s)");

        const twoBinaries: ReviewManifest = {
            ...MANIFEST,
            files: [...MANIFEST.files, { path: "assets/icon.png", added: 0, deleted: 0, binary: true }],
        };
        const repeated = checkReview({
            report: GOOD_REPORT.replace("Files reviewed: 3 of 4", "Files reviewed: 3 of 5").replace(
                "Not reviewed: assets/logo.png (binary image)",
                "Not reviewed: assets/logo.png (binary image), assets/logo.png (binary image)"
            ),
            manifest: twoBinaries,
            effort: "high",
            reasoningTokens: 400,
        });
        expect(repeated.coverage.ok).toBe(false);
    });

    test("markdown is stripped around words, never inside a path: underscores and spaces in paths survive", () => {
        const manifest: ReviewManifest = {
            base: "origin/master",
            files: [
                { path: "src/my_mod.ts", added: 60, deleted: 10 },
                { path: "src/my file.ts", added: 30, deleted: 0 },
                { path: "assets/app_icon.png", added: 0, deleted: 0, binary: true },
            ],
            added: 90,
            deleted: 10,
        };
        const report = [
            "1. **[High]** src/my_mod.ts:12 - the lock leaks. Scenario: a throw. Fix: release in finally.",
            "2. [Medium] src/my file.ts:7 - stale read. Scenario: a retry. Fix: reload.",
            "__Ran:__ `bun test src/my_mod.test.ts`",
            "**Files reviewed:** 2 of 3",
            "_Not reviewed:_ `assets/app_icon.png` (binary image)",
        ].join("\n");
        const parsed = parseReviewReport(report);

        expect(parsed.notReviewed).toEqual([{ path: "assets/app_icon.png", reason: "binary image" }]);
        expect(parsed.findings.map((finding) => [finding.ok, finding.text.split(" - ")[0]])).toEqual([
            [true, "[High] src/my_mod.ts:12"],
            [true, "[Medium] src/my file.ts:7"],
        ]);
        expect(parsed.ran).toBe(true);

        const checks = checkReview({ report, manifest, effort: "high", reasoningTokens: 400 });
        expect(checks.coverage).toMatchObject({ ok: true, unread: [] });
        expect(checks.shape.ok).toBe(true);
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
        expect((records[1] as ReviewGateRecord).checks).toEqual({
            coverage: { ok: false, detail: "1 of 4 files reviewed" },
            reasoning: { ok: false, detail: "50 reasoning tokens per 100 changed lines, high floor 100" },
            shape: { ok: true, detail: "0 findings parse" },
        });

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

    test("review-depth reads only the current run of a reused name", () => {
        const [start, turn, gate] = ledgerFixture();
        const again = { ...start, ts: "2026-10-23T09:00:00Z" };

        expect(currentReviewRecords([start, turn, gate, again], "rv", "rv")).toEqual([again]);
        expect(currentReviewRecords([turn, gate], "rv", "rv")).toEqual([turn, gate]);
    });

    test("review-depth prints the checks the gate recorded, and approximates only for a line without them", () => {
        const gate = ledgerFixture()[2] as ReviewGateRecord;
        // 3 of 4 with an excused binary passed the gate; a missing Ran line failed shape with no malformed finding.
        const recorded: ReviewGateRecord = {
            ...gate,
            coverage: { reviewed: 3, total: 4 },
            unread: [],
            checks: {
                coverage: { ok: true, detail: "3 of 4 files reviewed" },
                reasoning: { ok: true, detail: "400 reasoning tokens per 100 changed lines, high floor 100" },
                shape: { ok: false, detail: "no `Ran:` line" },
            },
        };
        expect(gateCheckRows(recorded).map((row) => [row.label, row.ok, row.detail])).toEqual([
            ["coverage", true, "3 of 4 files reviewed"],
            ["reasoning", true, "400 reasoning tokens per 100 changed lines, high floor 100"],
            ["shape", false, "no `Ran:` line"],
        ]);

        // Without the recorded checks the counts are all there is: coverage reads as a miss, shape as clean.
        const { checks: _dropped, ...older } = recorded;
        expect(gateCheckRows(older).map((row) => [row.label, row.ok])).toEqual([
            ["coverage", false],
            ["reasoning", false],
            ["shape", true],
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

function importedMeta(name: string, over: Partial<CodexSessionMeta> = {}): CodexSessionMeta {
    return {
        name,
        daemonPid: 0,
        cwd: `/wt/${name}`,
        sandbox: "read-only",
        approvalPolicy: "never",
        writePolicy: "deny",
        status: "closed",
        agentName: `codex_${name}`,
        rendezvousSession: "s",
        agentsEnabled: true,
        startedAt: "2026-10-22T19:08:07.954Z",
        lastEventAt: "2026-10-22T19:30:24.784Z",
        codexVersion: "0.162.1",
        pendingApprovals: {},
        effort: "medium",
        label: `pr-split-review ${name}`,
        threadId: `thread-${name}`,
        ...over,
    };
}

function costRow(name: string, turn: number, over: Partial<WorkerCostRow> = {}): WorkerCostRow {
    return {
        v: 1,
        ts: `2026-10-22T19:1${turn}:00.000Z`,
        backend: "codex",
        name,
        sessionId: `thread-${name}`,
        turn,
        model: "gpt-6.1-sol",
        effort: "medium",
        auth: "subscription",
        account: null,
        durationMs: 100_000,
        toolCalls: 10,
        tokens: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 400, reasoning: 300 },
        cost: {
            apiEquivalentUsd: 0.5,
            basis: "catalog",
            pricedAs: ["gpt-6.1-sol"],
            longContextRequests: 0,
            auth: "subscription",
            billedUsd: 0,
            claudeEquivalent: { estimate: true, opusModel: "o", sonnetModel: "s", opusUsd: 1, sonnetUsd: 0.5 },
        },
        cwd: `/wt/${name}`,
        outcome: "completed",
        ...over,
    };
}

function importReaders(ledgerPath: string, options: { gone?: string[]; noBase?: boolean } = {}) {
    const git = readers({
        pr: options.noBase ? null : PR,
        numstat: [entry("src/a.ts", 30, 5), entry("src/b.ts", 10)],
        commitBefore: (at) => (at.startsWith("2026-10-22") ? "abc1234567890" : null),
    });
    const messages: Record<string, string> = {
        "rv-full":
            "1. [High] src/a.ts:3 - bug. Scenario: x. Fix: y.\nRan: bun test\nFiles reviewed: 2 of 2\nNot reviewed: none",
        "rv-part": "Findings: none\nRan: nothing\nFiles reviewed: 1 of 2\nNot reviewed: src/b.ts (time)",
        "rv-gone": "a summary without the coverage line",
    };
    const fake: ReviewImportReaders = {
        readMeta: async (name) => (name in messages ? importedMeta(name) : null),
        costRows: (meta) =>
            meta.name === "rv-part" ? [costRow(meta.name, 1), costRow(meta.name, 2)] : [costRow(meta.name, 1)],
        lastAgentMessage: async (meta) => messages[meta.name] ?? "",
        cwdExists: (path) => !(options.gone ?? []).some((name) => path.endsWith(name)),
        git,
        ledgerRecords: () => readReviewRecords(ledgerPath).records,
    };
    return { fake, git };
}

describe("reviews import", () => {
    test("backfills start, turns and a gate whose verdict the coverage line implies, diffing up to the commit the review saw", async () => {
        const ledgerPath = join(mkdtempSync(join(tmpdir(), "gt-review-import-")), "reviews.jsonl");
        const { fake, git } = importReaders(ledgerPath, { gone: ["rv-gone"] });
        const results = await importReviewSessions({
            names: ["rv-full", "rv-part", "rv-gone", "rv-none", "rv-full"],
            base: "origin/master",
            readers: fake,
            ledgerPath,
        });

        expect(results.map((result) => [result.name, result.status, result.verdict ?? null])).toEqual([
            ["rv-full", "imported", "pass"],
            ["rv-part", "imported", "shallow"],
            ["rv-gone", "imported", "imported"],
            ["rv-none", "missing", null],
        ]);
        expect(results[0].manifest).toEqual({ base: "origin/master", head: "abc1234567890", files: 2, lines: 45 });
        expect(results[2].manifest).toBeNull();
        expect(results[2].notes[0]).toContain("/wt/rv-gone is gone");
        expect(git.calls).toEqual(["numstat origin/master...abc1234567890", "numstat origin/master...abc1234567890"]);

        const records = readReviewRecords(ledgerPath).records;
        expect(records.map((record) => `${record.name}:${record.kind}`)).toEqual([
            "rv-full:start",
            "rv-full:turn",
            "rv-full:gate",
            "rv-part:start",
            "rv-part:turn",
            "rv-part:turn",
            "rv-part:gate",
            "rv-gone:start",
            "rv-gone:turn",
            "rv-gone:gate",
        ]);
        expect(records.every((record) => record.imported === true)).toBe(true);
        expect(records[2]).toMatchObject({
            kind: "gate",
            pr: 12,
            files: 2,
            lines: 45,
            effort: "medium",
            head: "abc1234567890",
        });
        expect(records[6]).toMatchObject({
            kind: "gate",
            reason: "imported: Files reviewed 1 of 2, 1 unread",
            unread: ["src/b.ts"],
        });
        expect(records[9]).toMatchObject({
            base: "origin/master",
            files: null,
            lines: null,
            reasoningPer100Lines: null,
        });

        const summaries = summarizeReviews(records);
        expect(summaries.find((review) => review.name === "rv-part")).toMatchObject({
            turns: 2,
            toolCalls: 20,
            costUsd: 1,
            coverage: "1/2",
            reasoningPer100Lines: 1333,
            verdict: "shallow",
        });
        expect(summaries.find((review) => review.name === "rv-gone")?.reasoningPer100Lines).toBeNull();

        // A second import of the same names adds nothing.
        const again = await importReviewSessions({ names: ["rv-full", "rv-part"], readers: fake, ledgerPath });
        expect(again.map((result) => result.status)).toEqual(["skipped", "skipped"]);
        expect(readReviewRecords(ledgerPath).records).toHaveLength(10);
    });

    test("without a base or with --no-cwd-from-session the manifest is null and the note says why", async () => {
        const ledgerPath = join(mkdtempSync(join(tmpdir(), "gt-review-import-")), "reviews.jsonl");
        const { fake } = importReaders(ledgerPath, { noBase: true });
        const [derived] = await importReviewSessions({ names: ["rv-full"], readers: fake, ledgerPath });
        expect(derived.manifest).toBeNull();
        expect(derived.notes[0]).toContain("no base: --mode review needs --base <ref>");

        const [skipped] = await importReviewSessions({
            names: ["rv-part"],
            cwdFromSession: false,
            readers: fake,
            ledgerPath,
        });
        expect(skipped.notes[0]).toContain("manifest skipped");
        expect(readReviewRecords(ledgerPath).records.filter((record) => record.kind === "gate")).toHaveLength(2);
    });
});

describe("reviews import: verdicts and failed writes", () => {
    test("a full count whose total differs from the rebuilt manifest stays imported, never pass", async () => {
        const ledgerPath = join(mkdtempSync(join(tmpdir(), "gt-review-import-")), "reviews.jsonl");
        const { fake } = importReaders(ledgerPath);
        const mismatched: ReviewImportReaders = {
            ...fake,
            lastAgentMessage: async () =>
                "1. [High] src/a.ts:3 - bug. Scenario: x. Fix: y.\nRan: bun test\nFiles reviewed: 1 of 1\nNot reviewed: none",
        };
        const [result] = await importReviewSessions({
            names: ["rv-full"],
            base: "origin/master",
            readers: mismatched,
            ledgerPath,
        });

        expect(result.verdict).toBe("imported");
        expect(summarizeReviews(readReviewRecords(ledgerPath).records)[0].verdict).toBe("imported");
        expect(readReviewRecords(ledgerPath).records.at(-1)).toMatchObject({
            kind: "gate",
            reason: "imported: reported 1 of 1, but the manifest has 2 files; the scope is not confirmed",
        });
    });

    test("a failed ledger write is reported, and a partial earlier import is redone instead of skipped", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-review-import-"));
        const blocker = join(dir, "not-a-folder");
        writeFileSync(blocker, "");
        const unwritable = join(blocker, "reviews.jsonl");
        const { fake: failing } = importReaders(unwritable);
        const [failed] = await importReviewSessions({
            names: ["rv-full"],
            base: "origin/master",
            readers: { ...failing, ledgerRecords: () => [] },
            ledgerPath: unwritable,
        });
        expect(failed.status).toBe("failed");
        expect(failed.notes.at(-1)).toContain("the review ledger write failed");

        // An older import wrote its start line and then failed: the rerun completes it and its row replaces the stub.
        const ledgerPath = join(dir, "reviews.jsonl");
        const { fake } = importReaders(ledgerPath);
        const stub = {
            v: 1,
            ts: "2026-10-22T19:00:00.000Z",
            name: "rv-full",
            chain: "rv-full",
            base: "origin/master",
            files: 2,
            lines: 45,
            effort: "medium",
            imported: true,
            kind: "start",
            cwd: "/wt/rv-full",
            effortSource: "imported",
            allowShallow: false,
        };
        appendFileSync(ledgerPath, `${SafeJSON.stringify(stub)}\n`);
        const [redone] = await importReviewSessions({
            names: ["rv-full"],
            base: "origin/master",
            readers: fake,
            ledgerPath,
        });
        expect(redone).toMatchObject({ status: "imported", verdict: "pass" });
        expect(redone.notes).toContain("an earlier import of this name has no gate line; this import replaces it");
        expect(
            summarizeReviews(readReviewRecords(ledgerPath).records).map((review) => [review.name, review.verdict])
        ).toEqual([["rv-full", "pass"]]);

        const [again] = await importReviewSessions({ names: ["rv-full"], readers: fake, ledgerPath });
        expect(again.status).toBe("skipped");
    });

    test("a redo after a torn last line keeps the line boundary, so the old batch's turns never fold into the new row", async () => {
        const ledgerPath = join(mkdtempSync(join(tmpdir(), "gt-review-torn-")), "reviews.jsonl");
        const { fake } = importReaders(ledgerPath);
        const [first] = await importReviewSessions({
            names: ["rv-full"],
            base: "origin/master",
            readers: fake,
            ledgerPath,
        });
        expect(first.status).toBe("imported");
        const clean = summarizeReviews(readReviewRecords(ledgerPath).records);

        // The same batch again, torn inside its gate line: complete start and turn lines, then an unterminated fragment.
        const text = readFileSync(ledgerPath, "utf8");
        const gateAt = text.lastIndexOf('{"v":1');
        writeFileSync(ledgerPath, text.slice(0, gateAt + 20));
        const [redone] = await importReviewSessions({
            names: ["rv-full"],
            base: "origin/master",
            readers: fake,
            ledgerPath,
        });
        expect(redone.status).toBe("imported");

        const { records, skipped } = readReviewRecords(ledgerPath);
        expect(skipped).toBe(1);
        expect(summarizeReviews(records).map((row) => [row.name, row.verdict, row.turns, row.costUsd])).toEqual(
            clean.map((row) => [row.name, row.verdict, row.turns, row.costUsd])
        );
    });

    test("tools codex reviews import exits 1 for a missing session in table and --json output alike", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-review-import-cli-"));
        const previousExitCode = process.exitCode;
        const printed: unknown[] = [];
        const result = spyOn(out, "result").mockImplementation((value) => {
            printed.push(value);
        });
        const println = spyOn(out, "println").mockImplementation(() => {});
        // Read through a call: after the reset below, TypeScript would narrow a direct read to undefined.
        const exitCode = (): typeof process.exitCode => process.exitCode;

        try {
            await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
                for (const json of [true, false]) {
                    process.exitCode = undefined;
                    await runImport(["absent-review"], { cwdFromSession: true, json });
                    expect(exitCode()).toBe(1);
                }
            });
            expect(printed).toHaveLength(1);
            expect(printed[0]).toMatchObject({ results: [{ name: "absent-review", status: "missing" }] });
        } finally {
            result.mockRestore();
            println.mockRestore();
            process.exitCode = previousExitCode;
        }
    });
});
