/**
 * Pure display helpers for `tools timer`.
 *
 * These live outside index.ts so timer.test.ts can import them without
 * evaluating the entrypoint. index.ts runs the CLI at module top level, so an
 * import used to launch it — the shape that stopped the whole suite finishing
 * (see scripts/ci/entrypoint-import-guard.ts).
 */

export function generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function formatCountdown(remainingMs: number): string {
    if (remainingMs <= 0) {
        return "00:00";
    }

    const totalSeconds = Math.ceil(remainingMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
        return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }

    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
