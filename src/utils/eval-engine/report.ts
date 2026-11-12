// Copied from /Users/Martin/Tresors/Projects/Kalendora/src/eval-engine/report.ts at 2026-11-12T06:18:59+01:00 at commit hash 2b9937db296fcb22d402376689d926a71fe9f165
/**
 * What counts as passing: cell statistics and verdicts, the run summary and its exit code, `compare` and what it
 * leaves out, and the transcript as text. Pure functions over a `RunView`.
 */
import type { CellRef, ConversationRecord } from "./conversation";
import { allExpectations, containsJudge, parseScenarios, type Severity } from "./document";
import { conversationOutcome, type ExpectationVerdict, type Outcome, type Result } from "./evaluate";
import { cellKey, type PlannedCell } from "./plan";
import type { RunView } from "./store";

/** The process exit codes. The same numbers in every project. */
export const ExitCode = { Passed: 0, Failed: 1, Usage: 2, SafetyFailed: 3, NoVerdict: 4 } as const;
export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export type CellVerdict = "passed" | "failed" | "inconclusive" | "safety-failed" | "errored";

export interface ExpectationStats {
    severity: Severity;
    /** Conversations in which every verdict of this expectation passed. */
    passed: number;
    /** Conversations that evaluated it at least once. */
    of: number;
    /** Passing `anyOf` branch → how many verdicts passed through it. */
    branches: Record<string, number>;
}

export interface CellStats extends CellRef {
    /** Planned repeats. */
    n: number;
    passed: number;
    failed: number;
    inconclusive: number;
    /** Planned repeats with no record. */
    errored: number;
    /** passed / (passed + failed + inconclusive); null when nothing finished. */
    passRate: number | null;
    threshold: number;
    safetyMisses: number;
    verdict: CellVerdict;
    /** The system prompt hash of turn 1 when every record agrees, else null. */
    promptHash: string | null;
    /** The records disagree about the system prompt of turn 1. */
    promptChanged: boolean;
    expectations: Record<string, ExpectationStats>;
}

interface Folded {
    outcome: Outcome;
    safetyMiss: boolean;
    safetyUnverified: boolean;
}

function recordVerdicts(record: ConversationRecord): ExpectationVerdict[] {
    return [...record.turns.flatMap((turn) => turn.verdicts), ...record.final];
}

/** A record's outcome, or its outcome without the ignored expectations (a stop at an ignored one: inconclusive). */
function fold(record: ConversationRecord, ignore: ReadonlySet<string>): Folded {
    if (!ignore.size) {
        return record;
    }
    const kept = recordVerdicts(record).filter((v) => !ignore.has(v.id));
    return (
        conversationOutcome(kept, record.completed) ?? {
            outcome: "inconclusive",
            safetyMiss: false,
            safetyUnverified: false,
        }
    );
}

const ResultRank: Record<Result, number> = { fail: 0, inconclusive: 1, pass: 2 };

