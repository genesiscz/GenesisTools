import type { StepResult } from "./types";
import { getDb, type AutomateDatabase } from "./db";

export interface RunLogger {
  runId: number;
  logStep(stepIndex: number, stepId: string, stepName: string, action: string, result: StepResult): void;
  finishRun(success: boolean, stepCount: number, totalDuration: number, error?: string): void;
}

export function createRunLogger(
  presetName: string,
  scheduleId: number | null,
  triggerType: "manual" | "schedule",
  db?: AutomateDatabase,
): RunLogger {
  const database = db ?? getDb();
  const runId = database.startRun(presetName, scheduleId, triggerType);

  return {
    runId,

    logStep(stepIndex, stepId, stepName, action, result) {
      const output = result.output != null
        ? (typeof result.output === "string" ? result.output : JSON.stringify(result.output))
        : null;
      database.logStep(runId, stepIndex, stepId, stepName, action, result.status, output, result.duration, result.error ?? null);
    },

    finishRun(success, stepCount, totalDuration, error) {
      database.finishRun(runId, success ? "success" : "error", stepCount, totalDuration, error);
    },
  };
}
