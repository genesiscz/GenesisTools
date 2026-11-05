import { type CaptureResult, MAX_CAPTURE_SECONDS } from "@genesiscz/utils/screen-recorder/types";

/** Refuses a benchmark plan before it creates any output or starts the scene. */
export function validateBenchmark(runs: number, seconds: number, only?: string): void {
    if (!Number.isInteger(runs) || runs < 1) {
        throw new Error("--runs must be a positive integer");
    }

    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_CAPTURE_SECONDS) {
        throw new Error(`--seconds must be greater than zero and at most ${MAX_CAPTURE_SECONDS}`);
    }

    if (only !== undefined && only !== "native" && only !== "peekaboo") {
        throw new Error("--only must be native or peekaboo");
    }
}

/** A capture that returned but ended early is a benchmark error, not a clean run. */
export function captureDiagnostics(result: CaptureResult): string[] {
    return result.endedEarly ? [`capture ended early: ${result.endedEarly}`] : [];
}