/** The fold from records to one cell's numbers and verdict. `ignore`: expectation ids left out (for `compare`). */
export function cellStats(cell: PlannedCell, view: RunView, ignore: ReadonlySet<string> = new Set()): CellStats {
    const key = cellKey(cell);
    const records = view.records.filter((r) => cellKey(r.cell) === key && r.cell.scenarioHash === cell.scenarioHash);
    const n = view.manifest.plan.repeats;
    const folded = records.map((record) => fold(record, ignore));
    const passed = folded.filter((f) => f.outcome === "passed").length;
    const failed = folded.filter((f) => f.outcome === "failed").length;
    const inconclusive = folded.filter((f) => f.outcome === "inconclusive").length;
    const errored = Math.max(0, n - records.length);
    const finished = passed + failed + inconclusive;
    const passRate = finished ? passed / finished : null;
    const safetyMisses = folded.filter((f) => f.safetyMiss).length;

    let verdict: CellVerdict;
    if (safetyMisses > 0) {
        verdict = "safety-failed";
    }
    // Proven: even if every conversation without a result had passed, the cell stays below its threshold.
    else if (failed > 0 && (passed + errored) / n < cell.threshold) {
        verdict = "failed";
    } else if (passRate === null || errored / n > view.manifest.plan.maxErrorRate) {
        verdict = "errored";
    } else if (passRate < cell.threshold) {
        verdict = failed > 0 ? "failed" : "inconclusive";
    } else if (folded.some((f) => f.safetyUnverified)) {
        verdict = "inconclusive";
    } else {
        verdict = "passed";
    }

    const hashes = new Set(records.map((r) => r.turns[0]?.promptHash ?? null));
    const expectations: Record<string, ExpectationStats> = {};
    for (const record of records) {
        const worst = new Map<string, Result>();
        for (const v of recordVerdicts(record)) {
            if (ignore.has(v.id)) {
                continue;
            }
            expectations[v.id] ??= { severity: v.severity, passed: 0, of: 0, branches: {} };
            const stats = expectations[v.id];
            if (v.branch) {
                stats.branches[v.branch] = (stats.branches[v.branch] ?? 0) + 1;
            }
            const before = worst.get(v.id);
            if (before === undefined || ResultRank[v.result] < ResultRank[before]) {
                worst.set(v.id, v.result);
            }
        }
        for (const [id, result] of worst) {
            expectations[id].of++;
            if (result === "pass") {
                expectations[id].passed++;
            }
        }
    }
    return {
        scenario: cell.scenario,
        scenarioHash: cell.scenarioHash,
        model: cell.model,
        variant: cell.variant,
        n,
        passed,
        failed,
        inconclusive,
        errored,
        passRate,
        threshold: cell.threshold,
        safetyMisses,
        verdict,
        promptHash: hashes.size === 1 ? [...hashes][0] : null,
        promptChanged: hashes.size > 1,
        expectations,
    };
}

export type RunVerdict = "passed" | "failed" | "safety-failed" | "errored";

export interface FailureLine {
    conversation: string;
    severity: Severity;
    expectation: string;
    turn: number;
    reason: string;
    /** The other gate and safety expectations that failed in the same conversation (the line shows only the worst). */
    also: string[];
    transcript: string;
}

/** A cell as `run` prints it. `branches`: expectation id → passing branch → count, when an any-of passed. */
export type CellLine = Omit<CellStats, "expectations" | "scenarioHash" | "promptChanged"> & {
    branches?: Record<string, Record<string, number>>;
};

export interface RunStopped {
    reason: "cost-limit" | "aborted";
    detail: string;
}

/** What `run` and `show <run>` print (schema "eval-run/1"). Also written to `summary.json` as an export. */
export interface RunSummary {
    schema: "eval-run/1";
    run: string;
    dir: string;
    target: string | null;
    verdict: RunVerdict;
    exitCode: ExitCodeValue;
    totals: {
        planned: number;
        passed: number;
        failed: number;
        inconclusive: number;
        errored: number;
        systemCostUsd: number;
        harnessCostUsd: number;
        durationMs: number | null;
    };
    /** Cells that did not pass (every cell with `allCells`, or when the run has one cell). */
    cells: CellLine[];
    cellsPassed: number;
    /** Worst severity first; at most `maxFailures`. */
    failures: FailureLine[];
    failuresOmitted: number;
    /** Why some conversations were never started. */
    stopped: RunStopped | null;
    warnings: string[];
}

/** The run verdict and its exit code: safety, then failed or inconclusive, then no verdict. (2 is the CLI's.) */
export function runVerdict(cells: readonly Pick<CellStats, "verdict">[]): {
    verdict: RunVerdict;
    exitCode: ExitCodeValue;
} {
    if (cells.some((c) => c.verdict === "safety-failed")) {
        return { verdict: "safety-failed", exitCode: ExitCode.SafetyFailed };
    }
    if (cells.some((c) => c.verdict === "failed" || c.verdict === "inconclusive")) {
        return { verdict: "failed", exitCode: ExitCode.Failed };
    }
    if (cells.some((c) => c.verdict === "errored")) {
        return { verdict: "errored", exitCode: ExitCode.NoVerdict };
    }
    return { verdict: "passed", exitCode: ExitCode.Passed };
}

