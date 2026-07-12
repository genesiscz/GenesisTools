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

/** Fraction (0-1) a single key result has achieved toward its target, relative to its start value. */
export function keyResultFraction(kr: Pick<GoalKeyResult, "startValue" | "currentValue" | "targetValue">): number {
    if (kr.targetValue === kr.startValue) {
        return kr.currentValue >= kr.targetValue ? 1 : 0;
    }

    return clamp01((kr.currentValue - kr.startValue) / (kr.targetValue - kr.startValue));
}

/**
 * Derived goal progress (0-100). When key results exist it is the average of
 * each KR's progress relative to its start/target range; otherwise it falls
 * back to the goal's manual `progress` field.
 */
export function deriveProgress(
    manualProgress: number,
    krs: Pick<GoalKeyResult, "startValue" | "currentValue" | "targetValue">[]
): number {
    if (krs.length === 0) {
        return Math.max(0, Math.min(100, manualProgress));
    }

    const sum = krs.reduce((acc, kr) => acc + keyResultFraction(kr), 0);
    return Math.round((sum / krs.length) * 100);
}
