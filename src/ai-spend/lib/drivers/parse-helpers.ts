/**
 * Shared JSONL-parsing primitives for the agent drivers. Each driver had its own
 * identical copy, which is one place for the two to drift the moment one of them
 * is hardened.
 */

/** A missing, NaN or Infinite token count is 0, never a value that poisons the arithmetic. */
export function num(value: number | undefined): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}
