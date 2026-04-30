import { SafeJSON } from "@app/utils/json";
import { type AutomateDatabase, getDb } from "./db";
import type { StepResult } from "./types";

export interface RunLogger {
    runId: number;
    logStep(stepIndex: number, stepId: string, stepName: string, action: string, result: StepResult): Promise<void>;
    finishRun(success: boolean, stepCount: number, totalDuration: number, error?: string): Promise<void>;
}

export async function createRunLogger(
    presetName: string,
    scheduleId: number | null,
    triggerType: "manual" | "schedule",
    db?: AutomateDatabase
): Promise<RunLogger> {
    const database = db ?? getDb();
    const runId = await database.startRun(presetName, scheduleId, triggerType);

    return {
        runId,

        async logStep(stepIndex, stepId, stepName, action, result) {
            const output =
                result.output != null
                    ? typeof result.output === "string"
                        ? result.output
                        : SafeJSON.stringify(result.output)
                    : null;

            await database.logStep(
                runId,
                stepIndex,
                stepId,
                stepName,
                action,
                result.status,
                output,
                result.duration,
                result.error ?? null
            );
        },

        async finishRun(success, stepCount, totalDuration, error) {
            await database.finishRun(runId, success ? "success" : "error", stepCount, totalDuration, error);
        },
    };
}