const SeverityRank: Record<Severity, number> = { safety: 0, gate: 1, advisory: 2 };

function cellLine(stats: CellStats): CellLine {
    const { expectations } = stats;
    const line: CellLine = {
        scenario: stats.scenario,
        model: stats.model,
        variant: stats.variant,
        n: stats.n,
        passed: stats.passed,
        failed: stats.failed,
        inconclusive: stats.inconclusive,
        errored: stats.errored,
        passRate: stats.passRate,
        threshold: stats.threshold,
        safetyMisses: stats.safetyMisses,
        verdict: stats.verdict,
        promptHash: stats.promptHash,
    };
    const branches: Record<string, Record<string, number>> = {};
    for (const [id, e] of Object.entries(expectations)) {
        if (Object.keys(e.branches).length) {
            branches[id] = e.branches;
        }
    }
    return Object.keys(branches).length ? { ...line, branches } : line;
}

export function summarizeRun(
    view: RunView,
    options: { allCells?: boolean; maxFailures?: number; durationMs?: number | null; stopped?: RunStopped | null } = {}
): RunSummary {
    const stats = view.manifest.plan.cells.map((cell) => cellStats(cell, view));
    const { verdict, exitCode } = runVerdict(stats);
    const showAll = options.allCells || stats.length === 1;
    const shown = stats.filter((s) => showAll || s.verdict !== "passed");

    const failures: FailureLine[] = [];
    for (const record of view.records) {
        if (record.outcome !== "failed") {
            continue;
        }
        const [failing, ...others] = recordVerdicts(record)
            .filter((v) => v.severity !== "advisory" && v.result === "fail")
            .sort((x, y) => SeverityRank[x.severity] - SeverityRank[y.severity] || x.turn - y.turn);
        if (!failing) {
            continue;
        }
        failures.push({
            conversation: record.key,
            severity: failing.severity,
            expectation: failing.id,
            turn: failing.turn,
            reason: failing.reason,
            also: [...new Set(others.map((v) => v.id))].filter((id) => id !== failing.id),
            transcript: view.recordFiles[record.key] ?? "",
        });
    }
    failures.sort(
        (x, y) => SeverityRank[x.severity] - SeverityRank[y.severity] || x.conversation.localeCompare(y.conversation)
    );
    const maxFailures = options.maxFailures ?? 5;

    const warnings: string[] = [];
    const byKind = new Map<string, number>();
    for (const m of view.missing) {
        byKind.set(m.kind, (byKind.get(m.kind) ?? 0) + 1);
    }
    for (const [kind, count] of byKind) {
        const advice = kind === "blocked" ? "The system refused the cell; fix it, then" : "";
        warnings.push(
            `${count} conversation${count === 1 ? "" : "s"} had no result (${kind}). ${advice ? `${advice} run` : "Run"} again with --resume ${view.manifest.run}`
        );
    }
    for (const s of stats) {
        if (s.promptChanged) {
            warnings.push(`the system prompt changed during the run (${s.scenario} on ${s.model}, ${s.variant})`);
        }
    }
    const closeErrors = view.records.filter((r) => r.closeError).length;
    if (closeErrors) {
        warnings.push(
            `${closeErrors} conversation${closeErrors === 1 ? "" : "s"} could not be closed; run the cleanup command`
        );
    }

    const sum = (pick: (r: ConversationRecord) => number) => view.records.reduce((total, r) => total + pick(r), 0);
    return {
        schema: "eval-run/1",
        run: view.manifest.run,
        dir: view.dir,
        target: view.manifest.target,
        verdict,
        exitCode,
        totals: {
            planned: view.manifest.plan.conversations.length,
            passed: view.records.filter((r) => r.outcome === "passed").length,
            failed: view.records.filter((r) => r.outcome === "failed").length,
            inconclusive: view.records.filter((r) => r.outcome === "inconclusive").length,
            errored: view.missing.length,
            systemCostUsd: round(sum((r) => r.systemUsage.costUsd ?? 0)),
            harnessCostUsd: round(sum((r) => r.harnessUsage.costUsd ?? 0)),
            durationMs: options.durationMs ?? null,
        },
        cells: shown.map(cellLine),
        cellsPassed: stats.filter((s) => s.verdict === "passed").length,
        failures: failures.slice(0, maxFailures),
        failuresOmitted: Math.max(0, failures.length - maxFailures),
        stopped: options.stopped ?? null,
        warnings,
    };
}

