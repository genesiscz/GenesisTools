// src/automate/lib/steps/helpers.ts

import type { StepResult } from "@app/automate/lib/types";

/**
 * Build a StepResult with timing. Used by all step handlers.
 *
 * @param status - "success" or "error" (matching the base StepResult)
 * @param output - Step output data
 * @param startMs - performance.now() timestamp from step start
 * @param error - Optional error message
 */
export function makeResult(
    status: "success" | "error" | "skipped",
    output: unknown,
    startMs: number,
    error?: string
): StepResult {
    return {
        status,
        output,
        duration: performance.now() - startMs,
        error,
    };
}
