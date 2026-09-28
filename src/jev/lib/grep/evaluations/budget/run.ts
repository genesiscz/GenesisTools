#!/usr/bin/env bun
/**
 * Measure the budgeted search on questions with known answers.
 *
 *   bun src/jev/lib/grep/evaluations/budget/run.ts                 # every case at the default budget
 *   bun src/jev/lib/grep/evaluations/budget/run.ts --budget 60 --case port-listen
 *
 * Spends real money: each case is capped at 1.3 x the budget in calls and at `--max-usd` dollars.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createEvaluator } from "@genesiscz/utils/ai/evaluation/service";
import { formatCost } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable } from "@genesiscz/utils/table";
import { GREP_TYPESAFE_MODEL } from "../../evaluator";
import { packetOrder } from "../../render";
import { DEFAULT_GREP_BUDGET, searchRepository } from "../../search";
import type { RetrievalResult } from "../../types";
import { GOLD_CASES, type GoldCase } from "./cases";

const REPO_ROOT = resolve(import.meta.dir, "../../../../../..");
const RESULTS = join(import.meta.dir, "results");
const USAGE_LABEL = "grep eval budget";
const HIT_RANK = 5;

export interface GoldScore {
    path: string;
    /** 1-based position in the packet's file list; null when the file was not returned. */
    rank: number | null;
    withSource: boolean;
}

export function scoreGold(result: RetrievalResult, gold: string[]): { gold: GoldScore[]; hit: boolean } {
    const order = packetOrder(result.files);
    const scores = gold.map((path) => {
        const index = order.findIndex((file) => file.path === path);
        const file = order[index];
        return {
            path,
            rank: index === -1 ? null : index + 1,
            withSource: Boolean(file && (file.presentationExcerpts ?? file.excerpts).length),
        };
    });
    return {
        gold: scores,
        hit: scores.some((score) => score.withSource && score.rank !== null && score.rank <= HIT_RANK),
    };
}

async function runCase(testCase: GoldCase, budget: number, maxCostUsd: number, concurrency?: number) {
    const controller = new AbortController();
    const evaluate = await createEvaluator({
        provider: "typesafe",
        signal: controller.signal,
        model: GREP_TYPESAFE_MODEL,
        usageLabel: USAGE_LABEL,
    });
    const started = performance.now();
    const result = await searchRepository({
        options: {
            query: testCase.query,
            root: join(REPO_ROOT, testCase.root),
            policy: {},
            noCache: true,
            maxSourceBytes: 0,
            budget,
            limits: { maxCostUsd },
            ...(concurrency ? { concurrency } : {}),
        },
        provider: "typesafe",
        signal: controller.signal,
        evaluate,
    });
    const wallMs = Math.round(performance.now() - started);
    const order = packetOrder(result.files);
    return {
        id: testCase.id,
        query: testCase.query,
        budget,
        status: result.status,
        wallMs,
        requests: result.counts.requests,
        inputTokens: result.counts.inputTokens ?? 0,
        costUsd: result.counts.costUsd ?? 0,
        files: result.files.length,
        withSource: result.files.filter((file) => (file.presentationExcerpts ?? file.excerpts).length).length,
        top: order.slice(0, 8).map((file) => file.path),
        warnings: result.warnings ?? [],
        issues: result.issues,
        ...scoreGold(result, testCase.gold),
    };
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: {
            case: { type: "string" },
            budget: { type: "string" },
            "max-usd": { type: "string" },
            concurrency: { type: "string" },
            "no-write": { type: "boolean" },
        },
    });
    const budget = Number(values.budget ?? DEFAULT_GREP_BUDGET);
    const maxCostUsd = Number(values["max-usd"] ?? 0.1);
    const cases = values.case ? GOLD_CASES.filter((testCase) => testCase.id === values.case) : GOLD_CASES;
    if (!cases.length) {
        throw new Error(
            `Unknown case "${values.case}". Known: ${GOLD_CASES.map((testCase) => testCase.id).join(", ")}`
        );
    }

    const reports = [];
    const table = createBoxTable(["CASE", "STATUS", "WALL", "CALLS", "COST", "FILES", "SRC", "GOLD RANK", "HIT@5"]);
    for (const testCase of cases) {
        const report = await runCase(
            testCase,
            budget,
            maxCostUsd,
            values.concurrency ? Number(values.concurrency) : undefined
        );
        reports.push(report);
        table.push([
            report.id,
            report.status,
            `${(report.wallMs / 1000).toFixed(1)} s`,
            String(report.requests),
            formatCost(report.costUsd),
            String(report.files),
            String(report.withSource),
            report.gold.map((gold) => `${gold.rank ?? "-"}${gold.withSource ? "" : "*"}`).join(" "),
            report.hit ? "yes" : "no",
        ]);
    }

    out.println(table.toString());
    out.println(
        `budget ${budget}; * = returned without source; hits ${reports.filter((report) => report.hit).length}/${reports.length}`
    );
    if (!values["no-write"]) {
        mkdirSync(RESULTS, { recursive: true });
        const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
        const file = join(RESULTS, `${stamp}-budget${budget}.json`);
        writeFileSync(file, `${SafeJSON.stringify(reports, null, 2)}\n`);
        out.println(`written ${file}`);
    }
}

if (import.meta.main) {
    await main();
}