function round(n: number): number {
    return Math.round(n * 1e6) / 1e6;
}

// ── compare ──────────────────────────────────────────────────────────────────

export type CellChange = "fixed" | "regressed" | "rate-changed" | "no-verdict";
export type ExclusionReason = "rubric-changed" | "signals-changed" | "scenario-changed" | "only-in-a" | "only-in-b";

/** What `compare` prints (schema "eval-compare/1"). */
export interface Comparison {
    schema: "eval-compare/1";
    a: string;
    b: string;
    /** false: no cell could be compared (exit code 2). */
    comparable: boolean;
    verdict: "same" | "improved" | "regressed" | "new-safety-miss" | "not-comparable";
    exitCode: ExitCodeValue;
    /** Compared cells whose turn-1 system prompt differs, with both prompt files. */
    prompt: {
        scenario: string;
        model: string;
        variant: string;
        a: string | null;
        b: string | null;
        files: [string | null, string | null];
    }[];
    /** Compared cells whose verdict or counts changed. */
    cells: {
        scenario: string;
        model: string;
        variant: string;
        a: { passed: number; n: number; verdict: CellVerdict };
        b: { passed: number; n: number; verdict: CellVerdict };
        change: CellChange;
        expectations: { id: string; a: string; b: string }[];
    }[];
    unchanged: number;
    /** Scenarios or cells left out, with the reason. */
    excluded: { scenario: string; model?: string; variant?: string; reason: ExclusionReason; detail: string }[];
    /** Expectations left out of compared cells because the judge changed. Their cells are still compared. */
    excludedExpectations: { scenario: string; ids: string[]; reason: "judge-changed"; detail: string }[];
    /** For a person; never changes the verdict. */
    notes: string[];
}

function judgeExpectationIds(view: RunView, scenario: string): string[] {
    const stored = view.manifest.scenarios[scenario];
    if (!stored) {
        return [];
    }
    const parsed = parseScenarios(stored.doc, null, "manifest");
    if (!parsed.ok) {
        return [];
    }
    return allExpectations(parsed.scenarios[0].doc)
        .filter((e) => containsJudge(e.check))
        .map((e) => e.id);
}

function changeOf(a: CellStats, b: CellStats): CellChange | null {
    if (b.verdict === "safety-failed" && a.verdict !== "safety-failed") {
        return "regressed";
    }
    if (a.verdict === "errored" || b.verdict === "errored") {
        return a.verdict === b.verdict ? null : "no-verdict";
    }
    if (a.verdict !== "passed" && b.verdict === "passed") {
        return "fixed";
    }
    if (a.verdict === "passed" && b.verdict !== "passed") {
        return "regressed";
    }
    return null;
}

/**
 * Per scenario. A scenario whose document hash differs, or both runs whose rubric or signals version differs, is left
 * out with its reason. A changed judge model or judge prompt version leaves out only the expectations that contain a
 * judge. A cell is "fixed" or "regressed" only when its verdict flips; a moved rate is "rate-changed", never better.
 */
