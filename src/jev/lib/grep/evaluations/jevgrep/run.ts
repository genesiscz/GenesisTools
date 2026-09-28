#!/usr/bin/env bun
/**
 * Compare `tools jev grep` with upstream `jg` on the same questions, the same key and the same budget.
 *
 *   bun src/jev/lib/grep/evaluations/jevgrep/run.ts --case tools-control
 *   bun src/jev/lib/grep/evaluations/jevgrep/run.ts --case all --concurrency 32
 *   bun src/jev/lib/grep/evaluations/jevgrep/run.ts --query "Where is X?" --root src --max-requests 50
 *
 * Spends real money: every case has a request cap and a dollar cap per implementation. See README.md.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { formatCost } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable } from "@genesiscz/utils/table";
import { positiveCap, requestCap, writeResult } from "../args";
import { COMPARISON_CASES, type ComparisonCase } from "./cases";
import { type RunReport, runComparison } from "./compare";

const REPO_ROOT = resolve(import.meta.dir, "../../../../../..");
const RESULTS = join(import.meta.dir, "results");

function selectedCases(values: {
    case?: string;
    query?: string;
    root?: string;
    "max-requests"?: string;
    "max-usd"?: string;
}): ComparisonCase[] {
    if (values.query) {
        return [
            {
                id: "ad-hoc",
                query: values.query,
                root: values.root ?? ".",
                maxRequests: requestCap("--max-requests", values["max-requests"], 200),
                maxCostUsd: positiveCap("--max-usd", values["max-usd"], 0.1),
            },
        ];
    }

    const chosen =
        !values.case || values.case === "all"
            ? COMPARISON_CASES
            : COMPARISON_CASES.filter((testCase) => testCase.id === values.case);
    if (!chosen.length) {
        throw new Error(
            `Unknown case "${values.case}". Known: ${COMPARISON_CASES.map((testCase) => testCase.id).join(", ")}`
        );
    }

    // Upstream's evaluator takes the request cap as given, so an infinite cap must stop here.
    return chosen.map((testCase) => ({
        ...testCase,
        maxRequests: requestCap("--max-requests", values["max-requests"], testCase.maxRequests),
        maxCostUsd: positiveCap("--max-usd", values["max-usd"], testCase.maxCostUsd),
    }));
}

function row(report: RunReport): string[] {
    return [
        report.implementation,
        report.status,
        `${(report.wallMs / 1000).toFixed(1)} s`,
        String(report.requests),
        String(report.inputTokens),
        formatCost(report.costUsd),
        String(report.files.length),
        report.issues.map((issue) => `${issue.kind}:${issue.count}`).join(" ") || "-",
    ];
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: {
            case: { type: "string" },
            query: { type: "string" },
            root: { type: "string" },
            upstream: { type: "string" },
            concurrency: { type: "string" },
            "max-requests": { type: "string" },
            "max-usd": { type: "string" },
            "no-write": { type: "boolean" },
        },
    });
    const checkout = resolve(values.upstream ?? join(REPO_ROOT, "..", "_Playgrounds", "jevgrep"));
    if (!existsSync(join(checkout, "packages/core/node_modules"))) {
        throw new Error(
            `No installed upstream at ${checkout}. Clone dzhng/jevgrep there and run: bun install --ignore-scripts`
        );
    }

    const concurrency = Number(values.concurrency ?? 1);
    for (const testCase of selectedCases(values)) {
        const report = await runComparison({ testCase, repoRoot: REPO_ROOT, concurrency, checkout });
        const table = createBoxTable(["IMPL", "STATUS", "WALL", "CALLS", "INPUT TOK", "COST", "FILES", "ISSUES"]);
        table.push(row(report.upstream), row(report.port));
        out.println(`\n${testCase.id}: "${testCase.query}" (root ${testCase.root}, concurrency ${concurrency})`);
        out.println(table.toString());
        const { comparison } = report;
        out.println(
            [
                `same status ${comparison.sameStatus}, same files ${comparison.sameFiles} (jaccard ${comparison.jaccard}), same ranking ${comparison.sameRanking}, same packet body ${comparison.sameBody}`,
                `max score delta ${comparison.maxScoreDelta}; role mismatches ${comparison.roleMismatches.length}; excerpt mismatches ${comparison.excerptMismatches.length}`,
                `port vs upstream: calls ${comparison.requestsDeltaPct}%, cost ${comparison.costDeltaPct}%, wall ${comparison.wallDeltaPct}%`,
                ...(comparison.onlyUpstream.length ? [`only upstream: ${comparison.onlyUpstream.join(", ")}`] : []),
                ...(comparison.onlyPort.length ? [`only port: ${comparison.onlyPort.join(", ")}`] : []),
            ].join("\n")
        );
        if (!values["no-write"]) {
            out.println(`written ${writeResult(RESULTS, `${testCase.id}-c${concurrency}`, report)}`);
        }
    }
}

if (import.meta.main) {
    await main();
}
