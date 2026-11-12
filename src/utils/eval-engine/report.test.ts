// Copied from /Users/Martin/Tresors/Projects/Kalendora/src/eval-engine/report.test.ts at 2026-11-12T06:18:59+01:00 at commit hash 2b9937db296fcb22d402376689d926a71fe9f165
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConversationRecord } from "./conversation";
import { parseScenarios, type Scenario, toJson } from "./document";
import type { ExpectationVerdict, Outcome } from "./evaluate";
import { planRun } from "./plan";
import { cellStats, compareRuns, ExitCode, runVerdict, summarizeRun } from "./report";
import type { RunManifest, RunView } from "./store";

function scenarios(...inputs: unknown[]): Scenario[] {
    const parsed = parseScenarios(inputs, null, "stdin");
    if (!parsed.ok) {
        throw new Error(JSON.stringify(parsed.issues));
    }
    return parsed.scenarios;
}

const Toothache = {
    id: "tooth",
    steps: [
        {
            user: "x",
            expect: [
                { id: "safe", severity: "safety", check: { signal: "e", is: false } },
                { id: "kind", check: { judge: "Kind?" } },
            ],
        },
    ],
};
const Booking = { id: "book", steps: [{ user: "y", expect: [{ id: "books", check: { tool: "book" } }] }] };

function verdict(
    id: string,
    severity: ExpectationVerdict["severity"],
    result: ExpectationVerdict["result"],
    branch: string | null = null
): ExpectationVerdict {
    return {
        id,
        severity,
        place: "turn",
        turn: 1,
        result,
        reason: `${id} ${result}`,
        check: null,
        branch,
        tree: { label: id, result, reason: "" },
    };
}

interface Spec {
    key: string;
    outcome: Outcome;
    verdicts?: ExpectationVerdict[];
    safetyMiss?: boolean;
    promptHash?: string;
    cost?: number;
}

function view(
    list: Scenario[],
    specs: Spec[],
    options: {
        repeats?: number;
        judge?: string;
        signalsVersion?: number;
        maxErrorRate?: number;
        run?: string;
        models?: string[];
    } = {}
): RunView {
    const plan = planRun({
        scenarios: list,
        models: options.models ?? ["m"],
        variants: ["v"],
        repeats: options.repeats ?? 1,
        passRate: 1,
        maxErrorRate: options.maxErrorRate ?? 0.1,
    });
    const manifest: RunManifest = {
        schema: "eval-manifest/1",
        run: options.run ?? "a",
        label: "x",
        createdAt: "",
        plannedAt: "",
        project: "p",
        target: null,
        rubricVersion: 1,
        signalsVersion: options.signalsVersion ?? 1,
        plan,
        scenarios: Object.fromEntries(
            list.map((s) => [s.doc.id, { hash: s.hash, origin: s.origin, doc: toJson(s.doc) }])
        ),
        setups: {},
        system: { models: [], variants: ["v"], fingerprint: null },
        harness: { judge: options.judge ?? "j1", judgePromptVersion: 1, simulator: null, simulatorPromptVersion: 1 },
        maxCostUsd: null,
        argv: [],
    };
    const records: ConversationRecord[] = specs.map((spec) => {
        const conversation = plan.conversations.find((c) => c.key === spec.key);
        if (!conversation) {
            throw new Error(`no key ${spec.key}; keys: ${plan.conversations.map((c) => c.key).join(", ")}`);
        }
        return {
            schema: "eval-conversation/1",
            run: manifest.run,
            key: spec.key,
            cell: conversation.cell,
            repeat: conversation.repeat,
            outcome: spec.outcome,
            safetyMiss: spec.safetyMiss ?? false,
            safetyUnverified: false,
            completed: true,
            brokenBy: null,
            closeError: null,
            attempt: 1,
            startedAt: "",
            finishedAt: "",
            setup: {},
            bindings: {},
            turns: [
                {
                    turn: 1,
                    step: 0,
                    choice: null,
                    user: { text: "x", source: "script" },
                    reply: "",
                    toolCalls: [],
                    toolEvidence: "observed",
                    signals: {},
                    promptHash: spec.promptHash ?? "p1",
                    context: null,
                    observedModel: null,
                    steps: [],
                    usage: { inputTokens: 0, outputTokens: 0 },
                    latencyMs: 1,
                    firstTokenMs: null,
                    verdicts: spec.verdicts ?? [],
                },
            ],
            final: [],
            simulator: [],
            systemUsage: { inputTokens: 0, outputTokens: 0, costUsd: spec.cost ?? 0 },
            harnessUsage: { inputTokens: 0, outputTokens: 0 },
        };
    });
    const done = new Set(records.map((r) => r.key));
    return {
        dir: `/runs/${manifest.run}`,
        manifest,
        records,
        missing: plan.conversations
            .filter((c) => !done.has(c.key))
            .map((c) => ({ key: c.key, cell: c.cell, kind: "rate-limit" as const, message: "429" })),
        recordFiles: Object.fromEntries(
            records.map((r) => [r.key, `/runs/${manifest.run}/conversations/${r.key}.json`])
        ),
        promptFiles: { p1: `/runs/${manifest.run}/prompts/p1.txt`, p2: `/runs/${manifest.run}/prompts/p2.txt` },
    };
}

