// Copied from /Users/Martin/Tresors/Projects/Kalendora/src/eval-engine/plan.ts at 2026-11-12T06:18:59+01:00 at commit hash 2b9937db296fcb22d402376689d926a71fe9f165
/**
 * Which conversations a run consists of: cells (scenario × model × variant), conversation keys, their order, and the
 * plan hash that `--resume` requires to be equal. Pure.
 */
import type { CellRef } from "./conversation";
import { canonicalJson, EvalConfigError, type MatrixDoc, type Scenario, sha256 } from "./document";

/** What the CLI or a library caller asks for, after the scenarios were selected. */
export interface RunRequest {
    scenarios: Scenario[];
    models: string[];
    variants: string[];
    repeats: number;
    /** The default threshold of a cell; a scenario's own `passRate` wins. */
    passRate: number;
    maxErrorRate: number;
}

export interface PlannedCell extends CellRef {
    threshold: number;
}

export interface PlannedConversation {
    key: string;
    cell: CellRef;
    repeat: number;
}

export interface RunPlan {
    cells: PlannedCell[];
    /** In the order they start: repeat 1 of every cell, then repeat 2 of every cell, and so on. */
    conversations: PlannedConversation[];
    repeats: number;
    maxErrorRate: number;
    /** sha256 over the cells (with scenario hashes and thresholds), the repeats and `maxErrorRate`. */
    hash: string;
}

export const DefaultPassRate = 1;
export const DefaultMaxErrorRate = 0.1;

/** A name as it may stand in a file name. */
export function slug(name: string): string {
    return name.replace(/[^A-Za-z0-9._-]+/g, "-");
}

function conversationKey(cell: Pick<CellRef, "scenario" | "model" | "variant">, repeat: number): string {
    return `${cell.scenario}~${slug(cell.model)}~${slug(cell.variant)}~r${repeat}`;
}

/** The identity of a cell across runs: scenario id, model and variant. */
export function cellKey(cell: Pick<CellRef, "scenario" | "model" | "variant">): string {
    return JSON.stringify([cell.scenario, cell.model, cell.variant]);
}

export function planRun(request: RunRequest): RunPlan {
    if (!request.scenarios.length) {
        throw new EvalConfigError("bad-option", "no scenario to run");
    }
    if (!request.models.length) {
        throw new EvalConfigError("bad-option", "no model to run on; pass --model or --matrix");
    }
    if (!request.variants.length) {
        throw new EvalConfigError("bad-option", "no prompt variant to run");
    }
    if (!Number.isInteger(request.repeats) || request.repeats < 1) {
        throw new EvalConfigError("bad-option", "repeats must be a whole number of at least 1");
    }
    const ids = new Set<string>();
    for (const scenario of request.scenarios) {
        if (ids.has(scenario.doc.id)) {
            throw new EvalConfigError("bad-option", `scenario "${scenario.doc.id}" is in the run twice`);
        }
        ids.add(scenario.doc.id);
    }
    const cells: PlannedCell[] = [];
    for (const scenario of request.scenarios) {
        for (const model of unique(request.models)) {
            for (const variant of unique(request.variants)) {
                cells.push({
                    scenario: scenario.doc.id,
                    scenarioHash: scenario.hash,
                    model,
                    variant,
                    threshold: scenario.doc.passRate ?? request.passRate,
                });
            }
        }
    }
    const conversations: PlannedConversation[] = [];
    const keys = new Set<string>();
    for (let repeat = 1; repeat <= request.repeats; repeat++) {
        for (const cell of cells) {
            const key = conversationKey(cell, repeat);
            if (keys.has(key)) {
                throw new EvalConfigError(
                    "bad-option",
                    `two cells give the same file name "${key}"; rename a model or a variant`
                );
            }
            keys.add(key);
            conversations.push({
                key,
                cell: {
                    scenario: cell.scenario,
                    scenarioHash: cell.scenarioHash,
                    model: cell.model,
                    variant: cell.variant,
                },
                repeat,
            });
        }
    }
    const hash = sha256(canonicalJson({ cells, repeats: request.repeats, maxErrorRate: request.maxErrorRate }), 16);
    return { cells, conversations, repeats: request.repeats, maxErrorRate: request.maxErrorRate, hash };
}

function unique(values: readonly string[]): string[] {
    return [...new Set(values)];
}

/** The scenarios a matrix names: "all", a list of ids, or every scenario with at least one of the tags. */
export function selectScenarios(selection: MatrixDoc["scenarios"], all: readonly Scenario[]): Scenario[] {
    if (selection === "all") {
        return [...all];
    }
    if (Array.isArray(selection)) {
        return selectByIds(selection, all);
    }
    const tags = new Set(selection.tags);
    return all.filter((scenario) => scenario.doc.tags.some((tag) => tags.has(tag)));
}

export function selectByIds(ids: readonly string[], all: readonly Scenario[]): Scenario[] {
    const byId = new Map(all.map((scenario) => [scenario.doc.id, scenario]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) {
        throw new EvalConfigError(
            "unknown-scenario",
            `unknown scenario ${missing.map((id) => `"${id}"`).join(", ")}; known: ${[...byId.keys()].join(", ")}`
        );
    }
    return ids.flatMap((id) => {
        const scenario = byId.get(id);
        return scenario ? [scenario] : [];
    });
}
