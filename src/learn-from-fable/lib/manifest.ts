/**
 * Stage-run audit trail. Every stage invocation — deterministic or model-backed —
 * appends one record to $PACK/meta/stage-runs.jsonl so it is always answerable
 * what ran, with which model and params, on which inputs, producing which
 * outputs, and (on failure) the full error + stack + inputs/outputs for debugging.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { FableConfig } from "./config";
import { ensureMetaDirs } from "./config";
import { withStageTags } from "./stage-context";

export interface StageRunError {
    message: string;
    stack?: string;
    inputs?: unknown;
    outputs?: unknown;
}

export interface StageRunRecord {
    id: string;
    stage: string;
    startedAt: string;
    finishedAt?: string;
    status: "ok" | "error";
    /** model(s) used, when the stage called any */
    model?: string | string[];
    params?: Record<string, unknown>;
    inputs?: unknown;
    outputs?: unknown;
    error?: StageRunError;
}

export function newRunId(stage: string): string {
    const rand = Math.random().toString(36).slice(2, 8);
    return `${stage}-${new Date().toISOString().replace(/[:.]/g, "-")}-${rand}`;
}

export function appendStageRun(config: FableConfig, record: StageRunRecord): void {
    const paths = ensureMetaDirs(config);
    appendFileSync(paths.stageRunsPath, `${SafeJSON.stringify(record, { strict: true })}\n`);
    logger.info({ id: record.id, stage: record.stage, status: record.status }, "stage run recorded");
}

export function readStageRuns(config: FableConfig): StageRunRecord[] {
    const paths = ensureMetaDirs(config);
    if (!existsSync(paths.stageRunsPath)) {
        return [];
    }

    const out: StageRunRecord[] = [];
    for (const line of readFileSync(paths.stageRunsPath, "utf-8").split("\n")) {
        if (!line.trim()) {
            continue;
        }

        try {
            const record: StageRunRecord = SafeJSON.parse(line, { strict: true });
            out.push(record);
        } catch (err) {
            logger.debug({ error: err }, "bad stage-runs.jsonl line skipped");
        }
    }

    return out;
}

/**
 * Run a stage body with audit capture. The record is appended on BOTH success
 * and failure; failures carry message + stack + the inputs and any partial
 * outputs the stage attached via `setOutputs`.
 */
export async function runStage<T>(
    config: FableConfig,
    meta: { stage: string; model?: string | string[]; params?: Record<string, unknown>; inputs?: unknown },
    body: (ctx: { runId: string; setOutputs: (outputs: unknown) => void }) => Promise<T>
): Promise<T> {
    const runId = newRunId(meta.stage);
    const startedAt = new Date().toISOString();
    let outputs: unknown;

    try {
        // Every model call inside the stage body inherits these tags, so proxy
        // transcripts for this run land in one directory keyed by the run id.
        const result = await withStageTags({ session: runId, stage: meta.stage }, () =>
            body({ runId, setOutputs: (o) => (outputs = o) })
        );
        appendStageRun(config, {
            id: runId,
            stage: meta.stage,
            startedAt,
            finishedAt: new Date().toISOString(),
            status: "ok",
            model: meta.model,
            params: meta.params,
            inputs: meta.inputs,
            outputs,
        });
        return result;
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        appendStageRun(config, {
            id: runId,
            stage: meta.stage,
            startedAt,
            finishedAt: new Date().toISOString(),
            status: "error",
            model: meta.model,
            params: meta.params,
            inputs: meta.inputs,
            outputs,
            // inputs/outputs already sit at the top level of this record.
            error: { message: error.message, stack: error.stack },
        });
        logger.error({ id: runId, stage: meta.stage, error }, "stage run failed");
        throw error;
    }
}