const [tooth, book] = scenarios(Toothache, Booking);
const key = (scenario: string, repeat = 1, model = "m") => `${scenario}~${model}~v~r${repeat}`;
const pass = (id: string, branch: string | null = null) => verdict(id, "gate", "pass", branch);

describe("cellStats", () => {
    it("one safety miss fails the cell whatever the pass rate", () => {
        const v = view(
            [tooth],
            [
                { key: key("tooth", 1), outcome: "passed" },
                { key: key("tooth", 2), outcome: "failed", safetyMiss: true },
                { key: key("tooth", 3), outcome: "passed" },
            ],
            { repeats: 3 }
        );
        const stats = cellStats(v.manifest.plan.cells[0], v);
        assert.equal(stats.verdict, "safety-failed");
        assert.equal(stats.passRate, 2 / 3);
    });

    it("a proven failure outranks missing results; an unproven shortfall is errored", () => {
        const proven = view([book], [{ key: key("book", 1), outcome: "failed" }], { repeats: 2 });
        assert.equal(cellStats(proven.manifest.plan.cells[0], proven).verdict, "failed");
        const unproven = view([book], [{ key: key("book", 1), outcome: "passed" }], { repeats: 2 });
        assert.equal(cellStats(unproven.manifest.plan.cells[0], unproven).verdict, "errored");
        const allowed = view([book], [{ key: key("book", 1), outcome: "passed" }], { repeats: 2, maxErrorRate: 0.5 });
        assert.equal(cellStats(allowed.manifest.plan.cells[0], allowed).verdict, "passed");
        const unsure = view([book], [{ key: key("book", 1), outcome: "inconclusive" }]);
        assert.equal(cellStats(unsure.manifest.plan.cells[0], unsure).verdict, "inconclusive");
    });

    it("counts expectations and any-of branches", () => {
        const v = view(
            [book],
            [
                { key: key("book", 1), outcome: "passed", verdicts: [pass("books", "offers")] },
                { key: key("book", 2), outcome: "passed", verdicts: [pass("books", "asks")] },
                { key: key("book", 3), outcome: "failed", verdicts: [verdict("books", "gate", "fail")] },
            ],
            { repeats: 3 }
        );
        const stats = cellStats(v.manifest.plan.cells[0], v);
        assert.deepEqual(stats.expectations.books, {
            severity: "gate",
            passed: 2,
            of: 3,
            branches: { offers: 1, asks: 1 },
        });
        assert.deepEqual(summarizeRun(v).cells[0].branches, { books: { offers: 1, asks: 1 } });
    });
});

describe("summarizeRun and exit codes", () => {
    it("orders exit codes: safety 3, then failed 1, then no verdict 4, then 0", () => {
        assert.equal(
            runVerdict([{ verdict: "errored" }, { verdict: "failed" }, { verdict: "safety-failed" }]).exitCode,
            ExitCode.SafetyFailed
        );
        assert.equal(runVerdict([{ verdict: "errored" }, { verdict: "failed" }]).exitCode, ExitCode.Failed);
        assert.equal(runVerdict([{ verdict: "errored" }, { verdict: "inconclusive" }]).exitCode, ExitCode.Failed);
        assert.equal(runVerdict([{ verdict: "errored" }, { verdict: "passed" }]).exitCode, ExitCode.NoVerdict);
        assert.equal(runVerdict([{ verdict: "passed" }]).exitCode, ExitCode.Passed);
    });

    it("lists failures worst first with their transcript, and warns about keys without a result", () => {
        const v = view(
            [tooth, book],
            [
                { key: key("book"), outcome: "failed", verdicts: [verdict("books", "gate", "fail")] },
                {
                    key: key("tooth"),
                    outcome: "failed",
                    safetyMiss: true,
                    verdicts: [
                        verdict("safe", "safety", "fail"),
                        verdict("engine", "gate", "fail"),
                        verdict("tone", "advisory", "fail"),
                    ],
                },
            ],
            { repeats: 2 }
        );
        const summary = summarizeRun(v, { maxFailures: 1 });
        assert.equal(summary.exitCode, 3);
        assert.deepEqual(summary.failures, [
            {
                conversation: key("tooth"),
                severity: "safety",
                expectation: "safe",
                turn: 1,
                reason: "safe fail",
                also: ["engine"],
                transcript: `/runs/a/conversations/${key("tooth")}.json`,
            },
        ]);
        assert.equal(summary.failuresOmitted, 1);
        assert.match(summary.warnings[0], /2 conversations had no result \(rate-limit\)\. Run again with --resume a/);
    });
});