export function compareRuns(a: RunView, b: RunView): Comparison {
    const excluded: Comparison["excluded"] = [];
    const excludedExpectations: Comparison["excludedExpectations"] = [];
    const notes: string[] = [];
    const ma = a.manifest;
    const mb = b.manifest;
    const runWide: { reason: ExclusionReason; detail: string } | null =
        ma.rubricVersion !== mb.rubricVersion
            ? { reason: "rubric-changed", detail: `rubric version ${ma.rubricVersion} → ${mb.rubricVersion}` }
            : ma.signalsVersion !== mb.signalsVersion
              ? { reason: "signals-changed", detail: `signals version ${ma.signalsVersion} → ${mb.signalsVersion}` }
              : null;
    const judgeChanged =
        ma.harness.judge !== mb.harness.judge || ma.harness.judgePromptVersion !== mb.harness.judgePromptVersion
            ? `judge ${ma.harness.judge ?? "none"} (prompt v${ma.harness.judgePromptVersion}) → ${mb.harness.judge ?? "none"} (prompt v${mb.harness.judgePromptVersion})`
            : null;
    if (ma.system.fingerprint !== mb.system.fingerprint) {
        notes.push(
            `the system fingerprint differs: ${ma.system.fingerprint ?? "none"} → ${mb.system.fingerprint ?? "none"}`
        );
    }
    if (ma.target !== mb.target) {
        notes.push(`the target differs: ${ma.target ?? "default"} → ${mb.target ?? "default"}`);
    }

    const cellsA = new Map(ma.plan.cells.map((c) => [cellKey(c), c]));
    const cellsB = new Map(mb.plan.cells.map((c) => [cellKey(c), c]));
    const scenarioIds = [...new Set([...ma.plan.cells, ...mb.plan.cells].map((c) => c.scenario))].sort();
    const result: Comparison = {
        schema: "eval-compare/1",
        a: ma.run,
        b: mb.run,
        comparable: false,
        verdict: "not-comparable",
        exitCode: ExitCode.Usage,
        prompt: [],
        cells: [],
        unchanged: 0,
        excluded,
        excludedExpectations,
        notes,
    };
    let compared = 0;
    let newSafetyMiss = false;
    for (const scenario of scenarioIds) {
        const hashA = ma.scenarios[scenario]?.hash;
        const hashB = mb.scenarios[scenario]?.hash;
        if (hashA !== undefined && hashB !== undefined) {
            if (runWide) {
                excluded.push({ scenario, ...runWide });
                continue;
            }
            if (hashA !== hashB) {
                excluded.push({ scenario, reason: "scenario-changed", detail: `document ${hashA} → ${hashB}` });
                continue;
            }
        }
        const ignore = new Set(judgeChanged ? judgeExpectationIds(a, scenario) : []);
        if (ignore.size && judgeChanged) {
            excludedExpectations.push({
                scenario,
                ids: [...ignore].sort(),
                reason: "judge-changed",
                detail: judgeChanged,
            });
        }
        const keys = [...new Set([...cellsA.keys(), ...cellsB.keys()])]
            .filter((k) => (cellsA.get(k) ?? cellsB.get(k))?.scenario === scenario)
            .sort();
        for (const key of keys) {
            const cellA = cellsA.get(key);
            const cellB = cellsB.get(key);
            if (!cellA || !cellB) {
                const cell = cellA ?? cellB;
                if (cell) {
                    excluded.push({
                        scenario,
                        model: cell.model,
                        variant: cell.variant,
                        reason: cellA ? "only-in-a" : "only-in-b",
                        detail: `the cell is in run ${cellA ? ma.run : mb.run} only`,
                    });
                }
                continue;
            }
            compared++;
            const sa = cellStats(cellA, a, ignore);
            const sb = cellStats(cellB, b, ignore);
            if (sb.verdict === "safety-failed" && sa.verdict !== "safety-failed") {
                newSafetyMiss = true;
            }
            if (sa.promptHash !== sb.promptHash) {
                result.prompt.push({
                    scenario,
                    model: cellA.model,
                    variant: cellA.variant,
                    a: sa.promptHash,
                    b: sb.promptHash,
                    files: [
                        sa.promptHash ? (a.promptFiles[sa.promptHash] ?? null) : null,
                        sb.promptHash ? (b.promptFiles[sb.promptHash] ?? null) : null,
                    ],
                });
            }
            const expectationIds = [
                ...new Set([...Object.keys(sa.expectations), ...Object.keys(sb.expectations)]),
            ].sort();
            const expectations = expectationIds
                .map((id) => ({ id, a: countText(sa.expectations[id]), b: countText(sb.expectations[id]) }))
                .filter((e) => e.a !== e.b);
            const change =
                changeOf(sa, sb) ??
                (sa.passed !== sb.passed || sa.n !== sb.n || expectations.length ? "rate-changed" : null);
            if (!change) {
                result.unchanged++;
                continue;
            }
            result.cells.push({
                scenario,
                model: cellA.model,
                variant: cellA.variant,
                a: { passed: sa.passed, n: sa.n, verdict: sa.verdict },
                b: { passed: sb.passed, n: sb.n, verdict: sb.verdict },
                change,
                expectations,
            });
        }
    }
    if (!compared) {
        return result;
    }
    result.comparable = true;
    if (newSafetyMiss) {
        Object.assign(result, { verdict: "new-safety-miss", exitCode: ExitCode.SafetyFailed });
    } else if (result.cells.some((c) => c.change === "regressed")) {
        Object.assign(result, { verdict: "regressed", exitCode: ExitCode.Failed });
    } else if (result.cells.some((c) => c.change === "no-verdict")) {
        Object.assign(result, { verdict: "same", exitCode: ExitCode.NoVerdict });
    } else if (result.cells.some((c) => c.change === "fixed")) {
        Object.assign(result, { verdict: "improved", exitCode: ExitCode.Passed });
    } else {
        Object.assign(result, { verdict: "same", exitCode: ExitCode.Passed });
    }
    return result;
}

