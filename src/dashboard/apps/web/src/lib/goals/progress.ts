import type { GoalKeyResult } from "@/drizzle";

function clamp01(value: number): number {
    if (Number.isNaN(value) || value < 0) {
        return 0;
    }

    if (value > 1) {
        return 1;
    }

    return value;
}

/** Fraction (0-1) a single key result has achieved toward its target. */
export function keyResultFraction(kr: Pick<GoalKeyResult, "currentValue" | "targetValue">): number {
    if (kr.targetValue === 0) {
        return kr.currentValue > 0 ? 1 : 0;
    }

    return clamp01(kr.currentValue / kr.targetValue);
}

/**
 * Derived goal progress (0-100). When key results exist it is the average of
 * each KR's currentValue/targetValue; otherwise it falls back to the goal's
 * manual `progress` field.
 */
export function deriveProgress(manualProgress: number, krs: Pick<GoalKeyResult, "currentValue" | "targetValue">[]): number {
    if (krs.length === 0) {
        return Math.max(0, Math.min(100, manualProgress));
    }

    const sum = krs.reduce((acc, kr) => acc + keyResultFraction(kr), 0);
    return Math.round((sum / krs.length) * 100);
}