describe("compareRuns", () => {
    it("calls a cell fixed or regressed only when its verdict flips", () => {
        const a = view(
            [tooth, book],
            [
                { key: key("tooth"), outcome: "failed", verdicts: [verdict("kind", "gate", "fail")] },
                { key: key("book"), outcome: "passed" },
            ]
        );
        const b = view(
            [tooth, book],
            [
                { key: key("tooth"), outcome: "passed" },
                { key: key("book"), outcome: "failed" },
            ],
            { run: "b" }
        );
        const comparison = compareRuns(a, b);
        assert.deepEqual(
            comparison.cells.map((c) => [c.scenario, c.change]),
            [
                ["book", "regressed"],
                ["tooth", "fixed"],
            ]
        );
        assert.equal(comparison.verdict, "regressed");
        assert.equal(comparison.exitCode, ExitCode.Failed);
    });

    it("a moved rate without a flip is rate-changed, never improved", () => {
        const a = view(
            [book],
            [
                { key: key("book", 1), outcome: "passed" },
                { key: key("book", 2), outcome: "failed" },
                { key: key("book", 3), outcome: "failed" },
            ],
            { repeats: 3 }
        );
        const b = view(
            [book],
            [
                { key: key("book", 1), outcome: "passed" },
                { key: key("book", 2), outcome: "passed" },
                { key: key("book", 3), outcome: "failed" },
            ],
            { repeats: 3, run: "b" }
        );
        const comparison = compareRuns(a, b);
        assert.equal(comparison.cells[0].change, "rate-changed");
        assert.equal(comparison.verdict, "same");
    });

    it("a new safety miss exits with 3", () => {
        const a = view([tooth], [{ key: key("tooth"), outcome: "passed" }]);
        const b = view([tooth], [{ key: key("tooth"), outcome: "failed", safetyMiss: true }], { run: "b" });
        assert.equal(compareRuns(a, b).exitCode, ExitCode.SafetyFailed);
    });

    it("excludes a changed scenario per scenario and compares the rest", () => {
        const [changed] = scenarios({ ...Booking, steps: [{ user: "z" }] });
        const a = view(
            [tooth, book],
            [
                { key: key("tooth"), outcome: "passed" },
                { key: key("book"), outcome: "passed" },
            ]
        );
        const b = view(
            [tooth, changed],
            [
                { key: key("tooth"), outcome: "passed" },
                { key: key("book"), outcome: "failed" },
            ],
            { run: "b" }
        );
        const comparison = compareRuns(a, b);
        assert.deepEqual(
            comparison.excluded.map((e) => [e.scenario, e.reason]),
            [["book", "scenario-changed"]]
        );
        assert.equal(comparison.comparable, true);
        assert.equal(comparison.unchanged, 1);
        assert.equal(comparison.verdict, "same");
    });

    it("a changed signals version excludes every scenario: nothing comparable is exit 2", () => {
        const a = view([book], [{ key: key("book"), outcome: "passed" }]);
        const b = view([book], [{ key: key("book"), outcome: "passed" }], { run: "b", signalsVersion: 2 });
        const comparison = compareRuns(a, b);
        assert.deepEqual(
            comparison.excluded.map((e) => e.reason),
            ["signals-changed"]
        );
        assert.equal(comparison.comparable, false);
        assert.equal(comparison.exitCode, ExitCode.Usage);
    });

    it("a changed judge leaves out only the expectations that use the judge", () => {
        const a = view(
            [tooth],
            [
                {
                    key: key("tooth"),
                    outcome: "failed",
                    verdicts: [verdict("safe", "safety", "pass"), verdict("kind", "gate", "fail")],
                },
            ]
        );
        const b = view(
            [tooth],
            [
                {
                    key: key("tooth"),
                    outcome: "passed",
                    verdicts: [verdict("safe", "safety", "pass"), verdict("kind", "gate", "pass")],
                },
            ],
            { run: "b", judge: "j2" }
        );
        const comparison = compareRuns(a, b);
        assert.deepEqual(comparison.excludedExpectations, [
            {
                scenario: "tooth",
                ids: ["kind"],
                reason: "judge-changed",
                detail: "judge j1 (prompt v1) → j2 (prompt v1)",
            },
        ]);
        assert.equal(comparison.comparable, true);
        assert.equal(comparison.unchanged, 1, "without the judge expectation the cell passed in both runs");
    });

    it("lists cells whose system prompt changed with both prompt files", () => {
        const a = view([book], [{ key: key("book"), outcome: "passed", promptHash: "p1" }]);
        const b = view([book], [{ key: key("book"), outcome: "passed", promptHash: "p2" }], { run: "b" });
        assert.deepEqual(compareRuns(a, b).prompt[0].files, ["/runs/a/prompts/p1.txt", "/runs/b/prompts/p2.txt"]);
    });
});

it("does not pass comparison when a previously passed cell loses its verdict", () => {
    const a = view([book], [{ key: key("book"), outcome: "passed" }]);
    const b = view([book], [], { run: "b" });
    assert.equal(compareRuns(a, b).exitCode, ExitCode.NoVerdict);
});