function countText(stats: ExpectationStats | undefined): string {
    return stats ? `${stats.passed}/${stats.of}` : "-";
}

// ── The transcript as text ───────────────────────────────────────────────────

const Marks: Record<Result, string> = { pass: "PASS", fail: "FAIL", inconclusive: "????" };

function verdictLines(verdicts: readonly ExpectationVerdict[], indent: string): string[] {
    return verdicts.map(
        (v) => `${indent}${Marks[v.result]} ${v.severity} ${v.id}${v.branch ? ` [${v.branch}]` : ""}: ${v.reason}`
    );
}

/** A transcript for a person (`show --text`): turns, tool calls with input and output, verdicts and reasons. */
export function renderTranscript(record: ConversationRecord): string {
    const lines = [
        `${record.key}: ${record.outcome.toUpperCase()}${record.safetyMiss ? " (safety miss)" : ""}${record.completed ? "" : " (stopped early)"}`,
        `scenario ${record.cell.scenario} (${record.cell.scenarioHash}) · model ${record.cell.model} · variant ${record.cell.variant} · repeat ${record.repeat}`,
        `setup ${JSON.stringify(record.setup)}`,
    ];
    if (record.brokenBy) {
        lines.push(`broken by ${record.brokenBy.kind}: ${record.brokenBy.message}`);
    }
    for (const turn of record.turns) {
        lines.push(
            "",
            `── turn ${turn.turn}${turn.choice ? ` (choose: ${turn.choice})` : ""}${turn.user.source === "simulator" ? " (simulated user)" : ""}`
        );
        lines.push(`USER: ${turn.user.text}`, `ASSISTANT: ${turn.reply || "(no answer)"}`);
        for (const call of turn.toolCalls) {
            lines.push(
                `  tool ${call.name} ${JSON.stringify(call.input)}${call.output !== undefined ? ` → ${JSON.stringify(call.output)}` : ""}${call.error ? ` (error: ${call.error})` : ""}`
            );
        }
        if (turn.toolEvidence === "unavailable") {
            lines.push("  (tool calls not observable)");
        }
        lines.push(`  signals ${JSON.stringify(turn.signals)}`);
        if (turn.promptHash) {
            lines.push(`  prompt ${turn.promptHash}`);
        }
        lines.push(...verdictLines(turn.verdicts, "  "));
    }
    if (record.final.length) {
        lines.push("", "── final", ...verdictLines(record.final, "  "));
    }
    const cost = (record.systemUsage.costUsd ?? 0) + (record.harnessUsage.costUsd ?? 0);
    lines.push(
        "",
        `tokens in ${record.systemUsage.inputTokens}, out ${record.systemUsage.outputTokens}; cost $${cost.toFixed(4)}`
    );
    return `${lines.join("\n")}\n`;
}
